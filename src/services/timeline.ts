// ═══════════════════════════════════════════════════════════════════
// 任务时间线构建 — 后端共享逻辑（admin.ts / tasks.ts 共用）
// ═══════════════════════════════════════════════════════════════════

import type { TaskLog } from '../types.js';

export interface TimelineEvent {
  time: string | null;
  type: string;
  title: string;
  detail: string;
}

interface SdkMessage {
  type?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
    }>;
  };
}

export function statusText(s: string): string {
  const map: Record<string, string> = {
    pending: '排队中',
    processing: '处理中',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
  };
  return map[s] || s || '-';
}

export function buildTimelineEvents(task: TaskLog): TimelineEvent[] {
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

  // 6. 结果回调（从 SDK trace 中提取 Bash curl 记录）
  const cbEvent = tryExtractCallbackFromTrace(task.sdk_trace, task.finished_at);
  if (cbEvent) events.push(cbEvent);

  // 7. 完成 / 失败
  const finalTitle = statusText(task.status);
  const finalType =
    task.status === 'completed' ? 'done' :
    task.status === 'failed' ? 'error' :
    'info';
  events.push({
    time: task.finished_at,
    type: finalType,
    title: finalTitle,
    detail: task.error_message || '',
  });

  return events;
}

// 会话处理时间线：只保留每个任务的「Agent 输出结果」，不展示请求体/提示词/回调等细节
export function buildOutputOnlyEvents(task: TaskLog): TimelineEvent[] {
  if (!task.sdk_output) return [];
  return [{
    time: task.finished_at,
    type: 'output',
    title: 'Agent 输出结果',
    detail: task.sdk_output,
  }];
}

export function tryExtractCallbackFromTrace(
  sdkTrace: string | null,
  fallbackTime: string | null,
): TimelineEvent | null {
  if (!sdkTrace) return null;
  let messages: SdkMessage[];
  try { messages = JSON.parse(sdkTrace); } catch { return null; }
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const callbackIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
      const cmd = typeof block.input?.command === 'string' ? block.input.command : '';
      if (cmd.includes('/tmp/callback_payload') || cmd.includes('callback')) {
        if (block.id) callbackIds.add(block.id);
      }
    }
  }
  if (callbackIds.size === 0) return null;

  const results: Array<{ toolId: string; content: string }> = [];
  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      if (block.tool_use_id && !callbackIds.has(block.tool_use_id)) continue;
      const raw = block.content;
      if (typeof raw === 'string') {
        results.push({ toolId: block.tool_use_id ?? '', content: raw });
      } else if (Array.isArray(raw)) {
        results.push({ toolId: block.tool_use_id ?? '', content: raw.map((c: Record<string, unknown>) =>
          typeof c.text === 'string' ? c.text : JSON.stringify(c)
        ).join('') });
      }
    }
  }
  if (results.length === 0) return null;

  const allOk = results.every(r => !r.content.includes('curl: (') && !r.content.includes('command failed') && !r.content.includes('Error'));
  let detail = results.map(r => r.content.trim()).join('\n\n---\n\n');
  if (results.length > 1) detail = results.map((r, i) => `[${i + 1}]\n${r.content.trim()}`).join('\n\n');

  return {
    time: fallbackTime,
    type: allOk ? 'done' : 'error',
    title: allOk ? '回调成功' : '回调失败',
    detail,
  };
}

