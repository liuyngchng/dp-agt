/**
 * Claude Agent SDK 纯执行核心（无 store / 无 config / 无 prompts 依赖）
 *
 * 控制面（本地回退）与 runner 共用。runner 只 import 本文件 + process-tree + logger，
 * 不拖入 SQLite / bcrypt / prompt_config 等仅控制面需要的东西。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger.js';
import type { RunSdkOptions } from '../types.js';

const log = getLogger();

/** 替换路径分隔符和危险字符，确保 mkdir 成功 */
export function sanitizeDirName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_');
}

/** 将 tool_result 的 content（string 或 blocks 数组）转为纯文本 */
function toolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((c) => {
      if (c == null) return '';
      const o = c as Record<string, unknown>;
      return typeof o.text === 'string' ? o.text : JSON.stringify(o);
    }).join('');
  }
  return raw == null ? '' : JSON.stringify(raw);
}

export interface SdkResult {
  success: boolean;
  rawOutput: string;
  trace: string;
  sessionId?: string;       // SDK 返回的 session_id，用于后续 resume
  errorMessage?: string;
  durationMs: number;
  aborted?: boolean;        // SDK 因外部 abort 信号被中断
}

/** 完全解析好的执行输入：不依赖 SQLite / prompts / prompt_config，runner 可直接消费 */
export interface RunAgentInput {
  workDir: string;
  prompt: string;
  claudeMd: string | null;          // null = resume（不覆盖既有 CLAUDE.md）
  resumeSessionId?: string;
  sdkOptions: RunSdkOptions;
  env: Record<string, string>;
}

/** 执行过程中的回调（本地控制面用它喂 sse-bus，runner 用它写 NDJSON） */
export interface RunAgentHooks {
  onSessionId?: (sessionId: string) => void;
  onMessage?: (message: unknown) => void;
  onActivity?: () => void;
  /** resume session 已不存在（如 runner 重启丢失），降级为新建前回调 */
  onResumeGone?: (oldSessionId: string) => void;
}

/**
 * 运行一次 Claude Agent SDK（纯执行，不读数据库、不读配置、不发 SSE）。
 */
export async function runAgentCore(
  linkid: string,
  taskId: string,
  input: RunAgentInput,
  abortSignal?: AbortSignal,
  hooks: RunAgentHooks = {},
): Promise<SdkResult> {
  const { workDir, prompt, claudeMd, sdkOptions, env } = input;
  await mkdir(workDir, { recursive: true });

  // 验证 resume session 是否仍然存在。runner 重启后容器内会话数据丢失（runtime/ 非持久化），
  // 但控制面 sessions 表中仍有旧记录，此时应降级为新建 session。
  let effectiveResumeId: string | undefined = input.resumeSessionId;
  if (effectiveResumeId) {
    const oldSessionId = effectiveResumeId;
    try {
      const info = await getSessionInfo(oldSessionId);
      if (!info) {
        log.warn({ taskId, linkid, oldSessionId }, 'resume_session_gone_creating_new');
        effectiveResumeId = undefined;
        hooks.onResumeGone?.(oldSessionId);
      }
    } catch (err) {
      log.warn({ taskId, linkid, oldSessionId, error: String(err) }, 'resume_session_check_error_creating_new');
      effectiveResumeId = undefined;
      hooks.onResumeGone?.(oldSessionId);
    }
  }

  // CLAUDE.md 仅首次写入（resume 时不覆盖，因为 SDK snapshot 已固化 system prompt）
  if (!effectiveResumeId && claudeMd != null) {
    await writeFile(join(workDir, 'CLAUDE.md'), claudeMd, 'utf8');
  }

  log.info({ taskId, linkid, resumeSessionId: effectiveResumeId || '(new)', originalResumeId: input.resumeSessionId || '(none)', workDir }, 'sdk_run_start');

  const start = Date.now();
  let fullOutput = '';
  let capturedSessionId: string | undefined;
  const traceMessages: unknown[] = [];
  const callbackToolIds = new Set<string>();

  const abortController = new AbortController();
  let onAbort: (() => void) | undefined;

  try {
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        onAbort = () => abortController.abort();
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const q = query({
      prompt,
      options: {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        tools: { type: 'preset', preset: 'claude_code' },
        model: sdkOptions.model,
        env,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        maxTurns: sdkOptions.max_turns,
        abortController,
        ...(effectiveResumeId ? { resume: effectiveResumeId } : {}),
      },
    });

    for await (const message of q) {
      traceMessages.push(message);
      hooks.onActivity?.();
      hooks.onMessage?.(message);

      const sid = (message as Record<string, unknown>).session_id;
      if (!capturedSessionId && typeof sid === 'string' && sid) {
        capturedSessionId = sid;
        hooks.onSessionId?.(sid);
      }

      // 收集 assistant 文本输出
      if ((message as Record<string, unknown>).type === 'assistant') {
        const msg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fullOutput += block.text;
            }
            if (block.type === 'tool_use' && block.name === 'Bash') {
              const input = block.input as Record<string, unknown> | undefined;
              const cmd = typeof input?.command === 'string' ? input!.command as string : '';
              if (cmd.includes('/tmp/callback_payload') || cmd.includes('callback')) {
                const bid = typeof block.id === 'string' ? block.id as string : '';
                if (bid) callbackToolIds.add(bid);
                log.info({ taskId, linkid, command: cmd }, 'callback_request');
              }
            }
          }
        }
      }

      // 识别回调 curl 的执行结果（tool_result），记录对方返回内容
      if ((message as Record<string, unknown>).type === 'user') {
        const msg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks as Array<Record<string, unknown>>) {
            const tuid = typeof block.tool_use_id === 'string' ? block.tool_use_id as string : '';
            if (block.type === 'tool_result' && tuid && callbackToolIds.has(tuid)) {
              log.info({ taskId, linkid, callbackResponse: toolResultText(block.content) }, 'callback_response');
            }
          }
        }
      }
    }

    const durationMs = Date.now() - start;
    const trace = JSON.stringify(traceMessages);
    log.info({ taskId, linkid, sessionId: capturedSessionId, durationMs, outputLen: fullOutput.length, traceLen: trace.length }, 'sdk_run_complete');

    return { success: true, rawOutput: fullOutput, trace, sessionId: capturedSessionId, durationMs, aborted: abortController.signal.aborted };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const trace = JSON.stringify(traceMessages);
    log.error({ taskId, linkid, sessionId: capturedSessionId, durationMs, error: message, partialTraceLen: trace.length }, 'sdk_run_error');

    return { success: false, rawOutput: fullOutput, trace, sessionId: capturedSessionId, errorMessage: message, durationMs, aborted: abortController.signal.aborted };
  } finally {
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }
}
