/**
 * Runner 入口 — 无状态 SDK 执行节点
 *
 * 只暴露内网接口，供控制面派发任务：
 *   POST /run              长连接，NDJSON 回传 SDK 消息流 + 结果
 *   POST /cancel           取消某个任务
 *   GET  /status           心跳/容量上报
 *   GET  /session/:sid/*   会话读取 / 文件浏览 / 下载 / 删除（代理给控制面）
 *
 * 不读 SQLite、不读 prompts/、不读 prompt_config、不读 secrets.key；
 * 所有执行所需输入由控制面在 RunRequest 里一次性下发。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { resolve, join } from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { getLogger } from '../logger.js';
import { initLogger } from '../logger.js';
import { runnerExecute, runnerCancelTask, runnerRunningCount, runnerCancelByLinkid } from '../services/runner-executor.js';
import { mkdir } from 'node:fs/promises';
import { existsSync as exists, readdirSync, statSync, lstatSync, createReadStream, rmSync } from 'node:fs';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { sanitizeDirName } from '../services/sdk-core.js';
import { nowReadable } from '../time.js';
import type { RunRequest, RunnerStatusInfo } from '../types.js';

const log = getLogger();

// ── 运行时配置（环境变量，无 cfg.yml / SQLite） ──
const RUNTIME_DIR = process.env.RUNTIME_DIR || resolve(process.cwd(), 'runtime');
const PORT = parseInt(process.env.RUNNER_PORT || '20002', 10);
const CAPACITY = parseInt(process.env.RUNNER_MAX_CONCURRENT || '5', 10);
const TIMEOUT_MS = parseInt(process.env.RUNNER_TIMEOUT_MS || '600000', 10);
const GRACE_MS = parseInt(process.env.RUNNER_GRACE_MS || '60000', 10);
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const USE_HTTPS = process.env.RUNNER_USE_HTTPS !== '0';

const startedAt = Date.now();

// 确保目录存在
mkdir(join(RUNTIME_DIR, 'tasks'), { recursive: true }).catch(() => {});
mkdir(join(RUNTIME_DIR, 'claude-config'), { recursive: true }).catch(() => {});
process.env.CLAUDE_CONFIG_DIR = join(RUNTIME_DIR, 'claude-config');

// ── 认证中间件 ──
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function authRunner(req: Request, res: Response, next: () => void): void {
  if (!RUNNER_TOKEN) {
    // 未配置 token 时不鉴权（开发环境）
    next();
    return;
  }
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'missing token' });
    return;
  }
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hashToken(RUNNER_TOKEN), 'hex');
  let ok = false;
  try { ok = timingSafeEqual(a, b); } catch { ok = false; }
  if (!ok) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  next();
}

// ── 会话读取 / 文件浏览（与 admin.ts 逻辑一致，仅换 runtime_dir） ──
function sessionWorkDir(linkid: string): string {
  return join(RUNTIME_DIR, 'tasks', sanitizeDirName(linkid));
}

// 控制面已从 sessions 表拿到 linkid，这里再按 linkid 定位 workdir；
// 但 runner 侧无 sessions 表，接口按 linkid 组织（runner 内部按 linkid 唯一）。
function sessionDirFromReq(req: Request): string {
  const linkid = req.params.linkid as string;
  return sessionWorkDir(linkid);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// 健康检查（不鉴权，供容器探活）
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: nowReadable() });
});

// ── 以下需要 Bearer token ──
app.use(authRunner);

// 状态上报
app.get('/status', (_req: Request, res: Response) => {
  const info: RunnerStatusInfo = {
    capacity: CAPACITY,
    running_count: runnerRunningCount(),
    uptime_ms: Date.now() - startedAt,
  };
  res.json(info);
});

// 主派发接口（长连接）
app.post('/run', (req: Request, res: Response) => {
  const runReq = req.body as RunRequest;
  if (!runReq || !runReq.task_id || !runReq.linkid) {
    res.status(400).json({ error: '缺少 task_id 或 linkid' });
    return;
  }

  if (runnerRunningCount() >= CAPACITY) {
    log.warn({ taskId: runReq.task_id, linkid: runReq.linkid, capacity: CAPACITY }, 'runner_capacity_full');
    res.status(503).json({ error: 'runner 容量已满' });
    return;
  }

  log.info({ taskId: runReq.task_id, linkid: runReq.linkid, resume: runReq.resume_session_id || '(new)' }, 'runner_run_start');

  // 长连接：立即写头，之后逐帧 NDJSON
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  void runnerExecute(runReq, res, { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, capacity: CAPACITY });
});

// 取消任务
app.post('/cancel', (req: Request, res: Response) => {
  const { task_id } = req.body as { task_id?: string };
  if (!task_id) {
    res.status(400).json({ error: '缺少 task_id' });
    return;
  }
  const ok = runnerCancelTask(task_id);
  log.info({ task_id, ok }, 'runner_cancel_task');
  res.json({ ok });
});

// 会话消息（一次性拉取）—— runner 无 sessions 表，用 linkid 定位 workdir、query 传 session_id
app.get('/session/:linkid/messages', async (req: Request, res: Response) => {
  const workDir = sessionDirFromReq(req);
  const sessionId = (req.query.session_id as string) || req.params.linkid;
  try {
    const messages = await getSessionMessages(sessionId, { dir: workDir, includeSystemMessages: false });
    res.json({ code: 0, data: { session_id: sessionId, messages } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: 1001, message: '读取会话记录失败: ' + msg });
  }
});

// 会话文件列表
app.get('/session/:linkid/files', (req: Request, res: Response) => {
  const workDir = sessionDirFromReq(req);
  if (!exists(workDir)) {
    res.json({ code: 0, data: { workDir, files: [] } });
    return;
  }
  const entries: Array<{ path: string; size: number; isDir: boolean; modifiedAt: string }> = [];
  const walkDir = (dir: string, prefix: string) => {
    let items: string[];
    try { items = readdirSync(dir); } catch { return; }
    for (const name of items) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      const rel = prefix + name;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        entries.push({ path: rel + '/', size: 0, isDir: true, modifiedAt: st.mtime.toISOString() });
        walkDir(full, rel + '/');
      } else {
        entries.push({ path: rel, size: st.size, isDir: false, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  walkDir(workDir, '');
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.path.localeCompare(b.path)));
  res.json({ code: 0, data: { workDir, files: entries } });
});

// 文件内容预览
app.get('/session/:linkid/file-content', (req: Request, res: Response) => {
  const workDir = sessionDirFromReq(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    res.status(400).json({ code: 1001, message: '缺少 path 参数' });
    return;
  }
  const fullPath = join(workDir, relPath);
  if (!fullPath.startsWith(workDir + '/') && fullPath !== workDir) {
    res.status(403).json({ code: 1001, message: '路径非法' });
    return;
  }
  if (!exists(fullPath) || lstatSync(fullPath).isDirectory()) {
    res.status(404).json({ code: 1001, message: '文件不存在' });
    return;
  }
  const st = lstatSync(fullPath);
  if (st.size > 512 * 1024) {
    res.status(413).json({ code: 1001, message: '文件过大，请使用下载' });
    return;
  }
  try {
    const content = readFileSync(fullPath, 'utf8');
    res.json({ code: 0, data: { path: relPath, size: st.size, content } });
  } catch {
    res.status(415).json({ code: 1001, message: '无法读取为文本文件' });
  }
});

// 文件下载
app.get('/session/:linkid/file-download', (req: Request, res: Response) => {
  const workDir = sessionDirFromReq(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    res.status(400).json({ code: 1001, message: '缺少 path 参数' });
    return;
  }
  const fullPath = join(workDir, relPath);
  if (!fullPath.startsWith(workDir + '/') && fullPath !== workDir) {
    res.status(403).json({ code: 1001, message: '路径非法' });
    return;
  }
  if (!exists(fullPath) || lstatSync(fullPath).isDirectory()) {
    res.status(404).json({ code: 1001, message: '文件不存在' });
    return;
  }
  const basename = fullPath.split('/').pop() || 'download';
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(basename)}"`);
  const st = lstatSync(fullPath);
  res.setHeader('Content-Length', st.size);
  const readStream = createReadStream(fullPath);
  readStream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ code: 1001, message: '读取文件失败' });
  });
  readStream.pipe(res);
});

// 删除会话（取消该 linkid 任务 + 删 workdir）
app.delete('/session/:linkid', (req: Request, res: Response) => {
  const linkid = req.params.linkid as string;
  const aborted = runnerCancelByLinkid(linkid);
  const workDir = sessionWorkDir(linkid);
  if (exists(workDir)) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 删除失败不阻塞 */ }
  }
  log.info({ linkid, abortedTasks: aborted }, 'runner_session_deleted');
  res.json({ code: 0, message: '已删除', aborted });
});

// 启动
function startServer() {
  if (USE_HTTPS) {
    const CERT_FILE = resolve(process.cwd(), 'deploy/certs/cert.pem');
    const KEY_FILE = resolve(process.cwd(), 'deploy/certs/key.pem');
    if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
      const httpsServer: HttpsServer = createHttpsServer(
        { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) },
        app,
      );
      httpsServer.listen(PORT, () => {
        log.info({ port: PORT, protocol: 'https' }, 'runner_started');
      });
      return;
    }
    log.warn('runner_https_cert_missing_fallback_http');
  }
  const httpServer: HttpServer = createHttpServer(app);
  httpServer.listen(PORT, () => {
    log.info({ port: PORT, protocol: 'http' }, 'runner_started');
  });
}

// 初始化 logger（runner 无 data_dir，日志仅 stdout）
initLogger(join(RUNTIME_DIR, 'logs'), DEBUG, 7);
startServer();
