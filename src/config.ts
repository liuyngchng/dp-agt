import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

// ---- 默认值 ----
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const RUNTIME_DIR = process.env.RUNTIME_DIR || resolve(process.cwd(), 'runtime');

interface CfgFile {
  server?: {
    port?: number;
    debug?: boolean;
    self_ip?: string;
  };
  sys?: {
    max_concurrent_tasks?: number;
    max_pending_tasks?: number;
    retention_days?: number;
    data_dir?: string;
    runtime_dir?: string;
    watchdog_grace_ms?: number;
    log_rolled_count?: number;
    log_gz_count?: number;
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
    max_turns?: number;
    disable_nonessential_traffic?: boolean;
    attribution_header?: boolean;
    auto_mode_server?: boolean;
  };
  runner?: {
    token?: string;
    port?: number;
    heartbeat_ms?: number;
    connect_timeout_ms?: number;
    request_timeout_ms?: number;
    addresses?: Array<{
      name: string;
      addr: string;
      capacity?: number;
    }>;
  };
}

export interface Config {
  server: {
    port: number;
    debug: boolean;
    self_ip: string;
  };
  sys: {
    max_concurrent_tasks: number;
    max_pending_tasks: number;
    retention_days: number;
    data_dir: string;
    runtime_dir: string;
    watchdog_grace_ms: number;
    log_rolled_count: number;
    log_gz_count: number;
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
    max_turns: number;
    disable_nonessential_traffic: boolean;
    attribution_header: boolean;
    auto_mode_server: boolean;
  };
  runner: {
    token: string;
    port: number;
    heartbeat_ms: number;
    connect_timeout_ms: number;
    request_timeout_ms: number;
    addresses: Array<{ name: string; addr: string; capacity: number }>;
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
  const r = cfg.runner ?? {};

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
      self_ip: env('SELF_IP', s.self_ip ?? ''),
    },
    sys: {
      max_concurrent_tasks: envInt('MAX_CONCURRENT_TASKS', y.max_concurrent_tasks ?? 5),
      max_pending_tasks: envInt('MAX_PENDING_TASKS', y.max_pending_tasks ?? 10),
      retention_days: envInt('RETENTION_DAYS', y.retention_days ?? 30),
      data_dir: env('DATA_DIR', y.data_dir ?? DATA_DIR),
      runtime_dir: env('RUNTIME_DIR', y.runtime_dir ?? RUNTIME_DIR),
      // SDK 硬超时后，再等这么久仍未结束，看门狗强制杀进程树并落库 failed
      watchdog_grace_ms: envInt('WATCHDOG_GRACE_MS', y.watchdog_grace_ms ?? 60000),
      // 按天滚动日志保留数量（.log，不含 .gz）
      log_rolled_count: envInt('LOG_ROLLED_COUNT', y.log_rolled_count ?? 30),
      // 压缩日志保留数量（.log.gz）
      log_gz_count: envInt('LOG_GZ_COUNT', y.log_gz_count ?? 60),
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
      max_turns: envInt('MAX_TURNS', l.max_turns ?? 100),
      disable_nonessential_traffic: envBool('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', l.disable_nonessential_traffic ?? true),
      attribution_header: envBool('CLAUDE_CODE_ATTRIBUTION_HEADER', l.attribution_header ?? false),
      auto_mode_server: envBool('CLAUDE_CODE_AUTO_MODE_SERVER', l.auto_mode_server ?? false),
    },
    runner: {
      token: env('RUNNER_TOKEN', r.token ?? ''),
      port: envInt('RUNNER_PORT', r.port ?? 20002),
      heartbeat_ms: envInt('RUNNER_HEARTBEAT_MS', r.heartbeat_ms ?? 5000),
      connect_timeout_ms: envInt('RUNNER_CONNECT_TIMEOUT_MS', r.connect_timeout_ms ?? 5000),
      request_timeout_ms: envInt('RUNNER_REQUEST_TIMEOUT_MS', r.request_timeout_ms ?? 15000),
      addresses: (r.addresses ?? []).map((a) => ({
        name: a.name,
        addr: a.addr,
        capacity: a.capacity ?? 5,
      })),
    },
  };
}

/** 确保运行时目录存在 */
export function ensureDirs(cfg: Config) {
  mkdirSync(join(cfg.sys.data_dir, 'logs'), { recursive: true });
  mkdirSync(join(cfg.sys.data_dir, 'memory'), { recursive: true });
  mkdirSync(join(cfg.sys.runtime_dir, 'tasks'), { recursive: true });
  mkdirSync(join(cfg.sys.runtime_dir, 'claude-config'), { recursive: true });

  // SDK 会话历史写入 RUNTIME_DIR/claude-config（而非 ~/.claude），
  // 避免宿主机 UID 与容器 UID 不一致导致写入失败。
  process.env.CLAUDE_CONFIG_DIR = join(cfg.sys.runtime_dir, 'claude-config');
}