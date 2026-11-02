import { Router, Request, Response } from 'express';
import { interfacesStore, taskLogsStore } from '../store.js';
import { enqueue, getRunningCount, getPendingCount } from '../services/task-queue.js';
import { getLogger } from '../logger.js';
import { nowReadable } from '../time.js';
import type { ProcessRequest, AgentInterface } from '../types.js';
import type { Config } from '../config.js';

const log = getLogger();

/** 通用任务提交逻辑：校验接口、队列上限，然后入队。模拟操作和对外接口都走这一套。 */
export function submitTask(interfacePath: string, body: Record<string, unknown>, cfg: Config): {
  status: number;
  body: Record<string, unknown>;
} {
  if (!interfacePath) {
    return { status: 404, body: buildResponse(1001, '缺少访问路径', '', '') };
  }

  const iface = interfacesStore.getByPath(interfacePath);
  if (!iface) {
    return { status: 404, body: buildResponse(1001, '访问路径不存在: ' + interfacePath, '', '') };
  }

  if (!body || typeof body !== 'object') {
    return { status: 400, body: buildResponse(1001, '请求体不能为空', '', '') };
  }

  const linkid = (body.linkid as string) || '';
  if (!linkid) {
    return { status: 400, body: buildResponse(1001, '缺少 linkid', '', '') };
  }

  // 同一 linkid 有未完成的任务时拒绝，防止重复投递
  if (taskLogsStore.hasActiveByLinkid(linkid)) {
    return { status: 409, body: buildResponse(2003, '该公文尚有任务正在处理中，请等待完成后再次提交', '', linkid) };
  }

  // 检查队列上限
  const maxPending = cfg.sys.max_pending_tasks;
  const activeCount = getRunningCount() + getPendingCount();
  if (activeCount >= maxPending) {
    const msg = '任务队列已满，当前处理中任务数 ' + activeCount + '/' + maxPending +
      '（最大并发 ' + cfg.sys.max_concurrent_tasks + '，最大排队 ' + maxPending + '），请稍后重试';
    return { status: 503, body: buildResponse(2002, msg, '', linkid) };
  }

  // 入队
  const { task_id } = enqueue(iface, body as ProcessRequest);
  const resp = buildResponse(0, 'success', task_id, linkid);
  taskLogsStore.updateResult(task_id, { request_response: JSON.stringify(resp) });
  return { status: 200, body: resp };
}

export function createProcessRouter(cfg: Config): Router {
  const router = Router();

  // POST /api/v1/:path — 通配路由，path 可以是 document/classify 等任意路径
  router.post('/api/v1/*', (req: Request, res: Response) => {
    const interfacePath = req.params[0] || '';
    const fromIp = req.ip || '';

    log.debug({ from_ip: fromIp, path: interfacePath, body: req.body }, 'request_received');

    const result = submitTask(interfacePath, req.body as Record<string, unknown>, cfg);

    if (result.status >= 400) {
      log.warn({ from_ip: fromIp, path: interfacePath, request: req.body, response: result.body }, 'request_rejected');
    } else {
      log.info({ from_ip: fromIp, task_id: result.body.task_id, linkid: result.body.linkid, path: interfacePath, response: result.body }, 'api_request_completed');
    }

    res.status(result.status).json(result.body);
  });

  return router;
}

function buildResponse(code: number, message: string, taskId: string, linkid: string) {
  const resp: Record<string, unknown> = {
    code,
    timestamp: nowReadable(),
    message,
  };
  if (taskId) resp.task_id = taskId;
  if (linkid) resp.linkid = linkid;
  return resp;
}