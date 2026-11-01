/**
 * 异步任务队列
 *
 * 基于 Promise 的轻量内存队列，配合 SQLite 持久化状态。
 * - 按 linkid 串行化：同一公文的多次提交排队顺序执行，保证 session 不冲突。
 * - 不同 linkid 之间仍可并发（受 max_concurrent_tasks 限制）。
 */
import { v4 as uuid } from 'uuid';
import { getLogger } from '../logger.js';
import { taskLogsStore, interfacesStore, sessionsStore } from '../store.js';
import { renderPrompt, loadPromptFromDisk } from './prompt-engine.js';
import { runAgent } from './sdk-runner.js';
import { deliverCallback } from './callback.js';
import { nowReadable, nowTs } from '../time.js';
import type { Config } from '../config.js';
import type { AgentInterface, ProcessRequest, TaskLog, TaskStatus } from '../types.js';

const log = getLogger();

type WorkerItem = {
  task_id: string;
  path: string;
  iface: AgentInterface;
  body: ProcessRequest;
};

let cfg: Config;
let running = 0;
const pending: WorkerItem[] = [];

// ── per-linkid 串行化 ──
const linkChains = new Map<string, Promise<void>>();

function nowLocal(): string {
  return nowReadable();
}

async function processItem(item: WorkerItem): Promise<void> {
  const { task_id, path: interfacePath, iface, body } = item;
  const linkid = body.linkid;

  // 状态 → processing
  taskLogsStore.updateStatus(task_id, 'processing');
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
  const rendered = renderPrompt(template, body as unknown as Record<string, unknown>);
  taskLogsStore.updateResult(task_id, { prompt: rendered });

  // 查 sessions 表：同一 linkid 是否有已存在的 session
  const existingSession = sessionsStore.getByLinkid(linkid);
  const resumeSessionId = existingSession?.session_id;

  if (resumeSessionId) {
    log.info({ task_id, linkid, sessionId: resumeSessionId }, 'session_resume');
  }

  // 调用 Claude Code Agent SDK。
  // 通过 onSessionId 回调在首条流式消息拿到 session_id 的瞬间就写入 DB，
  // 这样任务仍在 processing 时，前端「对话」按钮就能实时看到会话。
  const result = await runAgent(linkid, task_id, rendered, cfg, resumeSessionId, (sessionId) => {
    sessionsStore.upsert(sessionId, linkid);
    taskLogsStore.updateResult(task_id, { session_id: sessionId });
  });

  // 兜底：若 onSessionId 未触发（例如异常路径），任务结束后再写一次
  if (result.sessionId) {
    sessionsStore.upsert(result.sessionId, linkid);
  }

  if (!result.success) {
    // LLM 调用本身失败
    const errMsg = result.errorMessage || 'Claude 处理失败';
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      session_id: result.sessionId || null,
      sdk_output: result.rawOutput,
      error_message: errMsg,
      finished_at: nowLocal(),
    });

    const failPayload = buildResponse(5000, errMsg, task_id, body.linkid, null);
    const cbResult = await deliverCallback(body.callback_url, failPayload, cfg);
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      callback_body: cbResult.body,
      callback_response: cbResult.responseBody,
    });
    log.error({ task_id, linkid, error: errMsg }, 'task_failed');
    return;
  }

  // LLM 成功 — 暂不修改 status，等回调完成再统一设
  taskLogsStore.updateResult(task_id, {
    session_id: result.sessionId || null,
    sdk_output: result.rawOutput,
  });

  // 尝试解析 Claude 输出的 JSON
  let parsedData: unknown;
  try {
    parsedData = extractJson(result.rawOutput);
  } catch {
    // 解析失败，用 raw 字符串
    parsedData = { raw_output: result.rawOutput };
  }

  // 回调
  const successPayload = buildResponse(0, 'success', task_id, body.linkid, parsedData);
  const cbResult = await deliverCallback(body.callback_url, successPayload, cfg);

  const finalStatus: TaskStatus = cbResult.success ? 'completed' : 'callback_fail';
  taskLogsStore.updateResult(task_id, {
    status: finalStatus,
    callback_body: cbResult.body,
    callback_response: cbResult.responseBody,
    finished_at: nowLocal(),
    ...(cbResult.errorMsg ? { error_message: cbResult.errorMsg } : {}),
  });

  log.info({ task_id, linkid, status: finalStatus }, 'task_done');
}

async function pump(): Promise<void> {
  const maxConcurrent = cfg.sys.max_concurrent_tasks;
  const maxPending = cfg.sys.max_pending_tasks;
  while (running < maxConcurrent && pending.length > 0) {
    const item = pending.shift()!;
    if (running >= maxPending) {
      pending.unshift(item);
      break;
    }
    running++;

    // per-linkid 串行化：挂到该 linkid 的 Promise 链后面
    const prev = linkChains.get(item.body.linkid) ?? Promise.resolve();
    const next = prev
      .then(() => processItem(item))
      .catch(() => { /* processItem 内部已 catch，不抛到外层 */ })
      .finally(() => {
        running--;
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
}

/** 启动时恢复上次未完成的任务 */
function recoverOrphanedTasks(): void {
  const active = taskLogsStore.listActive();
  if (active.length === 0) return;

  let resumed = 0;
  let killed = 0;

  for (const task of active) {
    if (task.status === 'pending') {
      const iface = interfacesStore.get(task.interface_id || '');
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
      try { body = JSON.parse(task.request_body); } catch { continue; }

      pending.push({ task_id: task.task_id, path: task.path, iface, body });
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
    callback_body: null,
    callback_response: null,
    callback_url: body.callback_url,
    error_message: null,
    created_at: now,
    finished_at: null,
    created_ts: nowTs(),
    finished_ts: null,
  };
  taskLogsStore.create(logEntry);

  pending.push({ task_id: taskId, path: iface.path, iface, body });
  pump().catch(() => {});

  return { task_id: taskId };
}

export function getRunningCount(): number {
  return running;
}

export function getPendingCount(): number {
  return pending.length;
}

// ============================================================
// helpers
// ============================================================

/** 从 Claude 输出中提取 JSON 对象 */
function extractJson(text: string): unknown {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) return JSON.parse(jsonBlock[1].trim());

  const codeBlock = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlock) return JSON.parse(codeBlock[1].trim());

  return JSON.parse(text.trim());
}

function buildResponse(
  code: number,
  message: string,
  taskId: string,
  linkid: string,
  data: unknown,
) {
  return {
    code,
    timestamp: nowReadable(),
    message,
    task_id: taskId,
    linkid,
    data: data ?? {},
  };
}