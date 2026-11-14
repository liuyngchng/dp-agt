/**
 * Claude Code Agent SDK 调用封装（控制面侧）
 *
 * 纯执行核心在 ./sdk-core.ts（runner 与控制面共用，不拖入 store/config）。
 * 本文件保留控制面专属：buildEnv / buildClaudeMd（依赖 prompt_config、memory、prompts）
 * 以及本地回退适配器 runAgent。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { getLogger } from '../logger.js';
import { publish } from './sse-bus.js';
import type { Config } from '../config.js';
import type { RunSdkOptions } from '../types.js';
import { promptConfigStore, sessionsStore } from '../store.js';
import { listMemories, getMemoryDir } from './memory-store.js';
import { runAgentCore, sanitizeDirName, type SdkResult, type RunAgentInput, type RunAgentHooks } from './sdk-core.js';

export { runAgentCore, sanitizeDirName, type SdkResult, type RunAgentInput, type RunAgentHooks } from './sdk-core.js';

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
    break;
  }
  return files;
}

/** 任务工作目录：runtime/tasks/<sanitize(linkid)>/（按 linkid 唯一，供看门狗定位 SDK 子进程） */
export function taskWorkDir(cfg: Config, linkid: string): string {
  return join(cfg.sys.runtime_dir, 'tasks', sanitizeDirName(linkid));
}

/** prompt_config key → DP_ 前缀环境变量名：点→下划线，全大写 */
function keyToEnvName(key: string): string {
  return 'DP_' + key.replace(/\./g, '_').toUpperCase();
}

/** 根据 LLM 配置 + prompt_config 构建 Claude Code 子进程环境变量 */
export function buildEnv(cfg: Config, skipClaudeConfigDir?: boolean): Record<string, string | undefined> {
  // SDK 的 env 会整体替换子进程环境（不自动合并 process.env），
  // 因此先继承父进程环境，再用 adapter 配置覆盖。
  const env: Record<string, string | undefined> = { ...process.env };
  const l = cfg.llm;

  // runner 用自己的本地 CLAUDE_CONFIG_DIR，控制面派发时剔除该变量，避免继承到远端路径
  if (skipClaudeConfigDir) {
    delete env.CLAUDE_CONFIG_DIR;
  }

  env.ANTHROPIC_BASE_URL = l.base_url;

  if (l.auth_token) {
    env.ANTHROPIC_AUTH_TOKEN = l.auth_token;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  env.ANTHROPIC_MODEL = l.model || env.ANTHROPIC_MODEL;
  if (l.opus_model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = l.opus_model;
  if (l.sonnet_model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = l.sonnet_model;
  if (l.haiku_model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = l.haiku_model;
  if (l.subagent_model) env.CLAUDE_CODE_SUBAGENT_MODEL = l.subagent_model;
  if (l.effort_level) env.CLAUDE_CODE_EFFORT_LEVEL = l.effort_level;
  if (l.timeout_ms) env.API_TIMEOUT_MS = String(l.timeout_ms);

  // 清理可能让 CLI 绕过网关的凭据
  delete env.ANTHROPIC_API_KEY;

  // 注入 prompt_config 中的所有 key-value 作为 DP_ 前缀环境变量
  const allConfigValues = promptConfigStore.getAllPlain();
  for (const [key, plain] of allConfigValues.entries()) {
    env[keyToEnvName(key)] = plain;
  }

  // 兼容旧名称
  const fileUrlToken = promptConfigStore.getPlain('doc.file_url_token')
    || promptConfigStore.getPlain('sys.file_url_token');
  if (fileUrlToken) env.FILE_URL_TOKEN = fileUrlToken; else delete env.FILE_URL_TOKEN;

  const docAuditToken = promptConfigStore.getPlain('doc_audit.token');
  if (docAuditToken) env.DOC_AUDIT_TOKEN = docAuditToken; else delete env.DOC_AUDIT_TOKEN;

  const callbackToken = promptConfigStore.getPlain('callback.token');
  if (callbackToken) env.CALLBACK_TOKEN = callbackToken; else delete env.CALLBACK_TOKEN;

  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = l.disable_nonessential_traffic ? '1' : '0';
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = l.attribution_header ? '1' : '0';
  env.CLAUDE_CODE_AUTO_MODE_SERVER = l.auto_mode_server ? '1' : '0';

  return env;
}

export async function buildClaudeMd(dataDir?: string): Promise<string> {
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

  // 从 prompt_config（CSV）+ cfg.yml 系统级收集所有值，仅用于判断 {{section:...}} 是否触发
  const cfgVals = promptConfigStore.getAllPlain();
  const { getRawConfig } = await import('../config.js');
  const raw = getRawConfig() as Record<string, unknown>;
  const server = (raw.server as Record<string, unknown>) || {};
  cfgVals.set('server.port', String(server.port ?? 20001));
  cfgVals.set('server.self_ip', String(server.self_ip ?? ''));

  const allSections = await loadAllPromptFiles();

  template = template.replace(/\{\{section:([\w-]+):([\w.]+)\}\}/g, (_: string, name: string, triggerKey: string) => {
    const triggerVal = cfgVals.get(triggerKey.trim());
    if (!triggerVal) return '';
    const sectionKey = 'sections/' + name + '.md';
    let sectionContent = allSections.get(sectionKey);
    if (!sectionContent) sectionContent = allSections.get(name + '.md');
    return sectionContent ?? '';
  });

  // 注入业务知识记忆库索引
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

  // 注入可用环境变量清单（值不写入提示词，仅列出变量名 + 说明）
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

/**
 * 控制面本地回退路径：从 cfg / SQLite / prompts 解析出 RunAgentInput 后调用 runAgentCore，
 * 并把消息转发到 sse-bus。横向扩展模式下（runner.addresses 非空）不经过此函数。
 */
export async function runAgent(
  linkid: string,
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
  resumeSessionId?: string,
  onSessionId?: (sessionId: string) => void,
  abortSignal?: AbortSignal,
  onActivity?: () => void,
): Promise<SdkResult> {
  const workDir = taskWorkDir(cfg, linkid);
  const sdkOptions: RunSdkOptions = {
    model: cfg.llm.model,
    max_turns: cfg.llm.max_turns,
    effort_level: cfg.llm.effort_level,
    disable_nonessential_traffic: cfg.llm.disable_nonessential_traffic,
    attribution_header: cfg.llm.attribution_header,
    auto_mode_server: cfg.llm.auto_mode_server,
  };

  let capturedSessionId: string | undefined;
  const result = await runAgentCore(
    linkid,
    taskId,
    {
      workDir,
      prompt: renderedPrompt,
      claudeMd: await buildClaudeMd(cfg.sys.data_dir),
      resumeSessionId,
      sdkOptions,
      env: buildEnv(cfg) as Record<string, string>,
    },
    abortSignal,
    {
      onSessionId: (sid) => {
        capturedSessionId = sid;
        onSessionId?.(sid);
      },
      onMessage: (message) => {
        if (capturedSessionId) {
          publish(capturedSessionId, message);
        }
      },
      onActivity,
      onResumeGone: (oldSessionId) => {
        sessionsStore.close(oldSessionId);
      },
    },
  );

  if (capturedSessionId) {
    publish(capturedSessionId, { type: 'end' });
  }

  return result;
}
