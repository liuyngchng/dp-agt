/**
 * Claude Code Agent SDK 调用封装
 *
 * - 工作目录：data/tasks/<sanitize(linkid)>/
 * - 支持 session 复用：通过 resume 参数恢复历史对话
 * - CLACDE.md 仅首次写入，resume 时不再覆盖（SDK snapshot 机制）
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger.js';
import { fmtLocalTs } from '../time.js';
import { publish } from './sse-bus.js';
import type { Config } from '../config.js';
import { promptConfigStore, sessionsStore } from '../store.js';
import { listMemories, getMemoryDir } from './memory-store.js';

const log = getLogger();

/** 从 prompts 目录加载模板文件，失败返回 null */
async function loadPromptFile(relativePath: string): Promise<string | null> {
  const candidates = [
    resolve(process.cwd(), 'prompts'),
    resolve(process.cwd(), 'dist', 'prompts'),
    'prompts',
  ];
  for (const dir of candidates) {
    const p = join(dir, relativePath);
    if (existsSync(p)) {
      try {
        return await readFile(p, 'utf8');
      } catch { /* try next */ }
    }
  }
  return null;
}

/** 从嵌套对象中按点号路径取值，如 "sys.doc_util_url" */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 加载 prompts 目录下的所有模板文件（含 sections/） */
async function loadAllPromptFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const candidates = [
    resolve(process.cwd(), 'prompts'),
    resolve(process.cwd(), 'dist', 'prompts'),
    'prompts',
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const walk = (base: string, prefix: string) => {
      if (!existsSync(base)) return;
      for (const entry of readdirSync(base)) {
        const full = join(base, entry);
        const rel = prefix + entry;
        if (statSync(full).isDirectory()) {
          walk(full, rel + '/');
        } else if (entry.endsWith('.md')) {
          try {
            files.set(rel, readFileSync(full, 'utf8'));
          } catch { /* skip */ }
        }
      }
    };
    walk(dir, '');
    break; // 找到第一个存在的目录即停止
  }
  return files;
}

/** 替换路径分隔符和危险字符，确保 mkdir 成功 */
function sanitizeDirName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_');
}

/** 将 tool_result 的 content（string 或 blocks 数组）转为纯文本 */
function toolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((c) => {
      if (c == null) return '';
      const o = c as Record<string, unknown>;
      return typeof o.text === 'string' ? o.text : JSON.stringify(o);
    }).join('');
  }
  return raw == null ? '' : JSON.stringify(raw);
}

/** prompt_config key → DP_ 前缀环境变量名：点→下划线，全大写 */
function keyToEnvName(key: string): string {
  return 'DP_' + key.replace(/\./g, '_').toUpperCase();
}

