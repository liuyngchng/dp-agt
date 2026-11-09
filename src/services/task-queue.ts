/**
 * 异步任务队列
 *
 * 基于 Promise 的轻量内存队列，配合 SQLite 持久化状态。
 * - 按 linkid 串行化：同一公文的多次提交排队顺序执行，保证 session 不冲突。
 * - 不同 linkid 之间仍可并发（受 max_concurrent_tasks 限制）。
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import { getLogger } from '../logger.js';
import { taskLogsStore, interfacesStore, sessionsStore, sdkTracesStore } from '../store.js';
import { renderPrompt, loadPromptFromDisk } from './prompt-engine.js';
import { runAgent, taskWorkDir } from './sdk-runner.js';
import { nowReadable, nowTs } from '../time.js';
import type { Config } from '../config.js';
import type { AgentInterface, ProcessRequest, TaskLog, TaskStatus } from '../types.js';

const log = getLogger();

type WorkerItem = {
  task_id: string;
  path: string;
  iface: AgentInterface;
  body: ProcessRequest;
  /** 入队即创建，覆盖「排队 → 链上等待 → 处理中」整个生命周期，供取消操作使用 */
  abortController: AbortController;
  /** 看门狗已强制终止该任务：收尾时写出一致的失败原因 */
  watchdogKilled?: boolean;
  /** 最后收到 SDK 消息的时间戳。滑动超时与看门狗按「无活动时长」判定；0 = 尚未进入 SDK 执行阶段 */
  lastActivity: number;
};

let cfg: Config;
let running = 0;
const pending: WorkerItem[] = [];

// ── per-linkid 串行化 ──
const linkChains = new Map<string, Promise<void>>();

// ── 已出队、尚未结束的任务（链上等待 + 处理中）：task_id → WorkerItem ──
const active = new Map<string, WorkerItem>();

function nowLocal(): string {
  return nowReadable();
}

