import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { loadConfig, ensureDirs } from './config.js';
import { initLogger, getLogger } from './logger.js';
import { initStore, taskLogsStore, configStore, sessionsStore, syncInterfacesFromPrompts } from './store.js';
import { nowReadable } from './time.js';
import { initTaskQueue } from './services/task-queue.js';
import { createProcessRouter } from './routes/process.js';
import { createHealthRouter } from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter, authWebMiddleware, apiTokenMiddleware } from './routes/auth.js';
import { rescanPromptsDir } from './services/prompt-engine.js';

const log = getLogger();

// ═══════════════════════════════════════════════════════════
// 全局兜底——单个请求失败，不应导致进程崩溃
// ═══════════════════════════════════════════════════════════
process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason, promise: String(promise) }, 'unhandled_rejection');
  // 记录后不退出——让 Node 保持运行，仅影响本次请求
});

process.on('uncaughtException', (err) => {
  log.error({ err: String(err), stack: err.stack }, 'uncaught_exception');
  // uncaughtException 之后进程状态不确定，但它发生在
  // Express 的 try/catch 之外时至少可以记录日志再退出
  process.exit(1);
});

log.info('==== AI 数字员工 starting ====');

const cfg = loadConfig();
log.info('config_loaded');

ensureDirs(cfg);
log.info({ data_dir: cfg.sys.data_dir }, 'data_dirs_ready');

// 初始化正式 logger（此后 log 代理自动指向新实例）
initLogger(cfg.sys.data_dir, cfg.server.debug);

// ---- 打印完整配置（敏感字段脱敏） ----
function mask(s: string): string {
  if (!s) return '(empty)';
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

log.info({
  server: cfg.server,
  sys: cfg.sys,
  llm: {
    ...cfg.llm,
    auth_token: mask(cfg.llm.auth_token),
  },
}, 'config_loaded');

// 初始化存储
initStore(cfg.sys.data_dir);
log.info('store_ready');

// 迁移：将旧版明文 api_auth_token 哈希化（一次性）
(function migrateApiTokenToHash() {
  const raw = configStore.get('api_auth_token');
  if (!raw) return;
  // 已经是十六进制 64 位（SHA-256 哈希）则跳过
  if (/^[a-f0-9]{64}$/.test(raw)) return;
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  configStore.set('api_auth_token', hash, '对外 API 认证 Token（SHA-256 哈希）');
  log.info({}, 'api_token_migrated_to_hash');
})();

// 扫描 prompts/ 目录，同步 agent_interfaces 到 DB
const promptFiles = rescanPromptsDir();
syncInterfacesFromPrompts(promptFiles.map(pf => ({ filename: pf.filename, path: pf.path, name: pf.name })));
log.info({ count: promptFiles.length, paths: promptFiles.map(pf => pf.path) }, 'interfaces_synced_from_prompts');

// 初始化任务队列
initTaskQueue(cfg);
log.info('task_queue_ready');

// Express
const app = express();

// 信任反向代理头（X-Forwarded-For），使 req.ip 能取到真实客户端 IP。
// 直连/端口映射场景下无此头时，req.ip 退化为 socket 对端地址。
app.set('trust proxy', true);

// 在 JSON 解析前捕获原始请求体（verify 回调在 express.json 内部拿到 raw buffer）
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf.toString('utf8');
  },
}));
app.use(cookieParser());
log.info('express_routes_registering');

// ============================================================
// 公开路由（无需认证）
// ============================================================
app.use(createHealthRouter());

// 认证 API（登录/登出/改密）
app.use(createAuthRouter());

// 登录页面
app.get('/login', (_req, res) => {
  res.sendFile('login.html', { root: 'web' });
});

// 公开系统信息（登录页用，无需认证）
app.get('/api/info', (_req, res) => {
  const name = configStore.get('sys.name') || 'AI 数字员工';
  res.json({ code: 0, data: { sys_name: name } });
});

// 静态资源（公开，登录页也需要）
app.use('/static', express.static('web/static'));

