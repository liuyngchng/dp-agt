import { gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { Router, Request, Response } from 'express';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { interfacesStore, taskLogsStore, configStore, usersStore, sessionsStore, hashPasswordSync, promptConfigStore, getDb, sdkTracesStore } from '../store.js';
import { subscribe, unsubscribe, sendSSE } from '../services/sse-bus.js';
import { cancelTask } from '../services/task-queue.js';
import { getLogger } from '../logger.js';
import { nowReadable } from '../time.js';
import { getCurrentUser, adminOnlyMiddleware, validatePasswordStrength } from './auth.js';
import { submitTask } from './process.js';

import multer from 'multer';
import { createGzip } from 'node:zlib';
import tarFs from 'tar-fs';
import tarStream from 'tar-stream';
import { loadPromptFromDisk, rescanPromptsDir, listAllPromptFiles } from '../services/prompt-engine.js';
import { buildEnv, buildClaudeMd } from '../services/sdk-runner.js';
import { buildOutputOnlyEvents, renderHistoryHtml, renderHistoryMd } from '../services/timeline.js';
import { listMemories, getMemory, saveMemory, deleteMemory, ensureMemoryDir } from '../services/memory-store.js';
import { xmindToMarkdown } from '../services/xmind.js';
import { syncInterfacesFromPrompts } from '../store.js';import type { Config } from '../config.js';
import type { TaskLog } from '../types.js';

const log = getLogger();

export function createAdminRouter(cfg: Config): Router {
  const router = Router();

  // === 导航信息（所有登录用户可访问） ===
  router.get('/admin/nav', (req: Request, res: Response) => {
    const cu = getCurrentUser(req);
    const isAdmin = cu?.role === 1;
    const tabs = [
      ...(isAdmin ? [
        { id: 'interfaces', icon: 'fa-brain', label: '模板管理' },
        { id: 'memory', icon: 'fa-memory', label: '记忆管理' },
        { id: 'simulate', icon: 'fa-flask', label: '操作模拟' },
        { id: 'tasks', icon: 'fa-list-alt', label: '任务监控' },
      ] : []),
      { id: 'audit', icon: 'fa-search', label: '任务审查' },
      ...(isAdmin ? [
        { id: 'sessions', icon: 'fa-comments', label: '会话管理' },
        { id: 'sys', icon: 'fa-sliders-h', label: '系统管理' },
        { id: 'users', icon: 'fa-users', label: '用户管理' },
      ] : []),
    ];
    const defaultTab = isAdmin ? 'interfaces' : 'audit';
    res.json({ code: 0, data: { role: isAdmin ? 1 : 0, default_tab: defaultTab, tabs } });
  });

  // === 服务器信息（所有登录用户可访问） ===
  router.get('/admin/server-info', (_req: Request, res: Response) => {
    const protocol = 'https';
    const host = cfg.server.self_ip || detectPrimaryIp();
    res.json({ code: 0, data: { protocol, host, port: cfg.server.port } });
  });

  // ============================================================
  // 以下仅管理员
  // ============================================================

  // ---- 访问路径管理 ----
  router.use('/admin/interfaces', adminOnlyMiddleware);
  router.use('/admin/mock', adminOnlyMiddleware);
  router.use('/admin/simulate', adminOnlyMiddleware);
  router.use('/admin/tasks', adminOnlyMiddleware);
  router.use('/admin/sys-config', adminOnlyMiddleware);
  router.use('/admin/prompt-config', adminOnlyMiddleware);
  router.use('/admin/prompt-tar', adminOnlyMiddleware);
  router.use('/admin/prompt-preview', adminOnlyMiddleware);
  router.use('/admin/memory', adminOnlyMiddleware);
  router.use('/admin/data-tables', adminOnlyMiddleware);

  // ---- Interfaces 列表 — 从 prompts/ 自动发现，DB 同步 ----
  router.get('/admin/interfaces', (_req: Request, res: Response) => {
    const allFiles = listAllPromptFiles();
    const list = allFiles.map(pf => {
      const iface = interfacesStore.getByPath(pf.path);
      return {
        id: iface?.id || '',
        name: pf.name,
        path: pf.path,
        prompt: pf.content || '',
        created_at: iface?.created_at || '',
        updated_at: iface?.updated_at || '',
      };
    });
    res.json({ code: 0, data: list });
  });

  // Interfaces 获取单个
  router.get('/admin/interfaces/:id', (req: Request, res: Response) => {
    const iface = interfacesStore.get(req.params.id);
    if (!iface) {
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
      return;
    }
    const prompt = loadPromptFromDisk(iface.path) || iface.prompt;
    res.json({ code: 0, data: { ...iface, prompt } });
  });

  // 创建
  router.post('/admin/interfaces', (req: Request, res: Response) => {
    const { name, path, prompt } = req.body as { name?: string; path?: string; prompt?: string };
    if (!name || !path || !prompt) {
      res.status(400).json({ code: 1001, message: '缺少 name / path / prompt' });
      return;
    }

    const existing = interfacesStore.getByPath(path);
    if (existing) {
      res.status(400).json({ code: 1001, message: '访问路径 path 已存在: ' + path });
      return;
    }

    const created = interfacesStore.create(name, path, prompt);
    log.info({ name, path }, 'interface_created');
    res.json({ code: 0, data: created });
  });

  // 更新
  router.put('/admin/interfaces/:id', (req: Request, res: Response) => {
    const { name, path, prompt } = req.body as { name?: string; path?: string; prompt?: string };
    if (!name || !path || !prompt) {
      res.status(400).json({ code: 1001, message: '缺少 name / path / prompt' });
      return;
    }

    const updated = interfacesStore.update(req.params.id, name, path, prompt);
    if (!updated) {
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
      return;
    }

    log.info({ name, path }, 'interface_updated');
    res.json({ code: 0, data: updated });
  });

  // 删除
  router.delete('/admin/interfaces/:id', (req: Request, res: Response) => {
    const ok = interfacesStore.remove(req.params.id);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
      return;
    }
    log.info({ id: req.params.id }, 'interface_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ---- 模拟操作 ----

  router.get('/admin/mock', (_req: Request, res: Response) => {
    const mockPaths = [
      resolve(process.cwd(), 'assets', 'mock.json'),          // Docker 镜像（第2类资源）
      join(cfg.sys.data_dir, 'mock.json'),                    // 开发模式兼容
    ];
    const mockFile = mockPaths.find(p => existsSync(p));
    if (!mockFile) {
      res.status(404).json({ code: 1001, message: 'mock.json 不存在' });
      return;
    }
    try {
      const raw = readFileSync(mockFile, 'utf8');
      const parsed = JSON.parse(raw);
      res.json({ code: 0, data: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ code: 1001, message: 'mock.json 解析失败: ' + msg });
    }
  });

  router.post('/admin/simulate', (req: Request, res: Response) => {
    const { interface_path, request_body } = req.body as {
      interface_path?: string;
      request_body?: Record<string, unknown>;
    };

    log.debug({ path: interface_path, body: request_body }, 'simulate_request_received');

    // 对外接口完全一致的逻辑：校验接口、队列上限、入队
    const result = submitTask(interface_path || '', request_body || {}, cfg);

    if (result.status >= 400) {
      log.warn({ path: interface_path, request: request_body, response: result.body }, 'simulate_request_rejected');
    } else {
      log.info({ task_id: result.body.task_id, linkid: result.body.linkid, path: interface_path, response: result.body }, 'simulate_task_enqueued');
    }

    res.status(result.status).json(result.body);
  });

  // ---- 任务监控 ----

  router.get('/admin/tasks', (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(parseInt(String(req.query.page_size), 10) || 10, 100);
    const { items, total } = taskLogsStore.listPaged((page - 1) * pageSize, pageSize);
    res.json({ code: 0, data: {
      total,
      page,
      page_size: pageSize,
      items: items.map((t) => ({
        task_id: t.task_id,
        linkid: t.linkid,
        session_id: t.session_id,
        session_status: t.session_id ? (sessionsStore.get(t.session_id)?.status ?? 'closed') : null,
        title: extractTitle(t.request_body),
        path: t.path,
        status: t.status,
        error_message: t.error_message,
        created_at: t.created_at,
        finished_at: t.finished_at,
      })),
    } });
  });

  router.get('/admin/tasks/:task_id', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    res.json({ code: 0, data: {
      ...task,
      title: extractTitle(task.request_body),
      request_body: safeParse(task.request_body),
      request_response: safeParse(task.request_response),
    }});
  });

  // 取消任务（支持 pending 和 processing）
  router.delete('/admin/tasks/:task_id', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const fromIp = req.ip || '';
    const task = taskLogsStore.get(task_id);

    if (!task) {
      log.warn({ from_ip: fromIp, task_id }, 'admin_cancel_task_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在或已结束' });
      return;
    }

    if (task.status !== 'pending' && task.status !== 'processing') {
      log.warn({ from_ip: fromIp, task_id, status: task.status }, 'admin_cancel_task_rejected');
      res.json({ code: 1001, message: '任务已结束，无法取消' });
      return;
    }

    const cancelled = cancelTask(task_id);

    if (cancelled?.cancelled === 'processing') {
      taskLogsStore.updateStatus(task_id, 'cancelled');
      log.info({ from_ip: fromIp, task_id, mode: 'processing' }, 'admin_cancel_task_ok');
      res.json({ code: 0, message: '任务停止中' });
      return;
    }

    if (cancelled?.cancelled === 'pending') {
      taskLogsStore.updateResult(task_id, {
        status: 'cancelled',
        error_message: '任务已被管理员取消',
        finished_at: nowReadable(),
      });
      log.info({ from_ip: fromIp, task_id, mode: 'pending' }, 'admin_cancel_task_ok');
      res.json({ code: 0, message: '任务已取消' });
      return;
    }

    log.warn({ from_ip: fromIp, task_id, status: task.status }, 'admin_cancel_task_noop');
    res.json({ code: 1001, message: '未找到可取消的任务' });
  });

  // ---- 会话记录（SDK 原生对话） ----

  // GET 一次性拉取（兼容已结束的任务）
  router.get('/admin/sessions/:session_id/messages', async (req: Request, res: Response) => {
    const { session_id } = req.params;
    if (!session_id) {
      res.status(400).json({ code: 1001, message: '缺少 session_id' });
      return;
    }

    const session = sessionsStore.get(session_id);
    const linkid = session?.linkid || '';
    const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(linkid));
    log.info({ session_id, linkid, workDir, dirExists: existsSync(workDir), sessionFound: !!session }, 'session_messages_request');

    try {
      const messages = await getSessionMessages(session_id, { dir: workDir, includeSystemMessages: false });
      log.info({ session_id, messageCount: messages.length }, 'session_messages_result');
      res.json({ code: 0, data: { session_id, messages } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ session_id, linkid, workDir, error: msg }, 'session_messages_error');
      res.status(500).json({ code: 1001, message: '读取会话记录失败: ' + msg });
    }
  });

  // SSE 实时推送（任务处理中时前端订阅）
  router.get('/admin/sessions/:session_id/stream', async (req: Request, res: Response) => {
    const { session_id } = req.params;
    if (!session_id) {
      res.status(400).json({ code: 1001, message: '缺少 session_id' });
      return;
    }

    const session = sessionsStore.get(session_id);
    const linkid = session?.linkid || '';
    const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(linkid));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
    });

    // 先推全量快照，前端据此渲染已有历史
    try {
      const messages = await getSessionMessages(session_id, { dir: workDir, includeSystemMessages: false });
      log.info({ session_id, linkid, workDir, dirExists: existsSync(workDir), sessionFound: !!session, messageCount: messages.length }, 'session_stream_snapshot');
      sendSSE(res, { type: 'snapshot', messages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ session_id, linkid, workDir, error: msg }, 'session_stream_snapshot_error');
      sendSSE(res, { type: 'error', message: msg });
    }

    const onMessage = (msg: unknown) => {
      // 任务结束信号：通知前端后关闭连接
      const m = msg as Record<string, unknown>;
      sendSSE(res, msg);
      if (m.type === 'end') {
        unsubscribe(session_id, onMessage);
        res.end();
      }
    };

    subscribe(session_id, onMessage);

    // 连接断开时清理
    req.on('close', () => {
      unsubscribe(session_id, onMessage);
    });
  });

  // ---- 会话管理（管理员） ----
  router.use('/admin/sessions', adminOnlyMiddleware);

  router.get('/admin/sessions', (_req: Request, res: Response) => {
    const list = sessionsStore.listAll();
    res.json({ code: 0, data: list });
  });

  router.delete('/admin/sessions/:session_id', (req: Request, res: Response) => {
    const { session_id } = req.params;
    const session = sessionsStore.get(session_id);
    if (!session) {
      res.status(404).json({ code: 1001, message: '会话不存在' });
      return;
    }
    const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(session.linkid));
    if (existsSync(workDir)) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 删除失败不阻塞 */ }
    }
    // 逻辑删除：该 linkid 下未完成任务标记为 cancelled，session 标记为 closed，
    // 使后续同一 linkid 重新提交时不再命中旧任务/旧会话。
    const cancelled = taskLogsStore.cancelByLinkid(session.linkid);
    sessionsStore.close(session_id);
    log.info({ session_id, linkid: session.linkid, workDir, cancelledTasks: cancelled }, 'session_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ---- 新建聊天：不绑定公文，发送首条消息并流式返回，session 由 SDK 真实创建 ----
  router.post('/admin/chat/new', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || !message.trim()) {
      res.status(400).json({ code: 1001, message: '缺少 message' });
      return;
    }
    const linkid = 'chat-' + uuidv4();
    const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(linkid));
    try {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'CLAUDE.md'), await buildClaudeMd(cfg.sys.data_dir), 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ linkid, workDir, error: msg }, 'chat_new_workdir_failed');
      res.status(500).json({ code: 1001, message: '创建聊天工作目录失败: ' + msg });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let capturedSessionId = '';
    try {
      const q = query({
        prompt: message,
        options: {
          cwd: workDir,
          permissionMode: 'bypassPermissions',
          tools: { type: 'preset', preset: 'claude_code' },
          model: cfg.llm.model,
          env: buildEnv(cfg),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      });

      for await (const m of q) {
        const sid = (m as Record<string, unknown>).session_id;
        if (!capturedSessionId && typeof sid === 'string' && sid) {
          capturedSessionId = sid;
          sessionsStore.upsert(sid, linkid);
          log.info({ sessionId: sid, linkid, workDir }, 'chat_new_session_created');
        }
        sendSSE(res, m);
      }
      sendSSE(res, { type: 'end', session_id: capturedSessionId, linkid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ linkid, workDir, error: msg }, 'chat_new_error');
      sendSSE(res, { type: 'error', message: msg });
    }
    res.end();
  });

  // ---- 会话续聊（debug 用）：复用原 session 上下文发送消息 ----
  router.post('/admin/sessions/:session_id/chat', async (req: Request, res: Response) => {
    const { session_id } = req.params;
    const { message } = req.body as { message?: string };
    if (!session_id || !message || !message.trim()) {
      res.status(400).json({ code: 1001, message: '缺少 session_id 或 message' });
      return;
    }
    const session = sessionsStore.get(session_id);
    if (!session) {
      log.warn({ session_id }, 'chat_session_not_found');
      res.status(404).json({ code: 1001, message: '会话不存在' });
      return;
    }
    const linkid = session.linkid;
    const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(linkid));
    log.info({ session_id, linkid, workDir, dirExists: existsSync(workDir) }, 'session_chat_start');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const q = query({
        prompt: message,
        options: {
          cwd: workDir,
          permissionMode: 'bypassPermissions',
          tools: { type: 'preset', preset: 'claude_code' },
          model: cfg.llm.model,
          env: buildEnv(cfg),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          resume: session_id,
        },
      });

      for await (const m of q) {
        sendSSE(res, m);
      }
      sendSSE(res, { type: 'end' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendSSE(res, { type: 'error', message: msg });
    }
    res.end();
  });

  // ============================================================
  // 以下所有登录用户可访问
  // ============================================================

  // ---- 任务审查 ----

  // 任务审查列表：默认最近 N 条；支持按 task_id 精确查询（limit 1）或 linkid 精确查询（limit 50）
  router.get('/admin/audit', (req: Request, res: Response) => {
    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id.trim() : '';
    const linkid = typeof req.query.linkid === 'string' ? req.query.linkid.trim() : '';
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(parseInt(String(req.query.page_size), 10) || 10, 100);

    let items: TaskLog[] = [];
    let total = 0;
    if (taskId) {
      // task_id 全局唯一，精确查询，只取一条
      const task = taskLogsStore.getLightByTaskId(taskId);
      if (task) {
        items = [task];
        total = 1;
      }
    } else if (linkid) {
      // 同一 linkid 可有多轮任务，精确匹配，最多 50 条
      items = taskLogsStore.listLightByLinkid(linkid);
      total = items.length;
    } else {
      // 最近 N 条（轻量列）
      const paged = taskLogsStore.listPaged((page - 1) * pageSize, pageSize);
      items = paged.items;
      total = paged.total;
    }

    res.json({
      code: 0,
      data: {
        total,
        page,
        page_size: pageSize,
        items: items.map((t) => ({
          task_id: t.task_id,
          linkid: t.linkid,
          session_id: t.session_id,
          title: extractTitle(t.request_body),
          path: t.path,
          status: t.status,
          created_at: t.created_at,
          finished_at: t.finished_at,
        })),
      },
    });
  });

  router.get('/admin/audit/:task_id', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    res.json({
      code: 0,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        session_id: task.session_id,
        title: extractTitle(task.request_body),
        path: task.path,
        status: task.status,
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
        request_body: safeParse(task.request_body),
        request_response: safeParse(task.request_response),
        prompt: task.prompt,
        sdk_output: task.sdk_output,
        sdk_trace: sdkTracesStore.getTraceByTaskId(task.task_id),
      },
    });
  });

  // 会话处理时间线（按 linkid 聚合所有 task）
  router.get('/admin/audit/link/:linkid/timeline', (req: Request, res: Response) => {
    const { linkid } = req.params;
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'json';

    const tasks = taskLogsStore.listByLinkid(linkid);
    if (tasks.length === 0) {
      res.status(404).json({ code: 1001, message: '该 linkid 下无任务记录' });
      return;
    }

    const historyTasks = tasks.map(t => ({
      task_id: t.task_id,
      session_id: t.session_id,
      title: extractTitle(t.request_body),
      path: t.path,
      status: t.status,
      error_message: t.error_message,
      created_at: t.created_at,
      finished_at: t.finished_at,
      events: buildOutputOnlyEvents(t),
    }));

    log.info({ linkid, taskCount: tasks.length, format }, 'admin_link_timeline');

    if (format === 'html') {
      res.contentType('text/html; charset=utf-8').send(renderHistoryHtml(linkid, historyTasks));
      return;
    }
    if (format === 'md') {
      res.contentType('text/markdown; charset=utf-8').send(renderHistoryMd(linkid, historyTasks));
      return;
    }

    res.json({
      code: 0,
      data: { linkid, total: historyTasks.length, tasks: historyTasks },
    });
  });

  // ---- 系统设置（仅管理员） ----

  router.get('/admin/sys-config', (req: Request, res: Response) => {
    const name = configStore.get('sys.name') || '';
    const apiAuthEnabled = configStore.get('api_auth_enabled');
    // token 已哈希存储，不再回传哈希值，仅告知是否已配置
    const apiAuthTokenSet = !!configStore.get('api_auth_token');
    res.json({
      code: 0,
      data: {
        sys: { name },
        api: {
          auth_enabled: apiAuthEnabled === '1',
          auth_token: '', // 不回传 token/哈希
          has_token: apiAuthTokenSet,
        },
      },
    });
  });

  router.put('/admin/sys-config', (req: Request, res: Response) => {
    const { sys, api } = req.body as {
      sys?: { name?: string };
      api?: { auth_enabled?: boolean; auth_token?: string };
    };
    if (sys && typeof sys.name === 'string' && sys.name.trim()) {
      configStore.set('sys.name', sys.name.trim(), '系统名称');
    }
    if (api) {
      configStore.set(
        'api_auth_enabled',
        api.auth_enabled ? '1' : '0',
        '对外 API 是否启用 X-Api-Key 认证'
      );
      if (typeof api.auth_token === 'string' && api.auth_token.trim()) {
        // 仅存 SHA-256 哈希，不落明文
        const hash = createHash('sha256').update(api.auth_token.trim(), 'utf8').digest('hex');
        configStore.set('api_auth_token', hash, '对外 API 认证 Token（SHA-256 哈希）');
      }
    }
    log.info({ sys_name: sys?.name, api_auth_enabled: api?.auth_enabled }, 'admin_update_sys_config');
    res.json({ code: 0, message: '保存成功' });
  });

  // ---- 用户管理（仅管理员） ----

  router.get('/admin/users', adminOnlyMiddleware, (_req: Request, res: Response) => {
    const users = usersStore.list().map((u) => ({
      id: u.id,
      user_name: u.username,
      role: u.role,
      note: u.note,
      created_at: u.created_at,
    }));
    res.json({ code: 0, data: users });
  });

  router.post('/admin/users', adminOnlyMiddleware, (req: Request, res: Response) => {
    const { user_name, user_pwd, role, note } = req.body as {
      user_name?: string;
      user_pwd?: string;
      role?: number;
      note?: string;
    };
    if (!user_name || !user_pwd) {
      res.status(400).json({ code: 1001, message: '用户名和密码不能为空' });
      return;
    }

    const strengthErr = validatePasswordStrength(user_pwd);
    if (strengthErr) {
      res.status(400).json({ code: 1001, message: strengthErr });
      return;
    }

    if (usersStore.get(user_name)) {
      res.status(409).json({ code: 1001, message: '用户名已存在' });
      return;
    }

    const hash = hashPasswordSync(user_pwd);
    const ok = usersStore.create(user_name, hash, role === 1 ? 1 : 0, note || '');
    if (!ok) {
      res.status(500).json({ code: 1001, message: '创建失败' });
      return;
    }

    const cu = getCurrentUser(req);
    log.info({ admin: cu?.uname, target: user_name, role }, 'admin_create_user');
    res.json({ code: 0, message: '添加成功' });
  });

  router.delete('/admin/users/:username', adminOnlyMiddleware, (req: Request, res: Response) => {
    const username = req.params.username;
    if (username === 'admin') {
      res.status(400).json({ code: 1001, message: '不能删除 admin 用户' });
      return;
    }
    const ok = usersStore.remove(username);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '用户不存在' });
      return;
    }
    const cu = getCurrentUser(req);
    log.info({ admin: cu?.uname, target: username }, 'admin_delete_user');
    res.json({ code: 0, message: '已删除' });
  });


  // ═══════════════════════════════════════════════════════════════
  // Prompt Config — CSV 上传（单向，加密入库，不可下载）
  // ═══════════════════════════════════════════════════════════════

  const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 } });

  // 上传 CSV 文件（三列：key, value, 说明）
  router.post('/admin/prompt-config/upload-csv', uploadCsv.single('file'), (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ code: 1001, message: '请选择 CSV 文件' });
      return;
    }

    const text = file.buffer.toString('utf8').trim();
    if (!text) {
      res.status(400).json({ code: 1001, message: 'CSV 文件为空' });
      return;
    }

    const rows: Array<{ key: string; value: string; is_secret: boolean; note?: string }> = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const parts = parseCsvLine(line);
      if (parts.length < 2) {
        res.status(400).json({ code: 1001, message: `第 ${i + 1} 行格式错误，需要至少 key,value 两列: ${line}` });
        return;
      }
      const key = parts[0].trim();
      const value = parts[1].trim();
      const note = (parts[2] || '').trim();
      // 跳过 CSV 表头行
      if (key === 'key' && value === 'value') continue;
      if (!key || !value) {
        res.status(400).json({ code: 1001, message: `第 ${i + 1} 行 key 或 value 为空: ${line}` });
        return;
      }
      const keyErr = validatePromptConfigKey(key);
      if (keyErr) {
        res.status(400).json({ code: 1001, message: `第 ${i + 1} 行 ${keyErr}: ${line}` });
        return;
      }
      // 敏感检测：key 以 .token /.key /.secret /.password 或 _token/_key/_secret/_password 结尾
      const isSecret = /[._](token|secret|password|key)$/i.test(key);
      rows.push({ key, value, is_secret: isSecret, note });
    }

    if (rows.length === 0) {
      res.status(400).json({ code: 1001, message: 'CSV 文件中没有有效数据行' });
      return;
    }

    // 替换模式：先清空再批量导入
    promptConfigStore.clearAll();
    const count = promptConfigStore.importRows(rows);

    log.info({ count, keys: rows.map(r => r.key) }, 'prompt_config_csv_uploaded');
    res.json({ code: 0, data: { imported: count, keys: rows.map(r => r.key) } });
  });

  // 下载 CSV 模板
  router.get('/admin/prompt-config/template', (_req: Request, res: Response) => {
    let csv = '';
    const templatePaths = [
      resolve(process.cwd(), 'assets', 'cfg.csv.template'),  // Docker 镜像（第2类资源）
      join(cfg.sys.data_dir, 'cfg.csv.template'),            // 开发模式兼容
    ];
    const templatePath = templatePaths.find(p => existsSync(p));
    if (templatePath) {
      try {
        csv = readFileSync(templatePath, 'utf8');
      } catch { csv = ''; }
    }
    if (!csv) {
      // 兜底：文件缺失时返回最小模板
      csv = 'key,value,说明\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prompt-config-template.csv"');
    // Add BOM for Excel UTF-8 compatibility
    res.write('﻿');
    res.end(csv);
  });

  // 获取配置列表（value 默认脱敏）
  router.get('/admin/prompt-config', (_req: Request, res: Response) => {
    const reveal = _req.query.reveal === '1';
    const rows = promptConfigStore.list(reveal);
    res.json({ code: 0, data: { rows, count: rows.length } });
  });

  // 清空配置
  router.delete('/admin/prompt-config', (_req: Request, res: Response) => {
    promptConfigStore.clearAll();
    log.info('prompt_config_cleared');
    res.json({ code: 0, message: '已清空' });
  });

  // 新增/更新单个配置项（页面直接添加环境变量，无需编辑 CSV）
  router.post('/admin/prompt-config/item', (req: Request, res: Response) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    const keyErr = validatePromptConfigKey(key);
    if (keyErr) {
      res.status(400).json({ code: 1001, message: keyErr });
      return;
    }
    if (!value) {
      res.status(400).json({ code: 1001, message: 'value 不能为空' });
      return;
    }

    promptConfigStore.upsertItem(key, value, note);
    log.info({ key }, 'prompt_config_item_upserted');
    res.json({ code: 0, data: { key } });
  });

  // 删除单个配置项
  router.delete('/admin/prompt-config/item/:key', (req: Request, res: Response) => {
    const key = req.params.key;
    const ok = promptConfigStore.deleteItem(key);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '配置项不存在' });
      return;
    }
    log.info({ key }, 'prompt_config_item_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ═══════════════════════════════════════════════════════════════
  // Prompt Tar — 上传 / 下载 / 校验
  // 支持 .tar / .tar.gz / .tgz / .zip
  // ═══════════════════════════════════════════════════════════════

  const uploadTar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  /** 按要求剥离包内固定的顶级目录，topDir 为 null 时不剥离。默认 'prompts/' */
  function stripTopDir(names: string[], topDir?: string | null): string[] | { error: string } {
    if (names.length === 0) return names;
    if (topDir === null) return names;
    const PREFIX = topDir || 'prompts/';
    if (names.every(n => n.startsWith(PREFIX))) {
      return names.map(n => n.slice(PREFIX.length));
    }
    // 有些文件不在 PREFIX 下 → 格式错误
    // 从任意带 / 的 name 提取顶级目录名报告给用户
    const actual = names.map(n => n.split('/')[0]).filter(Boolean);
    const unique = [...new Set(actual)];
    return { error: '压缩包顶层目录必须为 ' + PREFIX + '，当前为: ' + unique.join(', ') };
  }

  /** 检测格式并解压 → { [filename]: content } | { error: string } | null。topDir 传 null 不剥离顶级目录 */
  async function extractArchive(buf: Buffer, origName: string, topDir?: string | null): Promise<Record<string, string> | { error: string } | null> {
    // ── Zip ──
    if (origName.endsWith('.zip') || (buf[0] === 0x50 && buf[1] === 0x4b)) {
      const zip = new AdmZip(buf);
      const files: Record<string, string> = {};
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replace(/^\.?\/?/, '');
        if (!name.endsWith('.md')) continue;
        files[name] = entry.getData().toString('utf8');
      }
      const stripped = stripTopDir(Object.keys(files), topDir);
      if ('error' in stripped) {
        return { error: stripped.error };
      }
      const result: Record<string, string> = {};
      const keys = Object.keys(files);
      for (let i = 0; i < stripped.length; i++) {
        result[stripped[i]] = files[keys[i]];
      }
      return result;
    }

    // ── Tar / Tar.gz ──
    let raw = buf;
    if (origName.endsWith('.gz') || origName.endsWith('.tgz')
        || (buf[0] === 0x1f && buf[1] === 0x8b)) {
      try { raw = gunzipSync(buf); } catch { return null; }
    }

    const files: Record<string, string> = {};
    const extract = tarStream.extract();

    extract.on('entry', (header: any, stream: any, next: () => void) => {
      const name = header.name.replace(/^\.?\/?/, '');
      if (header.type === 'directory' || !name.endsWith('.md')) {
        stream.resume(); next(); return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        files[name] = Buffer.concat(chunks).toString('utf8');
        next();
      });
    });

    return new Promise<Record<string, string> | { error: string } | null>((resolve) => {
      extract.on('finish', () => {
        const keys = Object.keys(files);
        const stripped = stripTopDir(keys, topDir);
        if ('error' in stripped) {
          resolve({ error: stripped.error });
          return;
        }
        const result: Record<string, string> = {};
        for (let i = 0; i < stripped.length; i++) {
          result[stripped[i]] = files[keys[i]];
        }
        resolve(result);
      });
      extract.on('error', () => resolve(null));
      extract.end(raw);
    });
  }

  // Upload
  router.post('/admin/prompt-tar/upload', uploadTar.single('file'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ code: 1001, message: '请选择 .tar / .tar.gz / .tgz / .zip 文件' });
      return;
    }

    // 先校验 CSV 已上传
    if (promptConfigStore.count() === 0) {
      res.status(400).json({ code: 1001, message: '请先上传 CSV 配置文件（步骤 1），再进行步骤 2' });
      return;
    }

    const validKeys = new Set(promptConfigStore.listKeys());
    const builtinKeys = new Set(['request.body', 'request.linkid', 'request.files',
      'request.form_data', 'request.approval_history']);
    for (const k of builtinKeys) validKeys.add(k);

    const files = await extractArchive(file.buffer, file.originalname);
    if (!files) {
      res.status(400).json({ code: 1001, message: '无法解压文件。支持的格式：.tar / .tar.gz / .tgz / .zip' });
      return;
    }
    if ('error' in files) {
      res.status(400).json({ code: 1001, message: files.error });
      return;
    }
    if (Object.keys(files).length === 0) {
      res.status(400).json({ code: 1001, message: '无法解压文件，或包内没有 .md 文件。支持的格式：.tar / .tar.gz / .tgz / .zip' });
      return;
    }

    // 校验模板中引用的系统变量是否已配置（仅提示，不阻断上传）
    const warnings: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const placeholders = content.match(/\{\{([^}]+)\}\}/g) || [];
      for (const ph of placeholders) {
        const inner = ph.slice(2, -2).trim();
        if (inner.startsWith('section:') || inner.startsWith('request.')) continue;
        if (!validKeys.has(inner)) {
          warnings.push(name + ': 系统变量 {{' + inner + '}} 未在系统变量配置中配置');
        }
      }
    }

    // 替换 prompts/ 目录
    const promptsDir = resolve(process.cwd(), 'prompts');
    if (existsSync(promptsDir)) {
      rmSync(promptsDir, { recursive: true, force: true });
    }
    mkdirSync(promptsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const dest = join(promptsDir, name);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content);
    }

    // 重新扫描并同步 agent_interfaces 表
    const pfs = rescanPromptsDir();
    syncInterfacesFromPrompts(pfs.map(pf => ({ filename: pf.filename, path: pf.path, name: pf.name })));

    const fileList = Object.keys(files);
    log.info({ files: fileList, warnings }, 'prompt_archive_uploaded');
    res.json({ code: 0, data: { files: fileList, total: fileList.length, warnings } });
  });

  // 下载当前 prompts/ 为 tar.gz
  router.get('/admin/prompt-tar/download', (_req: Request, res: Response) => {
    const promptsDir = resolve(process.cwd(), 'prompts');
    if (!existsSync(promptsDir)) {
      res.status(404).json({ code: 1001, message: 'prompts/ 目录不存在' });
      return;
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="prompts.tar.gz"');
    // 打包 → gzip → response
    const pack = tarFs.pack(promptsDir);
    const gzip = createGzip();
    pack.pipe(gzip).pipe(res);
  });

  // 预览模板（渲染后的内容）
  router.get('/admin/prompt-preview', (_req: Request, res: Response) => {
    const promptsDir = resolve(process.cwd(), 'prompts');
    const previews: Array<{ file: string; raw: string }> = [];

    if (existsSync(promptsDir)) {
      const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const rel = prefix + entry;
          if (statSync(full).isDirectory()) {
            walk(full, rel + '/');
          } else if (entry.endsWith('.md')) {
            try {
              previews.push({
                file: rel,
                raw: readFileSync(full, 'utf8'),
              });
            } catch { /* skip */ }
          }
        }
      };
      walk(promptsDir, '');
    }

    res.json({ code: 0, data: { previews } });
  });

  // ═══════════════════════════════════════════════════════════════
  // 记忆管理 — 上传 .md / .tar.gz / .zip，写入 data/memory/
  // ═══════════════════════════════════════════════════════════════

  const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // 列出所有记忆文件
  router.get('/admin/memory', (_req: Request, res: Response) => {
    const items = listMemories(cfg.sys.data_dir);
    res.json({ code: 0, data: { items, count: items.length } });
  });

  // 获取单个记忆文件内容
  router.get('/admin/memory/:filename/content', (req: Request, res: Response) => {
    const content = getMemory(cfg.sys.data_dir, req.params.filename);
    if (content === null) {
      res.status(404).json({ code: 1001, message: '记忆文件不存在' });
      return;
    }
    res.json({ code: 0, data: { filename: req.params.filename, content } });
  });

  // 上传记忆文件（单 .md 或 .tar.gz / .tgz / .zip 包）
  router.post('/admin/memory/upload', uploadMemory.single('file'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ code: 1001, message: '请选择 .md / .tar.gz / .tgz / .zip 文件' });
      return;
    }

    // 记忆库规模限制：单文件 ≤ 100KB，文件数 ≤ 20，总量 ≤ 2MB。
    // 索引表会注入每个任务的提示词，文件过多会拖长上下文；单文件过大读取时会吃掉大量 token。
    const MAX_SINGLE_BYTES = 100 * 1024;
    const MAX_FILES = 20;
    const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

    ensureMemoryDir(cfg.sys.data_dir);
    const existing = listMemories(cfg.sys.data_dir);
    const existingTotal = existing.reduce((sum, m) => sum + m.size, 0);

    let uploaded: string[] = [];

    // 浏览器上传中文文件名时 multipart 头未带 charset，multer 按 latin1 解码，
    // 需还原为 UTF-8。纯 ASCII 文件名该转换是恒等，无副作用。
    const origName = decodeUploadFilename(file.originalname || '');

    // 收集待写入的 .md 文件内容
    const pending: Array<{ name: string; content: string }> = [];
    if (/\.(md|xmind)$/i.test(origName) && !/\.tar\.gz$|\.tgz$|\.tar$|\.zip$/i.test(origName)) {
      if (/\.xmind$/i.test(origName)) {
        // 将 .xmind 脑图转为 Markdown，存为同名 .md
        try {
          const md = xmindToMarkdown(file.buffer);
          pending.push({ name: origName.replace(/\.xmind$/i, '.md'), content: md });
        } catch (err) {
          res.status(400).json({ code: 1001, message: err instanceof Error ? err.message : 'xmind 解析失败' });
          return;
        }
      } else {
        pending.push({ name: origName, content: file.buffer.toString('utf8') });
      }
    } else {
      // 复用 extractArchive 解压，topDir=null 表示不剥离顶级目录
      const files = await extractArchive(file.buffer, origName, null);
      if (!files) {
        res.status(400).json({ code: 1001, message: '无法解压文件。支持 .md / .xmind / .tar.gz / .tgz / .zip' });
        return;
      }
      if ('error' in files) {
        res.status(400).json({ code: 1001, message: files.error });
        return;
      }
      for (const [name, content] of Object.entries(files)) {
        if (!name.endsWith('.md')) continue;
        pending.push({ name, content });
      }
    }

    if (pending.length === 0) {
      res.status(400).json({ code: 1001, message: '没有有效的 .md 文件' });
      return;
    }

    // 校验：单文件大小
    for (const p of pending) {
      const bytes = Buffer.byteLength(p.content, 'utf8');
      if (bytes > MAX_SINGLE_BYTES) {
        res.status(400).json({
          code: 1001,
          message: `文件「${p.name}」超过单文件上限 100KB（当前 ${(bytes / 1024).toFixed(1)}KB），请精简内容后重试`,
        });
        return;
      }
    }

    // 校验：文件数量（按文件名去重后的增量）
    const existingNames = new Set(existing.map(m => m.filename));
    const newNames = pending.map(p => p.name).filter(n => !existingNames.has(n));
    if (existing.length + newNames.length > MAX_FILES) {
      res.status(400).json({
        code: 1001,
        message: `记忆文件数将超过上限 ${MAX_FILES} 个（当前 ${existing.length} 个，本次新增 ${newNames.length} 个），请合并或删除部分文件`,
      });
      return;
    }

    // 校验：总字节数
    const incomingTotal = pending.reduce((sum, p) => sum + Buffer.byteLength(p.content, 'utf8'), 0);
    const existingKeptTotal = existing
      .filter(m => !pending.some(p => p.name === m.filename))
      .reduce((sum, m) => sum + m.size, 0);
    if (existingKeptTotal + incomingTotal > MAX_TOTAL_BYTES) {
      res.status(400).json({
        code: 1001,
        message: `记忆库总量将超过上限 2MB（当前 ${(existingKeptTotal / 1024).toFixed(1)}KB，本次新增 ${(incomingTotal / 1024).toFixed(1)}KB），请精简内容`,
      });
      return;
    }

    for (const p of pending) {
      try {
        const safe = saveMemory(cfg.sys.data_dir, p.name, p.content);
        uploaded.push(safe);
      } catch { /* skip invalid */ }
    }

    log.info({ uploaded }, 'memory_uploaded');
    res.json({ code: 0, data: { files: uploaded, total: uploaded.length } });
  });

  // 删除记忆文件
  router.delete('/admin/memory/:filename', (req: Request, res: Response) => {
    const ok = deleteMemory(cfg.sys.data_dir, req.params.filename);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '记忆文件不存在' });
      return;
    }
    log.info({ filename: req.params.filename }, 'memory_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ---- 数据管理（仅管理员） ----

  // 可管理的表清单
  const DATA_TABLES = [
    { id: 'sessions', label: '会话表（sessions）', note: '会话与 linkid 的映射，删除后同一 linkid 再提交会新建会话' },
    { id: 'task_logs', label: '任务日志表（task_logs）', note: '任务执行记录、时间线等审计数据（不含 sdk_trace）' },
    { id: 'sdk_traces', label: 'SDK Trace 表（sdk_traces）', note: 'Agent SDK 全量消息流 JSON，体积大，独立存储' },
  ];

  // 表信息 + 行数
  router.get('/admin/data-tables', (_req: Request, res: Response) => {
    const countOf = (id: string): number => {
      if (id === 'sessions') return sessionsStore.countAll();
      if (id === 'task_logs') return taskLogsStore.countAll();
      if (id === 'sdk_traces') return sdkTracesStore.countAll();
      return 0;
    };
    const tables = DATA_TABLES.map((t) => ({
      id: t.id,
      label: t.label,
      note: t.note,
      count: countOf(t.id),
    }));
    res.json({ code: 0, data: { tables } });
  });

  // 获取最新 N 条任务（SDK Trace tab 默认展示，无需先检索）
  router.get('/admin/data-tables/task_logs/latest', (_req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(_req.query.limit), 10) || 5, 50);
    const items = taskLogsStore.listLatest(limit);
    res.json({
      code: 0,
      data: {
        total: items.length,
        items: items.map((task) => ({
          task_id: task.task_id,
          linkid: task.linkid,
          session_id: task.session_id,
          title: extractTitle(task.request_body),
          path: task.path,
          status: task.status,
          created_at: task.created_at,
          finished_at: task.finished_at,
        })),
      },
    });
  });

  // 按 task_id 或 linkid 查询任务（用于数据管理：先查再导出 sdk_trace）
  // 精确匹配，只返回轻量列（不含 sdk_trace 大字段）；task_id limit 1，linkid limit 50
  router.get('/admin/data-tables/task_logs/query', (req: Request, res: Response) => {
    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id.trim() : '';
    const linkid = typeof req.query.linkid === 'string' ? req.query.linkid.trim() : '';
    if (!taskId && !linkid) {
      res.status(400).json({ code: 1001, message: '必须指定 task_id 或 linkid' });
      return;
    }

    let tasks: TaskLog[] = [];
    if (taskId) {
      const task = taskLogsStore.getLightByTaskId(taskId);
      if (task) tasks = [task];
    } else {
      tasks = taskLogsStore.listLightByLinkid(linkid);
    }

    if (tasks.length === 0) {
      res.status(404).json({ code: 1001, message: '未找到匹配的任务' });
      return;
    }

    res.json({
      code: 0,
      data: {
        total: tasks.length,
        items: tasks.map((task) => ({
          task_id: task.task_id,
          linkid: task.linkid,
          session_id: task.session_id,
          title: extractTitle(task.request_body),
          path: task.path,
          status: task.status,
          created_at: task.created_at,
          finished_at: task.finished_at,
        })),
      },
    });
  });

  // 导出单条任务的 sdk_trace 为 <taskid>.json
  router.get('/admin/data-tables/task_logs/:task_id/sdk-trace', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const task = taskLogsStore.get(task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    const sdkTrace = sdkTracesStore.getTraceByTaskId(task_id);
    if (!sdkTrace) {
      res.status(404).json({ code: 1001, message: '该任务无 sdk_trace 数据' });
      return;
    }

    // 过滤 system 类型消息（SDK 内部记账，无业务价值），与前端展示/导出保持一致
    let exportTrace = sdkTrace;
    try {
      const arr = JSON.parse(sdkTrace);
      if (Array.isArray(arr)) {
        const filtered = arr.filter((m) => (m as Record<string, unknown>).type !== 'system');
        if (filtered.length !== arr.length) exportTrace = JSON.stringify(filtered);
      }
    } catch { /* 非 JSON 保持原样导出 */ }

    const filename = `${task_id}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': Buffer.byteLength(exportTrace),
    });
    res.end(exportTrace);
    log.info({ task_id, linkid: task.linkid, traceLen: exportTrace.length }, 'data_task_sdk_trace_exported');
  });

  // 清空整表数据
  router.delete('/admin/data-tables/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const table = DATA_TABLES.find((t) => t.id === id);
    if (!table) {
      res.status(404).json({ code: 1001, message: '不支持的表' });
      return;
    }

    const countOf = (tid: string): number => {
      if (tid === 'sessions') return sessionsStore.countAll();
      if (tid === 'task_logs') return taskLogsStore.countAll();
      if (tid === 'sdk_traces') return sdkTracesStore.countAll();
      return 0;
    };

    const before = countOf(id);
    if (before === 0) {
      res.json({ code: 0, message: '表已是空的', deleted: 0 });
      return;
    }

    // sessions 表与 task_logs 表之间存在「会话记录」关联；清空 sessions 时，
    // 其对应的 SDK 工作目录（上下文快照）一并清理，避免残留脏数据。
    let deleted = 0;
    if (id === 'sessions') {
      const sessions = sessionsStore.listAll();
      for (const s of sessions) {
        const workDir = join(cfg.sys.runtime_dir, 'tasks', sanitizeLinkid(s.linkid));
        if (existsSync(workDir)) {
          try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 删除失败不阻塞 */ }
        }
      }
      deleted = sessionsStore.clearAll();
    } else if (id === 'task_logs') {
      deleted = taskLogsStore.clearAll();
    } else if (id === 'sdk_traces') {
      deleted = sdkTracesStore.clearAll();
    }

    // 清空后重建 SQLite 自增序列，避免 sqlite_sequence 无限增长
    try {
      const db = getDb();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(id);
    } catch { /* 无该序列则忽略 */ }

    log.info({ table: id, deleted }, 'data_table_cleared');
    res.json({ code: 0, message: `已清空 ${deleted} 条记录`, deleted });
  });

  // 压缩数据库（VACUUM）
  router.post('/admin/data-tables/vacuum', (_req: Request, res: Response) => {
    const dbPath = join(cfg.sys.data_dir, 'app.db');
    let beforeSize = 0;
    try { beforeSize = statSync(dbPath).size; } catch { /* */ }

    try {
      const db = getDb();
      db.pragma('journal_mode = DELETE'); // VACUUM 要求 journal_mode 非 WAL
      db.exec('VACUUM');
      db.pragma('journal_mode = WAL');   // 切回 WAL
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ error: msg }, 'vacuum_failed');
      res.status(500).json({ code: 1001, message: '压缩失败: ' + msg });
      return;
    }

    let afterSize = 0;
    try { afterSize = statSync(dbPath).size; } catch { /* */ }

    const shrunk = beforeSize - afterSize;
    const pct = beforeSize > 0 ? ((shrunk / beforeSize) * 100).toFixed(1) : '0';
    log.info({ beforeSize, afterSize, shrunk, pct }, 'vacuum_ok');
    res.json({ code: 0, message: `压缩完成：${fmtSize(beforeSize)} → ${fmtSize(afterSize)}，回收 ${fmtSize(Math.max(0, shrunk))}（${pct}%）` });
  });

  return router;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function sanitizeLinkid(linkid: string): string {
  return linkid.replace(/[/\\:*?"<>|]/g, '_');
}

/** 还原 multer 对中文文件名的 latin1→UTF-8 解码问题。
   *  multer（busboy）解析 multipart 文件名时固定按 latin1 解码，中文等
   *  非 ASCII 字符会变成乱码。此处将 latin1 字节重新按 UTF-8 解码还原。
   *  纯 ASCII 文件名该转换是恒等，无副作用。 */
function decodeUploadFilename(name: string): string {
  if (!name) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function extractTitle(requestBody: string | null): string {
  if (!requestBody) return '-';
  try {
    const obj = JSON.parse(requestBody);
    const title =
      (obj.form_data && (obj.form_data.title || obj.form_data.标题)) ||
      obj.title ||
      obj.标题 ||
      '';
    return title || '-';
  } catch {
    return '-';
  }
}

function detectPrimaryIp(): string {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const addr = info.address;
      if (addr.startsWith('172.') || addr.startsWith('10.') || addr.startsWith('192.168.')) {
        candidates.push(addr);
      } else {
        candidates.unshift(addr);
      }
    }
  }
  return candidates[0] || '127.0.0.1';
}

/** 简单 CSV 行解析，处理引号包裹的列（支持列内逗号） */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/** 校验 prompt_config key 格式，返回错误信息字符串，合法时返回 null */
function validatePromptConfigKey(key: string): string | null {
  if (!key) return 'key 不能为空';
  if (key.length > 128) return 'key 长度不能超过 128 个字符';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) {
    return 'key 只能包含字母、数字、下划线、点号和连字符，且必须以字母或数字开头';
  }
  if (/^dp_/i.test(key)) return 'key 不能以 DP_ 开头（前缀由系统自动添加）';
  if (/\{\{|\}\}/.test(key)) return 'key 不能包含 {{ 或 }} 占位符标记';
  return null;
}