async function processItem(item: WorkerItem): Promise<void> {
  const { task_id, path: interfacePath, iface, body, abortController } = item;
  const linkid = body.linkid;
  let timeoutFired = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // 在链上等待期间被取消：直接置为 cancelled，不再启动 SDK
    if (abortController.signal.aborted) {
      taskLogsStore.updateResult(task_id, {
        status: 'cancelled' as TaskStatus,
        error_message: '任务已被管理员取消',
        finished_at: nowLocal(),
      });
      log.info({ task_id, linkid, path: interfacePath }, 'task_cancelled_before_start');
      return;
    }

    // 状态 → processing（started_ts 供看门狗判定「处理了多久」，用 created_ts 会误算排队时间）
    taskLogsStore.updateResult(task_id, { status: 'processing', started_ts: nowTs() });
    log.info({ task_id, linkid, path: interfacePath }, 'task_processing');

    // 从磁盘读取提示词模板（DB 的 prompt 列已废弃）
    const template = loadPromptFromDisk(interfacePath);
    if (!template) {
      taskLogsStore.updateResult(task_id, {
        status: 'failed' as TaskStatus,
        error_message: '提示词文件不存在: ' + interfacePath,
        finished_at: nowLocal(),
      });
      log.error({ task_id, linkid, path: interfacePath }, 'prompt_file_missing');
      return;
    }

    // 渲染提示词
    const rendered = renderPrompt(template, body as unknown as Record<string, unknown>, task_id);
    taskLogsStore.updateResult(task_id, { prompt: rendered });

    // 查 sessions 表：同一 linkid 是否有已存在的 session
    const existingSession = sessionsStore.getByLinkid(linkid);
    const resumeSessionId = existingSession?.session_id;

    if (resumeSessionId) {
      sessionsStore.touch(resumeSessionId);
      log.info({ task_id, linkid, sessionId: resumeSessionId }, 'session_resume');
    }

    // 调用 Claude Code Agent SDK。
    // 通过 onSessionId 回调在首条流式消息拿到 session_id 的瞬间就写入 DB，
    // 这样任务仍在 processing 时，前端「对话」按钮就能实时看到会话。

    // SDK 无活动超时（滑动计时）：连续 timeout_ms 没收到任何消息才中断；
    // 每来一条消息就重置。任务只要持续输出/调工具就不会超时，
    // 避免误杀耗时长但健康的任务（Agent 任务耗时天生不可预测）。
    const hardTimeoutMs = cfg.llm.timeout_ms;
    const armTimeout = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (!hardTimeoutMs || hardTimeoutMs <= 0) return;
      if (abortController.signal.aborted) return;
      timeoutTimer = setTimeout(() => {
        if (!abortController.signal.aborted) {
          timeoutFired = true;
          log.warn({ task_id, linkid, timeoutMs: hardTimeoutMs }, 'task_sdk_timeout_force_abort');
          abortController.abort();
        }
      }, hardTimeoutMs);
    };
    armTimeout();

    item.lastActivity = nowTs();
    const result = await runAgent(linkid, task_id, rendered, cfg, resumeSessionId, (sessionId) => {
      sessionsStore.upsert(sessionId, linkid);
      taskLogsStore.updateResult(task_id, { session_id: sessionId });
    }, abortController.signal, () => {
      item.lastActivity = nowTs();
      armTimeout();
    });
    const wasAborted = abortController.signal.aborted;

    // 兜底：若 onSessionId 未触发（例如异常路径），任务结束后再写一次。
    // 被取消的任务跳过：避免覆盖管理员刚删除（关闭）的会话记录，导致会话「复活」。
    if (result.sessionId && !wasAborted) {
      sessionsStore.upsert(result.sessionId, linkid);
    }

    // 被管理员手动停止：状态应记为 cancelled，而非 failed/completed
    if (wasAborted && !timeoutFired) {
      taskLogsStore.updateResult(task_id, {
        status: 'cancelled' as TaskStatus,
        session_id: result.sessionId || null,
        sdk_output: result.rawOutput,
        error_message: '任务已被管理员停止',
        finished_at: nowLocal(),
      });
      if (result.trace) sdkTracesStore.upsert(task_id, result.trace);
      log.info({ task_id, linkid, status: 'cancelled' }, 'task_cancelled');
      return;
    }

    // SDK 超时：记为 failed
    if (wasAborted && timeoutFired) {
      taskLogsStore.updateResult(task_id, {
        status: 'failed' as TaskStatus,
        session_id: result.sessionId || null,
        sdk_output: result.rawOutput,
        error_message: 'SDK 无活动超时（连续 ' + hardTimeoutMs + 'ms 未收到任何消息），已强制中断',
        finished_at: nowLocal(),
      });
      if (result.trace) sdkTracesStore.upsert(task_id, result.trace);
      log.error({ task_id, linkid, timeoutMs: hardTimeoutMs }, 'task_sdk_timeout_failed');
      return;
    }

    if (!result.success) {
      // LLM 调用本身失败
      const errMsg = item.watchdogKilled
        ? '执行超时（连续 ' + hardTimeoutMs + 'ms 无输出），看门狗已强制终止'
        : (result.errorMessage || 'Claude 处理失败');
      taskLogsStore.updateResult(task_id, {
        status: 'failed' as TaskStatus,
        session_id: result.sessionId || null,
        sdk_output: result.rawOutput,
        error_message: errMsg,
        finished_at: nowLocal(),
      });

      if (result.trace) sdkTracesStore.upsert(task_id, result.trace);
      log.error({ task_id, linkid, error: errMsg }, 'task_failed');
      return;
    }

    // LLM 成功
    taskLogsStore.updateResult(task_id, {
      session_id: result.sessionId || null,
      sdk_output: result.rawOutput,
      status: 'completed' as TaskStatus,
      finished_at: nowLocal(),
    });

    if (result.trace) sdkTracesStore.upsert(task_id, result.trace);
    log.info({ task_id, linkid, status: 'completed' }, 'task_done');
  } catch (err) {
    // 任何未预期异常都不能让任务卡在 processing（否则该 linkid 会永久被占用）
    const msg = err instanceof Error ? err.message : String(err);
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      error_message: item.watchdogKilled
        ? '执行超时，看门狗已强制终止'
        : '任务执行异常: ' + msg,
      finished_at: nowLocal(),
    });
    log.error({ task_id, linkid, path: interfacePath, error: msg }, 'task_unexpected_error');
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

async function pump(): Promise<void> {
  const maxConcurrent = cfg.sys.max_concurrent_tasks;
  while (running < maxConcurrent && pending.length > 0) {
    const item = pending.shift()!;
    running++;
    active.set(item.task_id, item);

    // per-linkid 串行化：提交侧已保证同一 linkid 不会同时有多个活跃任务，
    // 此链实际最多只有一个任务，但保留串行语义以防未来改动引入并发同 linkid。
    const prev = linkChains.get(item.body.linkid) ?? Promise.resolve();
    const next = prev
      .then(() => processItem(item))
      .catch(() => { /* processItem 内部已 catch，不抛到外层 */ })
      .finally(() => {
        running--;
        active.delete(item.task_id);
        // 链头是自己时才清除
        if (linkChains.get(item.body.linkid) === next) {
          linkChains.delete(item.body.linkid);
        }
        // 队列中还有任务且有空位，继续消费
        if (pending.length > 0 && running < maxConcurrent) {
          pump().catch(() => {});
        }
      });
    linkChains.set(item.body.linkid, next);
  }
}

export function initTaskQueue(c: Config): void {
  cfg = c;
  recoverOrphanedTasks();
  startWatchdog();
}