/** 根据 LLM 配置 + prompt_config 构建 Claude Code 子进程环境变量 */
export function buildEnv(cfg: Config): Record<string, string | undefined> {
  // SDK 的 env 会整体替换子进程环境（不自动合并 process.env），
  // 因此先继承父进程环境，再用 adapter 配置覆盖。
  const env: Record<string, string | undefined> = { ...process.env };
  const l = cfg.llm;

  // ── 网关地址（必填，config 层已强制校验） ──
  env.ANTHROPIC_BASE_URL = l.base_url;

  // 网关认证
  if (l.auth_token) {
    env.ANTHROPIC_AUTH_TOKEN = l.auth_token;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  // ── 模型映射 ──
  env.ANTHROPIC_MODEL = l.model || env.ANTHROPIC_MODEL;
  if (l.opus_model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = l.opus_model;
  if (l.sonnet_model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = l.sonnet_model;
  if (l.haiku_model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = l.haiku_model;
  if (l.subagent_model) env.CLAUDE_CODE_SUBAGENT_MODEL = l.subagent_model;
  if (l.effort_level) env.CLAUDE_CODE_EFFORT_LEVEL = l.effort_level;
  if (l.timeout_ms) env.API_TIMEOUT_MS = String(l.timeout_ms);

  // ═══════════════════════════════════════════════════════════════
  // 清理可能让 CLI 绕过网关的凭据
  // ═══════════════════════════════════════════════════════════════
  delete env.ANTHROPIC_API_KEY;

  // ═══════════════════════════════════════════════════════════════
  // 注入 prompt_config 中的所有 key-value 作为 DP_ 前缀环境变量
  // 同时保留特定兼容名称（向后兼容，不要删除）
  // ═══════════════════════════════════════════════════════════════
  const allConfigValues = promptConfigStore.getAllPlain();
  for (const [key, plain] of allConfigValues.entries()) {
    env[keyToEnvName(key)] = plain;
  }

  // 兼容旧名称：文件下载 Token
  const fileUrlToken = promptConfigStore.getPlain('doc.file_url_token')
    || promptConfigStore.getPlain('sys.file_url_token');
  if (fileUrlToken) {
    env.FILE_URL_TOKEN = fileUrlToken;
  } else {
    delete env.FILE_URL_TOKEN;
  }

  // 兼容旧名称：文档审核服务 Token
  const docAuditToken = promptConfigStore.getPlain('doc_audit.token');
  if (docAuditToken) {
    env.DOC_AUDIT_TOKEN = docAuditToken;
  } else {
    delete env.DOC_AUDIT_TOKEN;
  }

  // 兼容旧名称：回调 Token
  const callbackToken = promptConfigStore.getPlain('callback.token');
  if (callbackToken) {
    env.CALLBACK_TOKEN = callbackToken;
  } else {
    delete env.CALLBACK_TOKEN;
  }

  // Claude Agent SDK 行为配置
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = l.disable_nonessential_traffic ? '1' : '0';
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = l.attribution_header ? '1' : '0';
  env.CLAUDE_CODE_AUTO_MODE_SERVER = l.auto_mode_server ? '1' : '0';

  return env;
}

export async function buildClaudeMd(dataDir?: string): Promise<string> {
  // 加载主模板
  let template = (await loadPromptFile('claude-md.md')) ?? '';
  if (!template) {
    template = `# AI 数字员工 工作区

你是 AI 数字员工，运行在这个临时工作目录中。你需要自主完成任务，包括调用外部接口、下载文件、解析文档等。如有需要可主动调用相关工具。

## 文件下载
- 用 curl 下载文件到当前工作目录
- 文件 URL 已开放白名单，无需认证

## 行为规范
1. 严格按提示词要求的 JSON Schema 输出
2. 最终结果用 \`\`\`json 代码块包裹
3. 不要输出任何其他内容`;
  }

  // ── 从 prompt_config（CSV）+ cfg.yml 系统级收集所有值 ──
  const cfgVals = promptConfigStore.getAllPlain();
  // 系统级占位符（不在 CSV 中）
  const { getRawConfig } = await import('../config.js');
  const raw = getRawConfig() as Record<string, unknown>;
  const server = (raw.server as Record<string, unknown>) || {};
  cfgVals.set('server.port', String(server.port ?? 20001));
  cfgVals.set('server.self_ip', String(server.self_ip ?? ''));

  // ── 预加载所有 sections 文件 ──
  const allSections = await loadAllPromptFiles();

  // ── 替换 {{section:name:trigger_key}} 占位符 ──
  // trigger_key 支持含点号的路径，如 doc_audit.api_url
  template = template.replace(/\{\{section:([\w-]+):([\w.]+)\}\}/g, (_: string, name: string, triggerKey: string) => {
    const triggerVal = cfgVals.get(triggerKey.trim());
    if (!triggerVal) {
      return ''; // 触发 key 没值 → 整段不渲染
    }
    const sectionKey = 'sections/' + name + '.md';
    let sectionContent = allSections.get(sectionKey);
    if (!sectionContent) {
      sectionContent = allSections.get(name + '.md');
    }
    return sectionContent ?? '';
  });

  // ── 替换剩余 {{key}} 占位符（key 支持含点号） ──
  template = template.replace(/\{\{([\w.]+)\}\}/g, (_: string, path: string) => {
    const trimmed = path.trim();
    if (trimmed.startsWith('section:')) return `{{${path}}}`;
    const val = cfgVals.get(trimmed);
    return val ?? `{{${path}}}`;
  });

  // ── 注入业务知识记忆库索引 ──
  const dataRoot = dataDir || join(process.cwd(), 'data');
  const memoryDir = getMemoryDir(dataRoot);
  const memItems = listMemories(dataRoot);
  if (memItems.length > 0) {
    let memBlock = '\n## 业务知识记忆库\n\n';
    memBlock += '以下是可用的业务背景知识文件，存储于 `' + memoryDir + '` 目录。';
    memBlock += '当任务需要相关业务背景知识时，';
    memBlock += '使用 Read 工具读取对应文件的绝对路径（如 `' + join(memoryDir, memItems[0].filename) + '`）。\n\n';
    memBlock += '| 文件 | 绝对路径 | 说明 |\n';
    memBlock += '|------|----------|------|\n';
    for (const item of memItems) {
      const absPath = join(memoryDir, item.filename);
      memBlock += `| ${item.filename} | ${absPath} | ${item.description || item.title} |\n`;
    }
    template += memBlock;
  }

  // ── 注入可用环境变量清单（值不写入提示词，仅列出变量名 + 说明） ──
  const configRows = promptConfigStore.list();
  if (configRows.length > 0) {
    let envBlock = '\n## 可用环境变量\n\n';
    envBlock += '以下变量已注入到当前 shell 环境，可在 Bash 中按需读取（如 `echo $变量名`）。';
    envBlock += '变量名以 `DP_` 为前缀；按 key 或说明理解其含义，需要时再取值，不必一次性全部读取。\n\n';
    envBlock += '| 环境变量名 | key | 说明 | 是否敏感 |\n';
    envBlock += '|-----------|-----|------|---------|\n';
    for (const r of configRows) {
      envBlock += `| \`$${keyToEnvName(r.key)}\` | \`${r.key}\` | ${(r.note || '-').replace(/\|/g, '\\|')} | ${r.is_secret ? '是' : '否'} |\n`;
    }
    template += envBlock;
  }

  return template;
}
export interface SdkResult {
  success: boolean;
  rawOutput: string;
  trace: string;
  sessionId?: string;       // SDK 返回的 session_id，用于后续 resume
  errorMessage?: string;
  durationMs: number;
}

/**
 * 运行 Claude Agent SDK 处理一个任务。
 *
 * @param linkid - 公文审批 id，同时作为工作目录名（sanitize 后）
 * @param renderedPrompt - 渲染后的提示词
 * @param cfg - 配置
 * @param resumeSessionId - 若传入则尝试 resume 该 session（同一公文复用会话）。
 *                          如果 session 数据已不存在（如重新部署后容器内数据丢失），
 *                          自动降级为创建新 session。
 */
export async function runAgent(
  linkid: string,
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
  resumeSessionId?: string,
  onSessionId?: (sessionId: string) => void,
  abortSignal?: AbortSignal,
): Promise<SdkResult> {
  const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeDirName(linkid));
  await mkdir(workDir, { recursive: true });

  // 验证 resume session 是否仍然存在。
  // 重新部署后容器内 Claude 会话数据丢失（runtime/ 非持久化），
  // 但 SQLite sessions 表中仍有旧记录，此时应降级为新建 session。
  let effectiveResumeId: string | undefined = resumeSessionId;
  if (effectiveResumeId) {
    const oldSessionId = effectiveResumeId;
    try {
      const info = await getSessionInfo(oldSessionId);
      if (!info) {
        log.warn({ taskId, linkid, oldSessionId }, 'resume_session_gone_creating_new');
        effectiveResumeId = undefined;
        // session 数据已不存在（重新部署/清理等原因），同步关闭 DB 里的旧记录，
        // 避免下次同一 linkid 再走一次无意义的探测。
        sessionsStore.close(oldSessionId);
      }
    } catch (err) {
      log.warn({ taskId, linkid, oldSessionId, error: String(err) }, 'resume_session_check_error_creating_new');
      effectiveResumeId = undefined;
      sessionsStore.close(oldSessionId);
    }
  }

  // CLAUDE.md 仅首次写入（resume 时不覆盖，因为 SDK snapshot 已固化 system prompt）
  if (!effectiveResumeId) {
    await writeFile(
      join(workDir, 'CLAUDE.md'),
      await buildClaudeMd(cfg.sys.data_dir),
      'utf8',
    );
  }

  log.info({ taskId, linkid, resumeSessionId: effectiveResumeId || '(new)', originalResumeId: resumeSessionId || '(none)', workDir }, 'sdk_run_start');

  const start = Date.now();
  let fullOutput = '';
  let capturedSessionId: string | undefined;
  const traceMessages: unknown[] = [];
  const callbackToolIds = new Set<string>();

  const abortController = new AbortController();
  let onAbort: (() => void) | undefined;

  try {
    // 外部取消信号（管理员在任务监控里点「停止」）触发 SDK 中断
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        onAbort = () => abortController.abort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const q = query({
      prompt: renderedPrompt,
      options: {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        tools: { type: 'preset', preset: 'claude_code' },
        model: cfg.llm.model,
        env: buildEnv(cfg),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        maxTurns: cfg.llm.max_turns,
        abortController,
        ...(effectiveResumeId ? { resume: effectiveResumeId } : {}),
      },
    });

    for await (const message of q) {
      traceMessages.push(message);

      // 首条消息即捕获 session_id，用于立即写入 sessions 表
      const sid = (message as Record<string, unknown>).session_id;
      if (!capturedSessionId && typeof sid === 'string' && sid) {
        capturedSessionId = sid;
        onSessionId?.(sid);
      }

      // 推送到 SSE 总线，让前端实时订阅
      if (capturedSessionId) {
        publish(capturedSessionId, message);
      }

      // 收集 assistant 文本输出
      if ((message as Record<string, unknown>).type === 'assistant') {
        const msg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fullOutput += block.text;
            }
            // 识别回调 curl 命令（tool_use / Bash），记录回调请求体
            if (block.type === 'tool_use' && block.name === 'Bash') {
              const input = block.input as Record<string, unknown> | undefined;
              const cmd = typeof input?.command === 'string' ? input!.command as string : '';
              if (cmd.includes('/tmp/callback_payload') || cmd.includes('callback')) {
                const bid = typeof block.id === 'string' ? block.id as string : '';
                if (bid) callbackToolIds.add(bid);
                log.debug({ taskId, linkid, command: cmd }, 'callback_request');
              }
            }
          }
        }
      }

      // 识别回调 curl 的执行结果（tool_result），记录对方返回内容
      if ((message as Record<string, unknown>).type === 'user') {
        const msg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            const tuid = typeof block.tool_use_id === 'string' ? block.tool_use_id as string : '';
            if (block.type === 'tool_result' && tuid && callbackToolIds.has(tuid)) {
              log.debug({ taskId, linkid, callbackResponse: toolResultText(block.content) }, 'callback_response');
            }
          }
        }
      }
    }

    const durationMs = Date.now() - start;
    const trace = JSON.stringify(traceMessages);
    log.info({ taskId, linkid, sessionId: capturedSessionId, durationMs, outputLen: fullOutput.length, traceLen: trace.length }, 'sdk_run_complete');

    // 发送结束信号，让 SSE 连接自然关闭
    if (capturedSessionId) {
      publish(capturedSessionId, { type: 'end' });
    }

    return { success: true, rawOutput: fullOutput, trace, sessionId: capturedSessionId, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const trace = JSON.stringify(traceMessages);
    log.error({ taskId, linkid, sessionId: capturedSessionId, durationMs, error: message, partialTraceLen: trace.length }, 'sdk_run_error');

    if (capturedSessionId) {
      publish(capturedSessionId, { type: 'end' });
    }
    return { success: false, rawOutput: fullOutput, trace, sessionId: capturedSessionId, errorMessage: message, durationMs };
  } finally {
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }
}