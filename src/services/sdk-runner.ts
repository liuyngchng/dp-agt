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
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger.js';
import { fmtLocalTs } from '../time.js';
import { publish } from './sse-bus.js';
import type { Config } from '../config.js';
import { promptConfigStore } from '../store.js';
import { listMemories } from './memory-store.js';

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

/** 根据 LLM 配置构建 Claude Code 子进程环境变量 */
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

  // ── 文件下载 Token（从 CSV 读取，CLAUDE.md 中通过 $FILE_URL_TOKEN 引用） ──
  const fileUrlToken = promptConfigStore.getPlain('doc.file_url_token')
    || promptConfigStore.getPlain('sys.file_url_token');
  if (fileUrlToken) {
    env.FILE_URL_TOKEN = fileUrlToken;
  } else {
    delete env.FILE_URL_TOKEN;
  }

  // ── 文档审核服务 Token（从 CSV 读取，CLAUDE.md 中通过 $DOC_AUDIT_TOKEN 引用） ──
  const docAuditToken = promptConfigStore.getPlain('doc_audit.token');
  if (docAuditToken) {
    env.DOC_AUDIT_TOKEN = docAuditToken;
  } else {
    delete env.DOC_AUDIT_TOKEN;
  }

  // ── 回调 Token（从 CSV 读取，CLAUDE.md 中通过 $CALLBACK_TOKEN 引用） ──
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
  const memoryDir = dataDir || join(process.cwd(), 'data');
  const memItems = listMemories(memoryDir);
  if (memItems.length > 0) {
    let memBlock = '\n## 业务知识记忆库\n\n';
    memBlock += '以下是可用的公司业务背景知识文件，均位于 `data/memory/` 目录。';
    memBlock += '当任务需要了解公司组织架构、领导班子分工、各部门职责范围或业务流程规则时，';
    memBlock += '使用 Read 工具读取对应文件（路径如 `data/memory/公司领导班子成员工作分工.md`）。\n\n';
    memBlock += '| 文件 | 说明 |\n';
    memBlock += '|------|------|\n';
    for (const item of memItems) {
      memBlock += `| ${item.filename} | ${item.description || item.title} |\n`;
    }
    template += memBlock;
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
 * @param resumeSessionId - 若传入则 resume 该 session（同一公文复用会话）
 */
export async function runAgent(
  linkid: string,
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
  resumeSessionId?: string,
  onSessionId?: (sessionId: string) => void,
): Promise<SdkResult> {
  const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeDirName(linkid));
  await mkdir(workDir, { recursive: true });

  // CLAUDE.md 仅首次写入（resume 时不覆盖，因为 SDK snapshot 已固化 system prompt）
  if (!resumeSessionId) {
    await writeFile(
      join(workDir, 'CLAUDE.md'),
      await buildClaudeMd(cfg.sys.data_dir),
      'utf8',
    );
  }

  log.info({ taskId, linkid, resumeSessionId: resumeSessionId || '(new)', workDir }, 'sdk_run_start');

  const start = Date.now();
  let fullOutput = '';
  let capturedSessionId: string | undefined;
  const traceMessages: unknown[] = [];

  try {
    const q = query({
      prompt: renderedPrompt,
      options: {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        tools: { type: 'preset', preset: 'claude_code' },
        model: cfg.llm.model,
        env: buildEnv(cfg),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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
  }
}