// ═══════════════════════════════════════════════════════════════
// 看门狗：连续「timeout_ms + 宽限」没有任何 SDK 消息的任务（滑动超时 abort
// 后 SDK 仍未退出），强制杀进程树并落库 failed。只要任务还有活动，永不误杀。
// ═══════════════════════════════════════════════════════════════

const WATCHDOG_SWEEP_MS = 30_000;

function startWatchdog(): void {
  const timer = setInterval(() => {
    try {
      sweepStuckTasks();
    } catch (err) {
      log.error({ error: String(err) }, 'watchdog_sweep_error');
    }
  }, WATCHDOG_SWEEP_MS);
  timer.unref(); // 不阻止进程正常退出
}

function sweepStuckTasks(): void {
  const timeoutMs = cfg.llm.timeout_ms;
  if (!timeoutMs || timeoutMs <= 0) return;
  const graceMs = cfg.sys.watchdog_grace_ms;
  const cutoff = nowTs() - timeoutMs - graceMs;

  // 扫描内存中的活跃任务（单实例部署，active 表即权威状态；
  // 重启后的遗留任务由 recoverOrphanedTasks 处理）。
  for (const item of active.values()) {
    if (item.watchdogKilled) continue; // 已被看门狗处理，等待收尾
    if (item.lastActivity <= 0) continue; // 尚未进入 SDK 执行阶段（排队/链上等待）
    if (item.lastActivity > cutoff) continue; // 近期有消息，任务健康

    const task_id = item.task_id;
    const linkid = item.body.linkid;
    const workDir = taskWorkDir(cfg, linkid);
    log.warn({ task_id, linkid, timeoutMs, graceMs, workDir, lastActivity: item.lastActivity }, 'watchdog_task_stuck');

    // 先杀进程树：SDK 流随之结束 → processItem 正常收尾 → 并发槽位释放
    const killed = killTaskProcessTree(workDir);
    log.warn({ task_id, linkid, killed }, 'watchdog_killed_process_tree');

    // 标记内存中的任务，processItem 收尾时写出一致的失败原因
    item.watchdogKilled = true;

    // 立即落库 failed，释放 linkid 锁；processItem 收尾时的再次写入为幂等覆盖
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      error_message: '执行超时（连续 ' + timeoutMs + 'ms 无输出），看门狗已强制终止',
      finished_at: nowLocal(),
    });
  }
}

/**
 * 强制终止一个任务工作目录下的 SDK 子进程树。
 * SDK 不暴露子进程 PID，但子进程的 cwd 就是任务工作目录（按 linkid 唯一），
 * 通过 /proc 扫描定位：优先找父进程为本网关、cwd 在工作目录下的进程（即 SDK
 * 直接派生的 CLI 子进程），兜底匹配所有 cwd 在工作目录下的进程；然后杀掉它们
 * 及全部后代（后代可能已 cd 到别处，如工具执行 cd /tmp）。
 */
function killTaskProcessTree(workDir: string): number {
  if (process.platform !== 'linux') return 0;

  let canonicalWorkDir: string;
  try {
    canonicalWorkDir = realpathSync(workDir);
  } catch {
    return 0; // 目录已不存在，没有可杀的进程
  }

  // 收集 /proc 下所有进程的 cwd 与父进程关系
  const procs = new Map<number, { cwd: string; ppid: number }>();
  try {
    for (const entry of readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === 1) continue;
      try {
        let cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd.endsWith(' (deleted)')) cwd = cwd.slice(0, -' (deleted)'.length);
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const m = /^\d+ \(.*\) [A-Za-z] (\d+)/.exec(stat);
        if (m) procs.set(pid, { cwd, ppid: Number(m[1]) });
      } catch { /* 进程已退出或无权限 */ }
    }
  } catch {
    return 0; // /proc 不可用
  }

  const underWorkDir = (cwd: string) =>
    cwd === canonicalWorkDir || cwd.startsWith(canonicalWorkDir + '/');

  // 目标根进程：优先 SDK 直接派生的 CLI（父进程是本网关进程）
  const roots = new Set<number>();
  for (const [pid, info] of procs) {
    if (underWorkDir(info.cwd) && info.ppid === process.pid) roots.add(pid);
  }
  // 兜底：进程被孤儿化（如网关自身重启过）时，匹配所有 cwd 在工作目录下的进程
  if (roots.size === 0) {
    for (const [pid, info] of procs) {
      if (underWorkDir(info.cwd)) roots.add(pid);
    }
  }
  if (roots.size === 0) return 0;

  // 收集每个根进程的整棵子树
  const children = new Map<number, number[]>();
  for (const [pid, info] of procs) {
    const list = children.get(info.ppid) ?? [];
    list.push(pid);
    children.set(info.ppid, list);
  }
  const toKill = new Set<number>();
  for (const root of roots) {
    toKill.add(root);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of children.get(cur) ?? []) {
        if (!toKill.has(child)) {
          toKill.add(child);
          queue.push(child);
        }
      }
    }
  }

  let killed = 0;
  for (const pid of toKill) {
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* 已退出 */ }
  }
  return killed;
}

