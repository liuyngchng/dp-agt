import { Router, Request, Response } from 'express';
import { taskLogsStore } from '../store.js';
import { getLogger } from '../logger.js';
import { nowReadable } from '../time.js';
import type { TaskLog } from '../types.js';

const log = getLogger();

export function createTasksRouter(): Router {
  const router = Router();

  // GET /api/v1/tasks — 查询进行中任务
  router.get('/api/v1/tasks', (req: Request, res: Response) => {
    const tasks = taskLogsStore.listActive();
    log.info({ from_ip: req.ip || '', count: tasks.length }, 'api_list_tasks');
    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: '',
      linkid: '',
      data: {
        total: tasks.length,
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          linkid: t.linkid,
          session_id: t.session_id,
          interface_path: t.path,
          status: t.status,
          callback_url: t.callback_url,
          created_at: t.created_at,
        })),
      },
    });
  });

  // DELETE /api/v1/tasks/:task_id — 取消任务
  router.delete('/api/v1/tasks/:task_id', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const fromIp = req.ip || '';
    const task = taskLogsStore.get(task_id);

    if (!task) {
      log.warn({ from_ip: fromIp, task_id }, 'api_cancel_task_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在或已结束', task_id: '', linkid: '' });
      return;
    }
    if (task.status !== 'pending') {
      log.warn({ from_ip: fromIp, task_id, status: task.status, linkid: task.linkid }, 'api_cancel_task_rejected');
      res.json({ code: 1001, message: '任务正在处理中，无法取消', task_id, linkid: task.linkid || '' });
      return;
    }

    taskLogsStore.updateStatus(task_id, 'cancelled');
    log.info({ from_ip: fromIp, task_id, linkid: task.linkid }, 'api_cancel_task_ok');
    res.json({ code: 0, message: '任务已取消', task_id, linkid: task.linkid || '' });
  });

  // GET /api/v1/task/trace?taskid=xxx — 任务追踪
  router.get('/api/v1/task/trace', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskid === 'string' ? req.query.taskid : '';
    const fromIp = req.ip || '';
    if (!taskId) {
      log.warn({ from_ip: fromIp }, 'api_task_trace_missing_taskid');
      res.status(400).json({ code: 1001, message: '缺少 taskid 参数', task_id: '', linkid: '' });
      return;
    }

    const task = taskLogsStore.get(taskId);
    if (!task) {
      log.warn({ from_ip: fromIp, task_id: taskId }, 'api_task_trace_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    log.info({ from_ip: fromIp, task_id: taskId, linkid: task.linkid, status: task.status }, 'api_task_trace');
    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        session_id: task.session_id,
        path: task.path,
        status: task.status,
        request_body: safeParse(task.request_body),
        prompt: task.prompt,
        sdk_output: task.sdk_output,
        callback_body: safeParse(task.callback_body),
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
      },
    });
  });

  // GET /api/v1/task/log/:task_id?format=json|html — 任务审计日志时间线
  router.get('/api/v1/task/log/:task_id', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const fromIp = req.ip || '';
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'html';

    const task = taskLogsStore.get(task_id);
    if (!task) {
      log.warn({ from_ip: fromIp, task_id }, 'api_task_log_not_found');
      if (format === 'html') {
        res.status(404).contentType('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>任务不存在</title>
<style>${TIMELINE_CSS}</style></head>
<body><div class="wrap"><div class="page-head"><h1>任务不存在</h1></div></div></body></html>`);
        return;
      }
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    const events = buildTimelineEvents(task);
    const linkid = task.linkid || '';

    log.info({ from_ip: fromIp, task_id, linkid, status: task.status, format, events: events.length }, 'api_task_log');

    if (format === 'html') {
      res.contentType('text/html; charset=utf-8').send(
        renderTimelineHtml(task, events, linkid)
      );
      return;
    }

    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        session_id: task.session_id,
        path: task.path,
        status: task.status,
        callback_url: task.callback_url,
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
        timeline: events,
      },
    });
  });

  // GET /api/v1/task/link/log/:linkid — 按 linkid 查最新一条任务时间线
  router.get('/api/v1/task/link/log/:linkid', (req: Request, res: Response) => {
    const { linkid } = req.params;
    const fromIp = req.ip || '';
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'html';

    const task = taskLogsStore.getLatestByLinkid(linkid);
    if (!task) {
      log.warn({ from_ip: fromIp, linkid }, 'api_task_link_log_not_found');
      if (format === 'html') {
        res.status(404).contentType('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>任务不存在</title>
<style>${TIMELINE_CSS}</style></head>
<body><div class="wrap"><div class="page-head"><h1>任务不存在</h1></div></div></body></html>`);
        return;
      }
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    const events = buildTimelineEvents(task);

    log.info({ from_ip: fromIp, task_id: task.task_id, linkid, status: task.status, format, events: events.length }, 'api_task_link_log');

    if (format === 'html') {
      res.contentType('text/html; charset=utf-8').send(
        renderTimelineHtml(task, events, linkid)
      );
      return;
    }

    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        session_id: task.session_id,
        path: task.path,
        status: task.status,
        callback_url: task.callback_url,
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
        timeline: events,
      },
    });
  });

  return router;
}

// ============================================================
// 时间线事件构建（去掉智能体执行过程，精简为关键节点）
// ============================================================

interface TimelineEvent {
  time: string | null;
  type: string;
  title: string;
  detail: string;
}

