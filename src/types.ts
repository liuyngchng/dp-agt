// ============================================================
// 访问路径（path + 提示词模板）
// ============================================================
export interface AgentInterface {
  id: string;
  name: string;
  path: string;
  prompt: string;
  created_at: string;       // YYYY-MM-DD HH:MM:ss.SSS 本地时间
  updated_at: string;
  created_ts: number | null; // Unix 毫秒时间戳（检索用）
  updated_ts: number | null;
}

// ============================================================
// 任务状态
// ============================================================
export type TaskStatus =
  | 'pending'
  | 'processing'
  | 'failed'
  | 'completed'
  | 'cancelled';

// ============================================================
// 任务日志
// ============================================================
export interface TaskLog {
  task_id: string;
  linkid: string;
  session_id: string | null;   // 关联的 Claude Agent SDK session（resume 用）
  path: string;
  interface_id: string | null;
  status: TaskStatus;
  request_body: string;
  request_response: string | null;   // 我方对请求的同步响应
  prompt: string;
  sdk_output: string | null;         // Agent 最终输出（业务产出）
  error_message: string | null;
  created_at: string;           // YYYY-MM-DD HH:MM:ss.SSS 本地时间
  finished_at: string | null;
  created_ts: number | null;    // Unix 毫秒时间戳（检索用）
  finished_ts: number | null;
}

// ============================================================
// Session（公文 ↔ Claude Agent SDK 会话映射）
// ============================================================
export type SessionStatus = 'active' | 'closed';

// ============================================================
// SDK Trace（独立存储，避免拖慢 task_logs 列表查询）
// ============================================================
export interface SdkTrace {
  id: number;           // 自增主键
  task_id: string;      // 关联 task_logs.task_id
  sdk_trace: string;    // Agent SDK 全量消息流 JSON
}

export interface Session {
  session_id: string;
  linkid: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  created_ts: number | null;
  updated_ts: number | null;
}

// ============================================================
// API 响应信封
// ============================================================
export interface ApiResponse<T = unknown> {
  code: number;
  timestamp: string;
  message: string;
  task_id: string;
  linkid: string;
  data: T;
}

// ============================================================
// 请求体（最小约束）
// ============================================================
export interface ProcessRequest {
  linkid: string;
  [key: string]: unknown;
}

// ============================================================
// 任务队列项
// ============================================================
export interface QueueItem {
  task_id: string;
  path: string;
  iface: AgentInterface;
  body: ProcessRequest;
}

// ============================================================
// 用户
// ============================================================
export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: number;          // 1 = admin, 0 = normal
  note: string;
  must_change_pwd: boolean;
  user_version: number;  // 递增可使该用户所有旧 token 失效（改密/登出时 +1）
  created_at: string;
  created_ts: number | null; // Unix 毫秒时间戳（检索用）
}