// 对外业务访问路径（外部系统调用，Bearer Token 鉴权）
app.use('/api/v1', apiTokenMiddleware());
app.use(createProcessRouter(cfg));

// 任务管理 API（外部系统调用）
app.use(createTasksRouter());

// JSON 解析失败等中间件错误 → 先记录原始请求，再返回 400
app.use((err: any, req: any, res: any, _next: any) => {
  log.debug({
    method: req.method,
    url: req.originalUrl,
    rawBody: req.rawBody ?? '(无原始请求体)',
    error: err?.message ?? String(err),
  }, 'request_body_parse_error');
  res.status(400).json({ code: 1001, timestamp: nowReadable(), message: '请求体不是合法 JSON' });
});

// Dev null — 用于调试接收请求
app.post('/api/dev/null', (req, res) => {
  log.info({ body: req.body }, 'dev_null_received');
  res.json({ status: 'ok' });
});

// ============================================================
// 以下需要登录（Web Cookie 认证）
// ============================================================
app.use(authWebMiddleware);

// 管理后台 API
app.use(createAdminRouter(cfg));

// 管理后台 Web 页面
app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile('admin.html', { root: 'web' });
});

// 根路径重定向到管理后台
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// 启动 — 始终 HTTPS（证书由 build.sh 自动生成，容器内为 /app/deploy/certs/，本地开发为项目根 deploy/certs/）
const port = cfg.server.port;
const CERT_FILE = resolve(process.cwd(), 'deploy/certs/cert.pem');
const KEY_FILE = resolve(process.cwd(), 'deploy/certs/key.pem');

log.info({ port, certFile: CERT_FILE }, 'binding_port');

// ---- 定期清理过期任务数据 ----
async function cleanupExpiredTasks() {
  const retentionDays = cfg.sys.retention_days;
  try {
    const deleted = taskLogsStore.deleteExpired(retentionDays);

    // 清理过期 session（超过 retentionDays 未见新提交）
    const expiredSessions = sessionsStore.deleteExpired(retentionDays);
    if (expiredSessions.length > 0) {
      log.info({ expiredCount: expiredSessions.length, retentionDays }, 'session_cleanup_start');
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
      for (const s of expiredSessions) {
        try {
          await deleteSession(s.session_id);
        } catch (err) {
          log.warn({ sessionId: s.session_id, error: String(err) }, 'session_delete_sdk_error');
        }
      }
    }

    // 清理过期 session 对应的磁盘工作目录
    const tasksDir = join(cfg.sys.runtime_dir, 'tasks');
    if (existsSync(tasksDir)) {
      const { getDb } = await import('./store.js');
      const activeSessions = getDb().prepare('SELECT linkid FROM sessions').all() as Array<{ linkid: string }>;
      const activeSet = new Set(activeSessions.map(r => r.linkid.replace(/[/\\:*?"<>|]/g, '_')));
      for (const dir of readdirSync(tasksDir)) {
        if (!activeSet.has(dir)) {
          rmSync(join(tasksDir, dir), { recursive: true, force: true });
        }
      }
    }
    log.info({ retentionDays, deletedRows: deleted, expiredSessions: expiredSessions.length }, 'cleanup_done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'cleanup_error');
  }
}

// 启动时立即清理一次，之后每日清理一次
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(cleanupExpiredTasks, 10 * 1000);
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS);
log.info({ retentionDays: cfg.sys.retention_days, intervalMs: CLEANUP_INTERVAL_MS }, 'cleanup_scheduled');

if (!existsSync(CERT_FILE) || !existsSync(KEY_FILE)) {
  log.error({ certFile: CERT_FILE, keyFile: KEY_FILE }, 'https_cert_missing');
  console.error('[startup] HTTPS 证书缺失，无法启动。请使用 build/build.sh 构建镜像（会自动生成并打入证书）。');
  process.exit(1);
}

const httpsOpts = {
  cert: readFileSync(CERT_FILE),
  key: readFileSync(KEY_FILE),
};
createHttpsServer(httpsOpts, app).listen(port, () => {
  log.info({ port, url: 'https://localhost:' + port }, 'server_started_https');
});