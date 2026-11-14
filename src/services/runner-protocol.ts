/**
 * 控制面 ↔ runner 的派发协议帧类型与 NDJSON 编解码。
 *
 * 控制面 POST /run 后，runner 以 NDJSON（每行一个 JSON）回传下列帧之一：
 *   { type: 'session',     session_id }
 *   { type: 'resume_gone', session_id }    ← resume 目标已丢失，runner 降级新建
 *   { type: 'msg',         message }       ← 原始 SDK 消息，逐条回传
 *   { type: 'result',      result }        ← 最终结果（含 watchdog_killed 标记）
 *
 * 控制面解析这些帧：session → 落 sessions 表；msg → 喂 sse-bus；result → 收尾落库。
 */
import type { SdkResult } from './sdk-core.js';

export type RunFrame =
  | { type: 'session'; session_id: string }
  | { type: 'resume_gone'; session_id: string }
  | { type: 'msg'; message: unknown }
  | { type: 'result'; result: RunResult };

export interface RunResult extends SdkResult {
  /** runner 本地看门狗强杀了进程树（控制面据此写出超时失败原因） */
  watchdog_killed: boolean;
}

/** 把一帧序列化为单行 NDJSON（不含换行，由调用方 write 时追加） */
export function encodeFrame(frame: RunFrame): string {
  return JSON.stringify(frame);
}

/** 解析单行 NDJSON 文本为帧；无法解析返回 null（静默跳过坏行，不中断流） */
export function decodeFrame(line: string): RunFrame | null {
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as RunFrame;
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
