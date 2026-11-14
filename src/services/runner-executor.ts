/**
 * Runner 本地任务执行器
 *
 * 接收 RunRequest → 本地跑 SDK → 通过 NDJSON 帧回传给控制面。
 * 负责滑动看门狗（hard kill SDK 进程树）与连接断开时的清理。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { getLogger } from '../logger.js';
import { runAgentCore, sanitizeDirName } from './sdk-core.js';
import { killTaskProcessTree } from './process-tree.js';
import { encodeFrame } from './runner-protocol.js';
import { nowTs } from '../time.js';
import type { RunRequest } from '../types.js';
import type { RunAgentInput, RunAgentHooks } from './sdk-core.js';

const log = getLogger();

export interface RunnerActiveTask {
  taskId: string;
  linkid: string;
  abortController: AbortController;
  lastActivity: number;        // 最后收到 SDK 消息的 Unix 毫秒
  watchdogKilled: boolean;
}

const active = new Map<string, RunnerActiveTask>();

const WATCHDOG_SWEEP_MS = 30_000;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

function startWatchdog(timeoutMs: number, graceMs: number): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    sweepStuckTasks(timeoutMs, graceMs);
  }, WATCHDOG_SWEEP_MS);
  watchdogTimer.unref();
}

function sweepStuckTasks(timeoutMs: number, graceMs: number): void {
  if (!timeoutMs || timeoutMs <= 0) return;
  const cutoff = nowTs() - timeoutMs - graceMs;

  for (const [taskId, item] of active) {
    if (item.watchdogKilled) continue;
    if (item.lastActivity <= 0) continue;
    if (item.lastActivity > cutoff) continue;

    log.warn({ taskId, linkid: item.linkid, timeoutMs, graceMs }, 'runner_watchdog_task_stuck');

    const workDir = join(process.env.RUNTIME_DIR ?? './runtime', 'tasks', sanitizeDirName(item.linkid));
    const killed = killTaskProcessTree(workDir);
    log.warn({ taskId, linkid: item.linkid, killed }, 'runner_watchdog_killed_process_tree');

    item.watchdogKilled = true;
    item.abortController.abort();
  }
}

export function runnerRunningCount(): number {
  return active.size;
}

export function runnerCancelTask(taskId: string): boolean {
  const item = active.get(taskId);
  if (!item) return false;
  item.abortController.abort();
  return true;
}

/** 清理指定 linkid 的任务（连接断开/主动取消时调用） */
export function runnerCancelByLinkid(linkid: string): number {
  let count = 0;
  for (const [taskId, item] of active) {
    if (item.linkid === linkid) {
      item.abortController.abort();
      count++;
    }
  }
  return count;
}

/**
 * 接收 RunRequest，执行 SDK 并通过 res（长连接）逐帧回传。
 * capacity 由调用方（runner 路由）在进入前校验；此函数不再检查。
 */
export async function runnerExecute(
  req: RunRequest,
  res: ServerResponse,
  execCfg: { timeoutMs: number; graceMs: number; capacity: number },
): Promise<void> {
  const { task_id, linkid, resume_session_id, prompt, claude_md, sdk_options, env } = req;
  const runtimeDir = process.env.RUNTIME_DIR ?? './runtime';
  const workDir = join(runtimeDir, 'tasks', sanitizeDirName(linkid));

  const abortController = new AbortController();
  const activeItem: RunnerActiveTask = {
    taskId: task_id,
    linkid,
    abortController,
    lastActivity: 0,
    watchdogKilled: false,
  };
  active.set(task_id, activeItem);

  // 确保看门狗已启动（lazy init，每个 runner 进程只需要启动一次）
  if (!watchdogTimer) startWatchdog(execCfg.timeoutMs, execCfg.graceMs);

  // 连接断开：取消 SDK + 清理
  res.on('close', () => {
    if (!abortController.signal.aborted) {
      log.info({ taskId: task_id, linkid }, 'runner_connection_closed_aborting');
      abortController.abort();
    }
    active.delete(task_id);
  });

  try {
    const input: RunAgentInput = {
      workDir,
      prompt,
      claudeMd: claude_md,
      resumeSessionId: resume_session_id || undefined,
      sdkOptions: sdk_options,
      env: env ?? {},
    };

    const hooks: RunAgentHooks = {
      onSessionId: (sessionId) => {
        // 首帧：告诉控制面 session_id，供后续写入 sessions 表
        res.write(encodeFrame({ type: 'session', session_id: sessionId }) + '\n');
      },
      onResumeGone: (oldSessionId) => {
        res.write(encodeFrame({ type: 'resume_gone', session_id: oldSessionId }) + '\n');
      },
      onMessage: (message) => {
        activeItem.lastActivity = nowTs();
        res.write(encodeFrame({ type: 'msg', message }) + '\n');
      },
      onActivity: () => {
        activeItem.lastActivity = nowTs();
      },
    };

    const result = await runAgentCore(linkid, task_id, input, abortController.signal, hooks);

    // 最后帧：结果
    res.write(encodeFrame({
      type: 'result',
      result: {
        ...result,
        watchdog_killed: activeItem.watchdogKilled,
      },
    }) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: task_id, linkid, error: msg }, 'runner_execute_unexpected_error');

    try {
      res.write(encodeFrame({
        type: 'result',
        result: {
          success: false,
          rawOutput: '',
          trace: '[]',
          sessionId: undefined,
          errorMessage: '任务执行异常: ' + msg,
          durationMs: 0,
          aborted: abortController.signal.aborted,
          watchdog_killed: activeItem.watchdogKilled,
        },
      }) + '\n');
    } catch { /* 连接已死，忽略 */ }
  } finally {
    // result 帧即为结束信号（控制面在收到 result 后释放 assigned 计数）。
    // 不需要额外的 end 帧——NDJSON 流结束时连接自然关闭。
    active.delete(task_id);
    try { res.end(); } catch { /* 连接已死，忽略 */ }
  }
}