function buildTimelineEvents(task: TaskLog): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1. 任务创建
  events.push({
    time: task.created_at,
    type: 'create',
    title: '任务创建',
    detail: '访问路径: ' + (task.path || '-'),
  });

  // 2. 收到请求数据
  if (task.request_body) {
    events.push({
      time: task.created_at,
      type: 'input',
      title: '收到请求数据',
      detail: jsonFmt(task.request_body),
    });
  }

  // 3. 我方响应
  if (task.request_response) {
    events.push({
      time: task.created_at,
      type: 'output',
      title: '返回同步响应',
      detail: jsonFmt(task.request_response),
    });
  }

  // 4. 渲染提示词
  if (task.prompt) {
    events.push({
      time: task.created_at,
      type: 'prompt',
      title: '渲染提示词',
      detail: task.prompt,
    });
  }

  // 5. Agent 输出结果
  if (task.sdk_output) {
    events.push({
      time: task.finished_at,
      type: 'output',
      title: 'Agent 输出结果',
      detail: task.sdk_output,
    });
  }

  // 6. 回调对方 URL
  if (task.callback_url) {
    let detail = 'POST ' + task.callback_url;
    if (task.callback_body) {
      detail += '\n\n回调体:\n' + jsonFmt(task.callback_body);
    }
    if (task.callback_response) {
      detail += '\n\n回调响应:\n' + jsonFmt(task.callback_response);
    }
    events.push({
      time: task.finished_at,
      type: 'callback',
      title: '回调对方 URL',
      detail,
    });
  }

  // 7. 完成 / 失败
  const finalTitle = statusText(task.status);
  const finalType =
    task.status === 'completed' ? 'done' :
    task.status === 'failed' || task.status === 'callback_fail' ? 'error' :
    'info';
  events.push({
    time: task.finished_at,
    type: finalType,
    title: finalTitle,
    detail: task.error_message || '',
  });

  return events;
}

// ============================================================
// HTML 时间线页面渲染
// ============================================================

const TIMELINE_CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f6fa;color:#333;padding:40px 20px}
.wrap{max-width:960px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden}
.page-head{padding:28px 36px;background:linear-gradient(to right,#4b6cb7,#182848);color:#fff}
.page-head h1{font-size:1.4rem;display:flex;align-items:center;gap:10px}
.page-head .meta{margin-top:10px;font-size:.85rem;opacity:.85;display:flex;flex-direction:column;gap:6px}
.meta-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.meta-label{font-weight:600;opacity:.9}
.tl{padding:28px 36px}
.item{display:flex;gap:14px;padding:14px 0;border-left:2px solid #e0e0e0;margin-left:8px;position:relative}
.item:last-child{border-left-color:transparent}
.dot{width:16px;height:16px;border-radius:50%;background:#4b6cb7;flex-shrink:0;margin-left:-9px;margin-top:2px;position:relative;z-index:1}
.item.error .dot{background:#e53e3e}
.body{flex:1;min-width:0}
.ihead{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:.92rem}
.time{font-family:monospace;font-size:.78rem;color:#888;white-space:nowrap}
.detail{background:#f7f8fa;border-radius:6px;padding:12px 16px;margin-top:8px;font-size:.82rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto;border:1px solid #edf2f7}
.foot{padding:16px 36px;border-top:1px solid #edf2f7;font-size:.78rem;color:#999;text-align:center}`;

function renderTimelineHtml(task: TaskLog, events: TimelineEvent[], linkid: string): string {
  const itemsHtml = events.map((ev, i) => {
    const timeStr = ev.time ? fmtTs(ev.time) : '';
    const detailBlock = ev.detail
      ? `<pre class="detail">${escHtml(ev.detail)}</pre>`
      : '';
    return `<div class="item ${ev.type}">
        <div class="dot"></div>
        <div class="body">
          <div class="ihead"><span class="time">${escHtml(timeStr)}</span><strong>${i + 1}. ${escHtml(ev.title)}</strong></div>
          ${detailBlock}
        </div>
      </div>`;
  }).join('\n');

  const title = task.request_body ? (() => {
    try {
      const obj = JSON.parse(task.request_body);
      return (obj.form_data && (obj.form_data.title || obj.form_data['标题'])) || obj.title || obj['标题'] || '-';
    } catch { return '-'; }
  })() : '-';
  const startStr = fmtTs(task.created_at);
  const endStr = task.finished_at ? fmtTs(task.finished_at) : '处理中';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>任务执行时间线 — ${escHtml(linkid)}</title>
<style>${TIMELINE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="page-head">
    <h1>&#129302; 任务执行时间线</h1>
    <div class="meta">
      <div class="meta-line"><span class="meta-label">标题:</span> ${escHtml(title)}</div>
      <div class="meta-line"><span class="meta-label">执行周期:</span> ${escHtml(startStr)} ~ ${escHtml(endStr)}</div>
      <div class="meta-line"><span class="meta-label">Task ID:</span> ${escHtml(task.task_id)} <span class="meta-label">Link ID:</span> ${escHtml(linkid)}</div>
    </div>
  </div>
  <div class="tl">${itemsHtml}</div>
  <div class="foot">Powered by AI 数字员工</div>
</div>
</body>
</html>`;
}

// ============================================================
// helpers
// ============================================================

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function jsonFmt(v: unknown): string {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

function now(): string {
  return nowReadable();
}

function statusText(s: string): string {
  const map: Record<string, string> = {
    pending: '排队中',
    processing: '处理中',
    failed: '失败',
    completed: '已完成',
    callback_fail: '回调失败',
    cancelled: '已取消',
  };
  return map[s] || s || '-';
}

function escHtml(s: string | null): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTs(s: string | null): string {
  if (!s) return '-';
  if (/^\d{2}:\d{2}:\d{2}/.test(s) || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const p = (n: number) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return s;
  }
}