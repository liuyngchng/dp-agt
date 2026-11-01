/**
 * 回调投递 + 重试
 *
 * 向 callback_url 发起 POST，失败自动重试（默认 3 次，指数退避）。
 * request/curl/响应体使用 debug 级别，HTTP 状态码使用 info 级别（方便排查）。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { getLogger } from '../logger.js';
import { promptConfigStore } from '../store.js';
import type { Config } from '../config.js';
import type { ApiResponse } from '../types.js';

const log = getLogger();

export interface CallbackResult {
  success: boolean;
  body: string;
  responseBody: string;
  lastStatusCode: number | undefined;
  retryCount: number;
  errorMsg?: string;
}

interface PostResult {
  ok: boolean;
  statusCode: number | undefined;
  responseBody: string;
  /** 底层错误原因，如 DNS 解析失败、连接超时等（HTTP 有响应但状态码非 2xx 时为空） */
  error?: string;
}

/**
 * 发送单次回调 POST。
 */
function postOnce(url: string, payload: string, token?: string): Promise<PostResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, statusCode: undefined, responseBody: '', error: '回调 URL 格式无效' });
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const port = parsed.port || (isHttps ? 443 : 80);

    const req = transport.request({
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300;
        log.debug(
          { url, statusCode: res.statusCode, ok, response_body: responseBody },
          'callback_response',
        );
        resolve({ ok, statusCode: res.statusCode, responseBody });
      });
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('回调请求超时 (30s)'));
    });
    req.on('error', (err) => {
      log.debug({ url, error: err.message }, 'callback_request_error');
      resolve({ ok: false, statusCode: undefined, responseBody: '', error: err.message });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 投递回调，重试最多 N 次。
 */
export async function deliverCallback(
  callbackUrl: string,
  payload: ApiResponse,
  cfg: Config,
): Promise<CallbackResult> {
  const maxRetries = cfg.sys.callback_retries;
  const baseInterval = cfg.sys.callback_retry_interval_sec * 1000;
  const token = promptConfigStore.getPlain('doc.file_url_token')
    || promptConfigStore.getPlain('sys.file_url_token')
    || undefined;
  const bodyStr = JSON.stringify(payload);

  // 生成 curl，输出到 info 日志（方便排查）
  const bodyEsc = bodyStr.replace(/'/g, "'\\''");
  const authHeader = token ? `-H 'Authorization: Bearer ${token}'` : "-H 'Authorization: Bearer sk-***'";
  const curlCmd = `curl -k --noproxy '*' -w'\\n' -H 'Content-Type: application/json' ${authHeader} -d '${bodyEsc}' ${callbackUrl}`;

  // 打印 request（包含 curl）和完整 payload
  log.info({ taskId: payload.task_id, url: callbackUrl || '(空)', curl: curlCmd }, 'callback_request');
  log.debug({ taskId: payload.task_id, url: callbackUrl || '(空)', payload }, 'callback_request_payload');

  let retryCount = 0;
  let lastResponseBody = '';
  let lastStatusCode: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      retryCount = attempt;
      const delay = baseInterval * Math.pow(2, attempt - 1);
      // 重试时打印上次 HTTP 状态码
      log.warn(
        { taskId: payload.task_id, attempt, delayMs: delay, lastStatusCode, lastError, lastResponseBody: lastResponseBody.slice(0, 500) },
        'callback_retry',
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const result = await postOnce(callbackUrl, bodyStr, token);
    lastResponseBody = result.responseBody;
    lastStatusCode = result.statusCode;
    lastError = result.error;
    if (result.ok) {
      log.info(
        { taskId: payload.task_id, retries: retryCount, statusCode: result.statusCode, response_body: lastResponseBody },
        'callback_success',
      );
      return { success: true, body: bodyStr, responseBody: result.responseBody, lastStatusCode: result.statusCode, retryCount };
    }
  }

  const httpInfo = lastStatusCode ? `HTTP ${lastStatusCode}` : '';
  const errInfo = lastError ? (httpInfo ? ` (${httpInfo}: ${lastError})` : ` (${lastError})`) : (httpInfo ? ` (${httpInfo})` : '');
  const errMsg = `回调失败${errInfo}，已重试 ${maxRetries} 次`;
  log.error(
    { taskId: payload.task_id, retries: maxRetries, lastStatusCode, lastError, last_response_body: lastResponseBody },
    'callback_all_retries_failed',
  );
  return { success: false, body: bodyStr, responseBody: lastResponseBody, lastStatusCode, retryCount: maxRetries, errorMsg: errMsg };
}