function jsonFmt(v: unknown): string {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

// ============================================================
// HTML / Markdown 渲染（会话处理时间线，按 linkid 聚合）
// ============================================================

export interface HistoryTaskView {
  task_id: string;
  session_id: string | null;
  title?: string;
  path: string;
  status: string;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  events: TimelineEvent[];
}

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
.item.done .dot{background:#2e7d32}
.body{flex:1;min-width:0}
.ihead{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:.92rem}
.time{font-family:monospace;font-size:.78rem;color:#888;white-space:nowrap}
.detail{background:#f7f8fa;border-radius:6px;padding:12px 16px;margin-top:8px;font-size:.82rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto;border:1px solid #edf2f7}
.foot{padding:16px 36px;border-top:1px solid #edf2f7;font-size:.78rem;color:#999;text-align:center}`;

export function renderHistoryHtml(linkid: string, tasks: HistoryTaskView[]): string {
  const taskBlocks = tasks.map((t, idx) => {
    // 会话处理时间线只保留「Agent 输出结果」，直接内嵌到分组头部下方，点击头部展开
    const outputEv = (t.events || []).find(e => e.type === 'output') || (t.events || [])[0];
    const outputDetail = outputEv && outputEv.detail ? outputEv.detail : '';

    const endStr = t.finished_at ? fmtTs(t.finished_at) : '处理中';
    const statusCls = t.status === 'completed' ? 'done' : (t.status === 'failed' ? 'error' : 'info');

    const head = `<strong>${idx + 1}.</strong>
        <span class="time">${escHtml(endStr)}</span>
        <span>${escHtml(statusText(t.status))}</span>
        <span style="font-family:monospace;font-size:0.78rem;">Task ID: ${escHtml(t.task_id)}</span>`;

    if (!outputDetail) {
      return `<div class="task-group">
        <div class="task-group-head ${statusCls}">${head}</div>
      </div>`;
    }

    return `<details class="task-group">
      <summary class="task-group-head ${statusCls}">${head}</summary>
      <div class="tl"><pre class="detail">${escHtml(outputDetail)}</pre></div>
    </details>`;
  }).join('\n');

  const firstStart = tasks[0] ? fmtTs(tasks[0].created_at) : '-';
  const lastEnd = tasks[tasks.length - 1]?.finished_at ? fmtTs(tasks[tasks.length - 1].finished_at) : '处理中';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>会话处理时间线 — ${escHtml(linkid)}</title>
<style>${TIMELINE_CSS}
.task-group{border:1px solid #e0e3e8;border-radius:10px;margin-bottom:24px;overflow:hidden}
.task-group-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 20px;background:#fafbfc;border-bottom:1px solid #edf2f7;font-size:0.85rem;cursor:pointer}
.task-group-head.done{border-left:4px solid #2e7d32}
.task-group-head.error{border-left:4px solid #e53e3e}
.task-group-head.info{border-left:4px solid #4b6cb7}
details.task-group > summary{list-style:none}
details.task-group > summary::-webkit-details-marker{display:none}
details.task-group[open] > summary{border-bottom:1px solid #edf2f7}
.task-group .tl{padding:12px 24px}
</style>
</head>
<body>
<div class="wrap">
  <div class="page-head">
    <h1>&#129302; 会话处理时间线</h1>
    <div class="meta">
      <div class="meta-line"><span class="meta-label">Link ID:</span> ${escHtml(linkid)}</div>
      <div class="meta-line"><span class="meta-label">处理次数:</span> ${tasks.length}</div>
      <div class="meta-line"><span class="meta-label">时间范围:</span> ${escHtml(firstStart)} ~ ${escHtml(lastEnd)}</div>
    </div>
  </div>
  <div style="padding:28px 36px;">${taskBlocks}</div>
  <div class="foot">Powered by AI 数字员工</div>
</div>
</body>
</html>`;
}

export function renderHistoryMd(linkid: string, tasks: HistoryTaskView[]): string {
  const lines: string[] = [];
  lines.push(`# 会话处理时间线 — ${linkid}`);
  lines.push('');
  lines.push(`- Link ID: ${linkid}`);
  lines.push(`- 处理次数: ${tasks.length}`);
  lines.push('');

  tasks.forEach((t, idx) => {
    const endStr = t.finished_at ? fmtTs(t.finished_at) : '处理中';
    lines.push(`## ${idx + 1}. ${endStr} ${statusText(t.status)} Task ID: ${t.task_id}`);
    lines.push('');
    t.events.forEach((ev) => {
      if (ev.detail) {
        // 内容本身是 markdown，直接嵌入会破坏外层文档结构
        // 用围栏代码块包裹，围栏长度取内容中最长连续反引号段 + 1
        const maxBT = maxBacktickRun(ev.detail);
        const fence = '`'.repeat(Math.max(3, maxBT + 1));
        lines.push('');
        lines.push(`${fence}markdown`);
        lines.push(ev.detail);
        lines.push(fence);
      }
      lines.push('');
    });
  });

  return lines.join('\n');
}

function escHtml(s: string | null): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function maxBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === '`') { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
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