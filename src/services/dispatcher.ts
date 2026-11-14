/**
 * Runner 调度器（控制面）
 *
 * - 启动时按 cfg.runner.addresses 同步 runners 表
 * - 心跳轮询 /status，更新 up/down 与 running_count
 * - selectRunner(linkid)：优先 session 亲和，否则选负载最低的 up runner
 * - 内存 assigned 计数（派发 +1 / 收尾 -1）
 */
import { getLogger } from '../logger.js';
import { runnersStore } from '../store.js';
import { getRunnerStatus, type RunnerHttpConfig } from './runner-client.js';
import type { Config } from '../config.js';
import type { Runner } from '../types.js';

const log = getLogger();

let cfg: Config;
let httpCfg: RunnerHttpConfig;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

/** runnerId → 已派发但未收尾的任务数（内存态，单控制面内权威） */
const assigned = new Map<string, number>();
/** runnerId → 最近一次 /status 上报的 running_count */
const runningCount = new Map<string, number>();

export function initDispatcher(c: Config): void {
  cfg = c;
  httpCfg = {
    token: c.runner.token,
    connect_timeout_ms: c.runner.connect_timeout_ms,
    request_timeout_ms: c.runner.request_timeout_ms,
  };

  // 静态列表同步进 runners 表
  const runners = runnersStore.sync(c.runner.addresses);
  for (const r of runners) {
    assigned.set(r.id, 0);
    runningCount.set(r.id, 0);
  }
  log.info({ count: runners.length, names: runners.map((r) => r.name) }, 'dispatcher_initialized');

  // 单实例回退：没有配置任何 runner 时不启动心跳
  if (runners.length === 0) return;

  startHeartbeat();
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    for (const r of runnersStore.list()) {
      try {
        const st = await getRunnerStatus(r.addr, httpCfg);
        runningCount.set(r.id, st.running_count);
        runnersStore.heartbeat(r.id);
      } catch (err) {
        log.warn({ runner: r.name, error: String(err) }, 'runner_heartbeat_failed');
        runnersStore.markDown(r.id);
      }
    }
  }, cfg.runner.heartbeat_ms);
  heartbeatTimer.unref();
}

/** 当前有多少 runner（含 down） */
export function runnerCount(): number {
  return runnersStore.list().length;
}

/** 是否有可用的远端 runner（无则回退本进程执行） */
export function hasRemoteRunners(): boolean {
  return runnersStore.listUp().length > 0;
}

/** 内存占用计数 */
function assignedCount(runnerId: string): number {
  return assigned.get(runnerId) ?? 0;
}

function availableSlots(r: Runner): number {
  const real = runningCount.get(r.id) ?? 0;
  // 用「控制面派发中的计数」与「runner 真实运行数」取较大者，避免刚派发还没被心跳统计时超额
  const busy = Math.max(real, assignedCount(r.id));
  return Math.max(0, r.capacity - busy);
}

/**
 * 选择 runner。
 * @param linkid 用于 session 亲和：同 linkid 已有 session 时优先路由回原 runner。
 * @param preferredRunnerId 期望的 runner（session 亲和，可能已 down/满，返回 null 表示需重选）
 */
export function selectRunner(linkid: string, preferredRunnerId?: string): Runner | null {
  const up = runnersStore.listUp();

  // 1) 亲和：优先回原 runner（只要它还 up 且有槽）
  if (preferredRunnerId) {
    const preferred = up.find((r) => r.id === preferredRunnerId);
    if (preferred && availableSlots(preferred) > 0) {
      return preferred;
    }
    // 原 runner down 或满：交给调用方决定是「降级新建 session」还是换一台
  }

  // 2) 负载最低的 up runner
  let best: Runner | null = null;
  let bestSlots = -1;
  for (const r of up) {
    const slots = availableSlots(r);
    if (slots > bestSlots) {
      best = r;
      bestSlots = slots;
    }
  }
  return best;
}

/** 派发成功后调用：占用 +1 */
export function markDispatched(runnerId: string): void {
  assigned.set(runnerId, assignedCount(runnerId) + 1);
}

/** 收尾（成功/失败/取消/连接断开）后调用：占用 -1 */
export function markFinished(runnerId: string): void {
  const c = Math.max(0, assignedCount(runnerId) - 1);
  assigned.set(runnerId, c);
}

/** 通过 runner name 找 runner（供 admin 会话代理用） */
export function getRunnerByName(name: string): Runner | undefined {
  return runnersStore.getByName(name);
}

export function getRunnerHttpConfig(): RunnerHttpConfig {
  return httpCfg;
}
