import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

// ---- 默认值 ----
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');

interface CfgFile {
  server?: {
    port?: number;
    debug?: boolean;
    cert_file?: string;
    key_file?: string;
    self_ip?: string;
  };
  sys?: {
    max_concurrent_tasks?: number;
    max_pending_tasks?: number;
    retention_days?: number;
    data_dir?: string;
  };
  llm?: {
    base_url?: string;
    auth_token?: string;
    model?: string;
    opus_model?: string;
    sonnet_model?: string;
    haiku_model?: string;
    subagent_model?: string;
    effort_level?: string;
    timeout_ms?: number;
    disable_nonessential_traffic?: boolean;
    attribution_header?: boolean;
    auto_mode_server?: boolean;
  };
}

export interface Config {
  server: {
    port: number;
    debug: boolean;
    cert_file: string;
    key_file: string;
    self_ip: string;
  };
  sys: {
    max_concurrent_tasks: number;
    max_pending_tasks: number;
    retention_days: number;
    data_dir: string;
  };
  llm: {
    base_url: string;
    auth_token: string;
    model: string;
    opus_model: string;
    sonnet_model: string;
    haiku_model: string;
    subagent_model: string;
    effort_level: string;
    timeout_ms: number;
    disable_nonessential_traffic: boolean;
    attribution_header: boolean;
    auto_mode_server: boolean;
  };
}

function env(k: string, def: string): string {
  return process.env[k] ?? def;
}

function envInt(k: string, def: number): number {
  const v = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function envBool(k: string, def: boolean): boolean {
  const v = process.env[k];
  if (v === undefined) return def;
  return v === '1' || v === 'true';
}

/** 从 data/cfg.yml 加载 YAML 配置 */
function loadCfgFile(): CfgFile {
  const paths = [
    join(DATA_DIR, 'cfg.yml'),
    resolve(process.cwd(), 'data', 'cfg.yml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8');
        return (loadYaml(raw) as CfgFile) ?? {};
      } catch {
        console.warn('config: 解析 cfg.yml 失败，使用默认值');
      }
    }
  }
  return {};
}

const cfg = loadCfgFile();

/** 返回 cfg.yml 的原始解析对象（用于 CLAUDE.md 模板的 {{key}} 占位符替换） */
export function getRawConfig(): Record<string, unknown> {
  return cfg as unknown as Record<string, unknown>;
}

export function loadConfig(): Config {
  const s = cfg.server ?? {};
  const y = cfg.sys ?? {};
  const l = cfg.llm ?? {};

  const llmBaseUrl = env('ANTHROPIC_BASE_URL', l.base_url ?? '');
  if (!llmBaseUrl) {
    // 强制要求配置 LLM 网关地址
    console.error(
      '[config] 缺少 llm.base_url（或环境变量 ANTHROPIC_BASE_URL）。\n' +
      '         必须指向 Anthropic 协议兼容网关（如 api-gate）。\n' +
      '         请在 data/cfg.yml 中填写 llm.base_url。'
    );
    process.exit(1);
  }

  return {
    server: {
      port: envInt('SERVER_PORT', s.port ?? 20001),
      debug: envBool('DEBUG', s.debug ?? false),
      cert_file: env('CERT_FILE', s.cert_file ?? ''),
      key_file: env('KEY_FILE', s.key_file ?? ''),
      self_ip: env('SELF_IP', s.self_ip ?? ''),
    },
    sys: {
      max_concurrent_tasks: envInt('MAX_CONCURRENT_TASKS', y.max_concurrent_tasks ?? 5),
      max_pending_tasks: envInt('MAX_PENDING_TASKS', y.max_pending_tasks ?? 10),
      retention_days: envInt('RETENTION_DAYS', y.retention_days ?? 30),
      data_dir: env('DATA_DIR', y.data_dir ?? DATA_DIR),
    },
    llm: {
      base_url: llmBaseUrl,
      auth_token: env('ANTHROPIC_AUTH_TOKEN', l.auth_token ?? ''),
      model: env('ANTHROPIC_MODEL', l.model ?? 'deepseek-v4-pro'),
      opus_model: env('ANTHROPIC_DEFAULT_OPUS_MODEL', l.opus_model ?? ''),
      sonnet_model: env('ANTHROPIC_DEFAULT_SONNET_MODEL', l.sonnet_model ?? ''),
      haiku_model: env('ANTHROPIC_DEFAULT_HAIKU_MODEL', l.haiku_model ?? ''),
      subagent_model: env('CLAUDE_CODE_SUBAGENT_MODEL', l.subagent_model ?? ''),
      effort_level: env('CLAUDE_CODE_EFFORT_LEVEL', l.effort_level ?? ''),
      timeout_ms: envInt('API_TIMEOUT_MS', l.timeout_ms ?? 600000),
      disable_nonessential_traffic: envBool('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', l.disable_nonessential_traffic ?? true),
      attribution_header: envBool('CLAUDE_CODE_ATTRIBUTION_HEADER', l.attribution_header ?? false),
      auto_mode_server: envBool('CLAUDE_CODE_AUTO_MODE_SERVER', l.auto_mode_server ?? false),
    },
  };
}

/** 确保运行时目录存在 */
export function ensureDirs(cfg: Config) {
  mkdirSync(join(cfg.sys.data_dir, 'tasks'), { recursive: true });
  mkdirSync(join(cfg.sys.data_dir, 'logs'), { recursive: true });
}