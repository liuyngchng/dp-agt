/**
 * 异步任务队列
 *
 * 基于 Promise 的轻量内存队列，配合 SQLite 持久化状态。
 * - 按 linkid 串行化：同一公文的多次提交排队顺序执行，保证 session 不冲突。
 * - 不同 linkid 之间仍可并发（受 max_concurrent_tasks 限制）。
 */
import { v4 as uuid } from 'uuid';
import { getLogger } from '../logger.js';
import { taskLogsStore, interfacesStore, sessionsStore, sdkTracesStore } from '../store.js';
import { renderPrompt, loadPromptFromDisk } from './prompt-engine.js';
import { runAgent, taskWorkDir, buildClaudeMd, buildEnv } from './sdk-runner.js';
import { killTaskProcessTree } from './process-tree.js';
import { publish } from './sse-bus.js';
import { nowReadable, nowTs } from '../time.js';
import { selectRunner, markDispatched, markFinished, hasRemoteRunners, getRunnerHttpConfig } from './dispatcher.js';
import { streamRun, cancelRunnerTask } from './runner-client.js';
import type { RunFrame, RunResult } from './runner-protocol.js';
import type { Config } from '../config.js';
import type { AgentInterface, ProcessRequest, TaskLog, TaskStatus, RunRequest, RunSdkOptions } from '../types.js';
import type { SdkResult } from './sdk-runner.js';

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
  /** 任务被派发到的 runner id（远端模式；本地模式为 null） */
  runnerId?: string | null;
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
    const preferredRunnerId = existingSession?.runner_id; // session 亲和

    if (resumeSessionId) {
      sessionsStore.touch(resumeSessionId);
      log.info({ task_id, linkid, sessionId: resumeSessionId }, 'session_resume');
    }

    // ── 滑动超时（arm）│ 阈值 = cfg.llm.timeout_ms ──
    const hardTimeoutMs = cfg.llm.timeout_ms;
    const armTimeout = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
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

    // ═══════════════════════════════════════════════════════════════
    // 选路：有远端 runner → 派发；无 → 本地执行
    // ═══════════════════════════════════════════════════════════════
    const useRemote = hasRemoteRunners();

    let capturedSessionId: string | undefined;
    let result: SdkResult | null = null;

    if (useRemote) {
      result = await dispatchToRunner(
        linkid, task_id, rendered, cfg, existingSession, preferredRunnerId, item,
        (sid) => { capturedSessionId = sid; },
        abortController.signal,
        () => { item.lastActivity = nowTs(); armTimeout(); },
        () => { timeoutFired = true; },   // markTimeout: 控制面滑动超时触发
      );
    } else {
      result = await runAgent(
        linkid, task_id, rendered, cfg, resumeSessionId,
        (sid) => {
          capturedSessionId = sid;
          sessionsStore.upsert(sid, linkid);
          taskLogsStore.updateResult(task_id, { session_id: sid });
        },
        abortController.signal,
        () => { item.lastActivity = nowTs(); armTimeout(); },
      );
    }

    const wasAborted = abortController.signal.aborted;

    // 兜底：若 onSessionId 未触发（例如异常路径），任务结束后再写一次。
    if (result.sessionId && !wasAborted) {
      sessionsStore.upsert(result.sessionId, linkid);
    }

    // 被管理员手动停止：状态应记为 cancelled
    if (wasAborted && !timeoutFired && !item.watchdogKilled) {
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

/** 把一次任务派发给远端 runner，解析 NDJSON 帧，收尾返回 SdkResult */
function dispatchToRunner(
  linkid: string,
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
  existingSession: { session_id: string; runner_id: string | null } | undefined,
  preferredRunnerId: string | undefined | null,
  item: WorkerItem,
  onSessionId: (sessionId: string) => void,
  abortSignal: AbortSignal,
  onActivity: () => void,
  markTimeout: () => void,
): Promise<SdkResult> {
  const httpCfg = getRunnerHttpConfig();
  const sdkOptions: RunSdkOptions = {
    model: cfg.llm.model,
    max_turns: cfg.llm.max_turns,
    effort_level: cfg.llm.effort_level,
    disable_nonessential_traffic: cfg.llm.disable_nonessential_traffic,
    attribution_header: cfg.llm.attribution_header,
    auto_mode_server: cfg.llm.auto_mode_server,
  };

  // 非 resume 时异步构建 claude_md（它读 data/memory/ 和 prompt_config，控制面环境）
  return buildClaudeMdForDispatch(existingSession, cfg).then((claudeMd) => {
    const runReq: RunRequest = {
      task_id: taskId,
      linkid,
      mode: 'task',
      prompt: renderedPrompt,
      claude_md: claudeMd,
      resume_session_id: existingSession?.session_id ?? null,
      sdk_options: sdkOptions,
      env: buildEnv(cfg, true) as Record<string, string>, // skipClaudeConfigDir = true
    };

    return new Promise<SdkResult>((resolve) => {
      // 首次派发允许在「未收到 session 帧」前换一台重试一次
      attemptDispatch(preferredRunnerId ?? undefined, true);
      let abortHandler: (() => void) | undefined;

      function attemptDispatch(affinityRunnerId: string | undefined, allowRetry: boolean): void {
        const runner = selectRunner(linkid, affinityRunnerId);
        if (!runner) {
          resolve({
            success: false, rawOutput: '', trace: '[]',
            errorMessage: '无可用的远端 runner（所有 runner 已下线或容量已满）', durationMs: 0,
          });
          return;
        }

        const runnerId = runner.id;
        item.runnerId = runnerId;
        markDispatched(runnerId);
        taskLogsStore.updateResult(taskId, { runner_id: runnerId });
        log.info({ taskId, linkid, runner: runner.name }, 'runner_dispatch_start');

        let capturedSid: string | undefined;
        let sessionReceived = false;
        let resultReceived = false;

        const stream = streamRun(runner.addr, runReq, httpCfg,
          (frame: RunFrame) => {
            switch (frame.type) {
              case 'session': {
                sessionReceived = true;
                capturedSid = frame.session_id;
                onSessionId(capturedSid);
                sessionsStore.upsert(capturedSid, linkid, runnerId);
                taskLogsStore.updateResult(taskId, { session_id: capturedSid });
                break;
              }
              case 'resume_gone': {
                // runner 侧 session 已丢失，关闭 DB 记录；本次由 runner 降级为新建继续
                sessionsStore.close(frame.session_id);
                break;
              }
              case 'msg': {
                onActivity();
                // 只有拿到 session_id 后才推送 SSE（前端按 session 订阅）
                if (capturedSid) publish(capturedSid, frame.message);
                break;
              }
              case 'result': {
                resultReceived = true;
                const r = frame.result as RunResult;
                markFinished(runnerId);
                resolve({
                  success: r.success,
                  rawOutput: r.rawOutput,
                  trace: r.trace,
                  sessionId: r.sessionId,
                  errorMessage: r.errorMessage,
                  durationMs: r.durationMs,
                  aborted: r.aborted,
                });
                break;
              }
            }
          },
          (err?: Error) => {
            // 连接断开 / 出错（result 帧已收到则早已 resolve，此处为防御）
            if (resultReceived) return;
            markFinished(runnerId);

            // 收到 session 帧 → 任务已开跑，不重试，避免同一 linkid 双跑
            if (sessionReceived) {
              resolve({
                success: false, rawOutput: '', trace: '[]',
                sessionId: capturedSid,
                errorMessage: err ? ('runner 连接中断: ' + err.message) : 'runner 连接中断',
                durationMs: 0,
                aborted: abortSignal.aborted,
              });
              return;
            }

            // 未收到 session 帧 → runner 没开始跑，可换一台重试一次
            if (allowRetry && !abortSignal.aborted) {
              log.warn({ taskId, linkid, runner: runner.name, error: err?.message }, 'runner_dispatch_pre_session_failed_retry');
              attemptDispatch(undefined, false);
              return;
            }

            resolve({
              success: false, rawOutput: '', trace: '[]',
              errorMessage: err ? ('runner 派发失败: ' + err.message) : 'runner 派发失败',
              durationMs: 0,
              aborted: abortSignal.aborted,
            });
          },
        );

        // 外部取消：先调 runner /cancel，再断本地连接，并标记超时/取消语义由 processItem 收尾
        abortHandler = () => {
          cancelRunnerTask(runner.addr, taskId, httpCfg).catch(() => {});
          stream.abort();
          markTimeout();
        };
        if (abortSignal.aborted) {
          abortHandler();
        } else {
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      // Promise resolve 后清理 abort 监听
      const origResolve = resolve;
      resolve = (v) => {
        if (abortHandler) abortSignal.removeEventListener('abort', abortHandler);
        origResolve(v);
      };
    });
  });
}

/** resume 时返回 null（不覆盖既有 CLAUDE.md），否则控制面构建一份完整 CLAUDE.md */
async function buildClaudeMdForDispatch(
  existingSession: { session_id: string } | undefined,
  cfg: Config,
): Promise<string | null> {
  if (existingSession?.session_id) return null;
  return buildClaudeMd(cfg.sys.data_dir);
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
  // 看门狗只在本地执行模式启用（远端模式下 SDK 在 runner 上跑，看门狗已搬到 runner）
  if (!hasRemoteRunners()) {
    startWatchdog();
  }
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

/** 强制终止一个任务工作目录下的 SDK 子进程树（实现见 ./process-tree.ts，供控制面与 runner 共用） */

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
    runner_id: null,
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
