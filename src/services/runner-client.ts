/**
 * 控制面 → runner 的 HTTP 客户端封装
 *
 * - streamRun：POST /run，长连接逐行解析 NDJSON 帧
 * - cancelTask / status / 会话读删代理
 * - 所有请求带 Bearer token；runner 是自签 HTTPS 时 rejectUnauthorized: false
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { getLogger } from '../logger.js';
import { decodeFrame, type RunFrame } from './runner-protocol.js';
import type { RunRequest, RunnerStatusInfo } from '../types.js';

const log = getLogger();

export interface RunnerHttpConfig {
  token: string;
  connect_timeout_ms: number;
  request_timeout_ms: number;
}

function isHttps(addr: string): boolean {
  return addr.startsWith('https://');
}

function parseTarget(addr: string): { protocol: 'http:' | 'https:'; hostname: string; port: number } {
  const url = new URL(addr);
  return {
    protocol: url.protocol as 'http:' | 'https:',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
  };
}

function doRequest(
  method: string,
  addr: string,
  path: string,
  body: unknown,
  cfg: RunnerHttpConfig,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port } = parseTarget(addr);
    const payload = body === undefined ? null : JSON.stringify(body);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (cfg.token) {
      headers['Authorization'] = 'Bearer ' + cfg.token;
    }

    const doReq = protocol === 'https:' ? httpsRequest : httpRequest;
    const req: ClientRequest = doReq(
      {
        protocol,
        hostname,
        port,
        path,
        method,
        headers,
        ...(protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );

    req.setTimeout(cfg.request_timeout_ms, () => {
      req.destroy(new Error('请求 runner 超时'));
    });
    req.on('error', reject);

    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** GET /status */
export async function getRunnerStatus(addr: string, cfg: RunnerHttpConfig): Promise<RunnerStatusInfo> {
  const r = await doRequest('GET', addr, '/status', undefined, cfg);
  if (r.statusCode !== 200) throw new Error('runner status 返回 ' + r.statusCode);
  return r.body as RunnerStatusInfo;
}

/** POST /cancel */
export async function cancelRunnerTask(addr: string, taskId: string, cfg: RunnerHttpConfig): Promise<boolean> {
  const r = await doRequest('POST', addr, '/cancel', { task_id: taskId }, cfg);
  return r.statusCode === 200;
}

/**
 * POST /run（长连接 NDJSON 流）
 * 回调 onFrame 逐帧接收，onEnd 收尾（正常结束 / 连接断开 / 出错）。
 */
export function streamRun(
  addr: string,
  runReq: RunRequest,
  cfg: RunnerHttpConfig,
  onFrame: (frame: RunFrame) => void,
  onEnd: (err?: Error) => void,
): { abort: () => void } {
  const { protocol, hostname, port } = parseTarget(addr);
  const payload = JSON.stringify(runReq);
  const headers: Record<string, string> = {
    Accept: 'application/x-ndjson',
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
  };
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

  const doReq = protocol === 'https:' ? httpsRequest : httpRequest;
  const req: ClientRequest = doReq(
    {
      protocol,
      hostname,
      port,
      path: '/run',
      method: 'POST',
      headers,
      ...(protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    },
    (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          onEnd(new Error('runner 返回 ' + res.statusCode + ': ' + Buffer.concat(chunks).toString('utf8')));
        });
        return;
      }

      const rl = createInterface({ input: res, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const frame = decodeFrame(line);
        if (frame) onFrame(frame);
      });
      res.on('close', () => onEnd());
      res.on('error', (err) => onEnd(err));
    },
  );

  // 注意：这里**不**设 socket 超时。流式连接的消息间隔可能很长（LLM 思考/长工具调用），
  // socket 超时会在无数据时误杀健康连接。存活由控制面滑动超时（armTimeout）负责：
  // 连续 timeout_ms 无 msg 帧 → abort 此连接 + 调 /cancel。
  req.on('error', (err) => onEnd(err));

  req.write(payload);
  req.end();

  return { abort: () => req.destroy() };
}

/** 会话读/删代理的通用 GET 转发，返回 { statusCode, body } */
export async function proxyGet(
  addr: string,
  path: string,
  cfg: RunnerHttpConfig,
): Promise<{ statusCode: number; body: unknown }> {
  return doRequest('GET', addr, path, undefined, cfg);
}

/** 会话删除代理 */
export async function proxyDelete(
  addr: string,
  path: string,
  cfg: RunnerHttpConfig,
): Promise<{ statusCode: number; body: unknown }> {
  return doRequest('DELETE', addr, path, undefined, cfg);
}

export { log };