/** 启动时恢复上次未完成的任务 */
function recoverOrphanedTasks(): void {
  const activeTasks = taskLogsStore.listActive();
  if (activeTasks.length === 0) return;

  let resumed = 0;
  let killed = 0;

  for (const task of activeTasks) {
    if (task.status === 'pending') {
      // 用 path 查接口：接口删除后以相同 path 重建时 id 会变，按 id 查会误判「模板已删除」
      const iface = interfacesStore.getByPath(task.path);
      if (!iface) {
        taskLogsStore.updateResult(task.task_id, {
          status: 'failed' as TaskStatus,
          error_message: '服务重启：关联的接口模板已被删除',
          finished_at: nowLocal(),
          finished_ts: nowTs(),
        });
        killed++;
        continue;
      }

      let body: ProcessRequest;
      try {
        body = JSON.parse(task.request_body);
      } catch {
        // 请求体损坏：不能静默跳过，否则任务永远 pending、linkid 永久被占用
        taskLogsStore.updateResult(task.task_id, {
          status: 'failed' as TaskStatus,
          error_message: '服务重启：任务请求体数据损坏，无法恢复',
          finished_at: nowLocal(),
          finished_ts: nowTs(),
        });
        killed++;
        continue;
      }

      pending.push({
        task_id: task.task_id,
        path: task.path,
        iface,
        body,
        abortController: new AbortController(),
        lastActivity: 0,
      });
      resumed++;
    } else if (task.status === 'processing') {
      taskLogsStore.updateResult(task.task_id, {
        status: 'failed' as TaskStatus,
        error_message: '服务重启：任务被中断（原进程已退出）',
        finished_at: nowLocal(),
        finished_ts: nowTs(),
      });
      killed++;
    }
  }

  log.info({ resumed, killed }, 'task_queue_recovered');

  if (pending.length > 0) pump().catch(() => {});
}

export function enqueue(iface: AgentInterface, body: ProcessRequest): { task_id: string } {
  const taskId = uuid();
  const now = nowLocal();

  const logEntry: TaskLog = {
    task_id: taskId,
    linkid: body.linkid,
    session_id: null,
    path: iface.path,
    interface_id: iface.id,
    status: 'pending',
    request_body: JSON.stringify(body),
    request_response: null,
    prompt: '',
    sdk_output: null,
    error_message: null,
    created_at: now,
    finished_at: null,
    created_ts: nowTs(),
    finished_ts: null,
    started_ts: null,
  };
  taskLogsStore.create(logEntry);

  pending.push({
    task_id: taskId,
    path: iface.path,
    iface,
    body,
    abortController: new AbortController(),
    lastActivity: 0,
  });
  pump().catch(() => {});

  return { task_id: taskId };
}

export function getRunningCount(): number {
  return running;
}

export function getPendingCount(): number {
  return pending.length;
}

/**
 * 取消一个任务。
 * - pending：直接从队列移除。
 * - 已出队（处理中 / 链上等待）：通过 AbortController 中断；
 *   链上等待的任务会在 processItem 开头检测到 abort 并直接置为 cancelled。
 * 返回被取消的任务 id 对应的状态，或 null 表示未找到可取消的任务。
 */
export function cancelTask(taskId: string): { cancelled: 'pending' | 'processing' } | null {
  // 1) 已出队的任务：中断 SDK（或标记链上等待的任务）
  const activeItem = active.get(taskId);
  if (activeItem) {
    activeItem.abortController.abort();
    return { cancelled: 'processing' };
  }

  // 2) 排队中的任务：从 pending 数组移除
  const idx = pending.findIndex((item) => item.task_id === taskId);
  if (idx >= 0) {
    const item = pending[idx];
    pending.splice(idx, 1);
    item.abortController.abort(); // 防御性中断（任务已移除，无副作用）
    return { cancelled: 'pending' };
  }

  return null;
}

/**
 * 取消某 linkid 下所有还在内存队列中的任务（pending / 链上等待 / 处理中）。
 * 管理员删除会话时使用：先中断队列中的任务，再删工作目录，
 * 避免任务在已删除的目录中继续执行，或结束后把 cancelled 状态覆盖掉。
 */
export function cancelByLinkidInQueue(linkid: string): number {
  let count = 0;
  for (const item of active.values()) {
    if (item.body.linkid === linkid) {
      item.abortController.abort();
      count++;
    }
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].body.linkid === linkid) {
      pending[i].abortController.abort();
      pending.splice(i, 1);
      count++;
    }
  }
  return count;
}
