import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { nowReadable, nowTs, fmtLocalTs } from './time.js';
import {
  encryptValue,
  decryptValue,
  initCrypto,
} from './crypto.js';
import { queryAll, queryOne, exec, execInsert } from './db.js';
import type { AgentInterface, TaskLog, TaskStatus, User, Session, SdkTrace, Runner, RunnerStatus } from './types.js';
import type { EncryptedValue } from './crypto.js';

export function initStore(dataDir: string): void {
  initCrypto(dataDir);
}

// ═══════════════════════════════════════════════════════════════
// Prompt Config — 加密 KV（上传 CSV 落盘）
// ═══════════════════════════════════════════════════════════════

export const promptConfigStore = {
  /** 批量导入 CSV 行。key 以 .token/.key/.secret/.password 或 _token/_key/_secret/_password 结尾的视为敏感。 */
  async importRows(rows: Array<{ key: string; value: string; is_secret: boolean; note?: string }>): Promise<number> {
    let count = 0;
    const now = nowReadable();
    for (const row of rows) {
      let enc: EncryptedValue;
      try {
        enc = encryptValue(row.value);
      } catch { continue; }
      await exec(
        `INSERT INTO prompt_config (key, value_enc, iv, tag, is_secret, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value_enc = VALUES(value_enc), iv = VALUES(iv),
           tag = VALUES(tag), is_secret = VALUES(is_secret),
           note = VALUES(note), updated_at = VALUES(updated_at)`,
        [row.key, enc.enc, enc.iv, enc.tag, row.is_secret ? 1 : 0, row.note ?? '', now]
      );
      count++;
    }
    return count;
  },

  /** 获取单个 key 的明文 */
  async getPlain(key: string): Promise<string | null> {
    const row = await queryOne<{ value_enc: string; iv: string; tag: string }>(
      'SELECT value_enc, iv, tag FROM prompt_config WHERE key = ?', [key]
    );
    if (!row || !row.value_enc) return null;
    return decryptValue(row.value_enc, row.iv, row.tag);
  },

  /** 列出所有 key。敏感项默认脱敏，公开项直接明文；reveal=true 时敏感项也明文 */
  async list(reveal = false): Promise<Array<{ key: string; value: string; is_secret: boolean; note: string; updated_at: string }>> {
    const rows = await queryAll<{ key: string; value_enc: string; iv: string; tag: string; is_secret: number; note: string; updated_at: string }>(
      'SELECT key, value_enc, iv, tag, is_secret, note, updated_at FROM prompt_config ORDER BY key'
    );
    return rows.map((r) => {
      const plain = r.value_enc ? decryptValue(r.value_enc, r.iv, r.tag) : '';
      const isSecret = r.is_secret === 1;
      const value = isSecret
        ? (reveal ? (plain ?? '<解密失败>') : maskValue(plain))
        : (plain ?? '');
      return {
        key: r.key,
        value,
        is_secret: isSecret,
        note: r.note ?? '',
        updated_at: r.updated_at,
      };
    });
  },

  /** 获取所有 key→明文映射（内部渲染用） */
  async getAllPlain(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    const rows = await queryAll<{ key: string; value_enc: string; iv: string; tag: string }>(
      'SELECT key, value_enc, iv, tag FROM prompt_config'
    );
    for (const r of rows) {
      if (!r.value_enc) continue;
      const plain = decryptValue(r.value_enc, r.iv, r.tag);
      if (plain !== null) m.set(r.key, plain);
    }
    return m;
  },

  /** 单条 upsert。key 以 .token/.key/.secret/.password 或 _token/_key/_secret/_password 结尾的视为敏感。 */
  async upsertItem(key: string, value: string, note?: string): Promise<void> {
    const isSecret = /[._](token|secret|password|key)$/i.test(key);
    let enc: EncryptedValue;
    try {
      enc = encryptValue(value);
    } catch {
      return;
    }
    await exec(
      `INSERT INTO prompt_config (key, value_enc, iv, tag, is_secret, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value_enc = VALUES(value_enc), iv = VALUES(iv),
         tag = VALUES(tag), is_secret = VALUES(is_secret),
         note = VALUES(note), updated_at = VALUES(updated_at)`,
      [key, enc.enc, enc.iv, enc.tag, isSecret ? 1 : 0, note ?? '', nowReadable()]
    );
  },

  /** 删除单个 key */
  async deleteItem(key: string): Promise<boolean> {
    return (await exec('DELETE FROM prompt_config WHERE key = ?', [key])) > 0;
  },

  /** 清空所有配置（重新上传 CSV 前用） */
  async clearAll(): Promise<void> {
    await exec('DELETE FROM prompt_config');
  },

  /** key 数量 */
  async count(): Promise<number> {
    const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM prompt_config');
    return row?.c ?? 0;
  },

  /** 获取所有 key 名，用于模板中的系统变量引用校验 */
  async listKeys(): Promise<string[]> {
    const rows = await queryAll<{ key: string }>('SELECT key FROM prompt_config ORDER BY key');
    return rows.map(r => r.key);
  },
};

function maskValue(plain: string | null): string {
  if (!plain) return '';
  if (plain.length <= 4) return '****';
  return plain.substring(0, 2) + '****' + plain.substring(plain.length - 2);
}

// ═══════════════════════════════════════════════════════════════
// Agent Interfaces — 保留路径映射，prompt 列废弃（改走磁盘文件）
// ═══════════════════════════════════════════════════════════════

export const interfacesStore = {
  async list(): Promise<AgentInterface[]> {
    return queryAll<AgentInterface>('SELECT * FROM agent_interfaces ORDER BY created_at DESC');
  },
  async get(id: string): Promise<AgentInterface | undefined> {
    return queryOne<AgentInterface>('SELECT * FROM agent_interfaces WHERE id = ?', [id]);
  },
  async getByPath(path: string): Promise<AgentInterface | undefined> {
    return queryOne<AgentInterface>('SELECT * FROM agent_interfaces WHERE path = ?', [path]);
  },
  async create(name: string, path: string, prompt: string): Promise<AgentInterface> {
    const id = uuid();
    const now = nowReadable();
    const ts = nowTs();
    await exec(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, path, prompt, now, now, ts, ts]
    );
    return (await this.get(id))!;
  },
  async update(id: string, name: string, path: string, prompt: string): Promise<AgentInterface | undefined> {
    const now = nowReadable();
    const ts = nowTs();
    await exec(
      'UPDATE agent_interfaces SET name = ?, path = ?, prompt = ?, updated_at = ?, updated_ts = ? WHERE id = ?',
      [name, path, prompt, now, ts, id]
    );
    return this.get(id);
  },
  async remove(id: string): Promise<boolean> {
    return (await exec('DELETE FROM agent_interfaces WHERE id = ?', [id])) > 0;
  },
};

// ═══════════════════════════════════════════════════════════════
// Task logs / sessions / users / config — 全量异步
// ═══════════════════════════════════════════════════════════════

// 列表查询专用列：不包含 sdk_output / prompt / request_body 等大字段（sdk_trace 已独立存储）
const TASK_LOG_LIGHT_COLS = `task_id, linkid, session_id, path, interface_id, status, request_body, request_response, error_message, created_at, finished_at, created_ts, finished_ts, started_ts, runner_id`;
// 单条详情用列：全量（timeline 需通过 sdkTracesStore 单独取 sdk_trace）
const TASK_LOG_FULL_COLS = `*`;

export const taskLogsStore = {
  async create(log: TaskLog): Promise<void> {
    await exec(
      `INSERT INTO task_logs
       (task_id, linkid, session_id, path, interface_id, status, request_body, request_response, prompt, sdk_output, error_message, runner_id, created_at, finished_at, created_ts, finished_ts, started_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [log.task_id, log.linkid, log.session_id, log.path, log.interface_id, log.status,
       log.request_body, log.request_response, log.prompt, log.sdk_output, log.error_message,
       log.runner_id ?? null, log.created_at, log.finished_at, log.created_ts, log.finished_ts, log.started_ts ?? null]
    );
  },
  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    await exec('UPDATE task_logs SET status = ? WHERE task_id = ?', [status, taskId]);
  },
  async updateResult(taskId: string, fields: Partial<TaskLog>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.finished_at !== undefined && fields.finished_ts === undefined) {
      fields = { ...fields, finished_ts: nowTs() };
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(taskId);
    await exec(`UPDATE task_logs SET ${sets.join(', ')} WHERE task_id = ?`, vals);
  },
  // ── 单条详情（全量列） ──
  async get(taskId: string): Promise<TaskLog | undefined> {
    return queryOne<TaskLog>(`SELECT ${TASK_LOG_FULL_COLS} FROM task_logs WHERE task_id = ?`, [taskId]);
  },
  async getLatestByLinkid(linkid: string): Promise<TaskLog | undefined> {
    return queryOne<TaskLog>(
      `SELECT ${TASK_LOG_FULL_COLS} FROM task_logs WHERE linkid = ? ORDER BY created_ts DESC LIMIT 1`, [linkid]
    );
  },
  // ── 轻量精确查询（数据管理用） ──
  async getLightByTaskId(taskId: string): Promise<TaskLog | undefined> {
    return queryOne<TaskLog>(
      `SELECT ${TASK_LOG_LIGHT_COLS} FROM task_logs WHERE task_id = ? LIMIT 1`, [taskId]
    );
  },
  async listLightByLinkid(linkid: string, limit = 50): Promise<TaskLog[]> {
    return queryAll<TaskLog>(
      `SELECT ${TASK_LOG_LIGHT_COLS} FROM task_logs WHERE linkid = ? ORDER BY created_ts DESC LIMIT ?`, [linkid, limit]
    );
  },
  // ── 列表分页（轻量列） ──
  async listPaged(offset: number, limit: number): Promise<{ items: TaskLog[]; total: number }> {
    const totalRow = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM task_logs');
    const items = await queryAll<TaskLog>(
      `SELECT ${TASK_LOG_LIGHT_COLS} FROM task_logs ORDER BY created_ts DESC LIMIT ? OFFSET ?`, [limit, offset]
    );
    return { items, total: totalRow?.c ?? 0 };
  },
  // ── 最新 N 条（轻量列） ──
  async listLatest(limit: number): Promise<TaskLog[]> {
    return queryAll<TaskLog>(
      `SELECT ${TASK_LOG_LIGHT_COLS} FROM task_logs ORDER BY created_ts DESC LIMIT ?`, [limit]
    );
  },
  // ── 活跃任务 ──
  async countActive(): Promise<number> {
    const row = await queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM task_logs WHERE status IN ('pending', 'processing')`
    );
    return row?.c ?? 0;
  },
  async listActive(): Promise<TaskLog[]> {
    return queryAll<TaskLog>(
      `SELECT ${TASK_LOG_LIGHT_COLS} FROM task_logs WHERE status IN ('pending', 'processing') ORDER BY created_ts ASC`
    );
  },
  async hasActiveByLinkid(linkid: string): Promise<boolean> {
    const row = await queryOne<{ c: number }>(
      `SELECT 1 AS c FROM task_logs WHERE linkid = ? AND status IN ('pending', 'processing') LIMIT 1`, [linkid]
    );
    return !!row;
  },
  async cancelByLinkid(linkid: string): Promise<number> {
    const now = nowReadable();
    const ts = nowTs();
    return exec(
      `UPDATE task_logs SET status = 'cancelled', finished_at = ?, finished_ts = ?
       WHERE linkid = ? AND status IN ('pending', 'processing')`, [now, ts, linkid]
    );
  },
  // ── 按 linkid 列表（全量列，timeline 需要 sdk_output/prompt） ──
  async listByLinkid(linkid: string, limit = 50): Promise<TaskLog[]> {
    return queryAll<TaskLog>(
      `SELECT ${TASK_LOG_FULL_COLS} FROM task_logs WHERE linkid = ? ORDER BY finished_ts DESC LIMIT ?`, [linkid, limit]
    );
  },
  async deleteExpired(retentionDays: number): Promise<number> {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    return exec(
      `DELETE FROM task_logs WHERE created_ts < ? AND status NOT IN ('pending', 'processing')`, [cutoffMs]
    );
  },
  // ── 数据管理（全量，仅导出/清空用） ──
  async countAll(): Promise<number> {
    const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM task_logs');
    return row?.c ?? 0;
  },
  async listAll(): Promise<TaskLog[]> {
    return queryAll<TaskLog>(`SELECT ${TASK_LOG_FULL_COLS} FROM task_logs ORDER BY created_ts ASC`);
  },
  async clearAll(): Promise<number> {
    return exec('DELETE FROM task_logs');
  },
};

export const sdkTracesStore = {
  async upsert(taskId: string, sdkTrace: string): Promise<void> {
    await exec(
      `INSERT INTO sdk_traces (task_id, sdk_trace) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE sdk_trace = VALUES(sdk_trace)`, [taskId, sdkTrace]
    );
  },
  async get(taskId: string): Promise<SdkTrace | undefined> {
    return queryOne<SdkTrace>('SELECT * FROM sdk_traces WHERE task_id = ?', [taskId]);
  },
  async getTraceByTaskId(taskId: string): Promise<string | null> {
    const row = await queryOne<{ sdk_trace: string }>('SELECT sdk_trace FROM sdk_traces WHERE task_id = ?', [taskId]);
    return row?.sdk_trace ?? null;
  },
  async removeByTaskId(taskId: string): Promise<boolean> {
    return (await exec('DELETE FROM sdk_traces WHERE task_id = ?', [taskId])) > 0;
  },
  async deleteOrphans(): Promise<number> {
    return exec('DELETE FROM sdk_traces WHERE task_id NOT IN (SELECT task_id FROM task_logs)');
  },
  async countAll(): Promise<number> {
    const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM sdk_traces');
    return row?.c ?? 0;
  },
  async clearAll(): Promise<number> {
    return exec('DELETE FROM sdk_traces');
  },
};

export const sessionsStore = {
  async upsert(sessionId: string, linkid: string, runnerId?: string): Promise<Session> {
    const now = nowReadable();
    const ts = nowTs();
    await exec(
      `INSERT INTO sessions (session_id, linkid, status, runner_id, created_at, updated_at, created_ts, updated_ts)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         session_id = VALUES(session_id),
         status = 'active',
         runner_id = COALESCE(VALUES(runner_id), sessions.runner_id),
         updated_at = VALUES(updated_at),
         updated_ts = VALUES(updated_ts)`,
      [sessionId, linkid, runnerId ?? null, now, now, ts, ts]
    );
    return (await this.get(sessionId))!;
  },
  async get(sessionId: string): Promise<Session | undefined> {
    return queryOne<Session>('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
  },
  async getByLinkid(linkid: string): Promise<Session | undefined> {
    return queryOne<Session>('SELECT * FROM sessions WHERE linkid = ? AND status = ?', [linkid, 'active']);
  },
  async listAll(): Promise<Session[]> {
    return queryAll<Session>('SELECT * FROM sessions ORDER BY updated_ts DESC');
  },
  async listPaged(offset: number, limit: number): Promise<{ items: Session[]; total: number }> {
    const totalRow = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM sessions');
    const items = await queryAll<Session>(
      'SELECT * FROM sessions ORDER BY updated_ts DESC LIMIT ? OFFSET ?', [limit, offset]
    );
    return { items, total: totalRow?.c ?? 0 };
  },
  async close(sessionId: string): Promise<boolean> {
    const now = nowReadable();
    const ts = nowTs();
    return (await exec(
      "UPDATE sessions SET status = 'closed', updated_at = ?, updated_ts = ? WHERE session_id = ?",
      [now, ts, sessionId]
    )) > 0;
  },
  async touch(sessionId: string): Promise<boolean> {
    const now = nowReadable();
    const ts = nowTs();
    return (await exec(
      "UPDATE sessions SET status = 'active', updated_at = ?, updated_ts = ? WHERE session_id = ?",
      [now, ts, sessionId]
    )) > 0;
  },
  async setRunnerId(sessionId: string, runnerId: string): Promise<boolean> {
    return (await exec('UPDATE sessions SET runner_id = ? WHERE session_id = ?', [runnerId, sessionId])) > 0;
  },
  async remove(sessionId: string): Promise<boolean> {
    return (await exec('DELETE FROM sessions WHERE session_id = ?', [sessionId])) > 0;
  },
  async deleteExpired(retentionDays: number): Promise<Session[]> {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    const expired = await queryAll<Session>('SELECT * FROM sessions WHERE updated_ts < ?', [cutoffMs]);
    await exec('DELETE FROM sessions WHERE updated_ts < ?', [cutoffMs]);
    return expired;
  },
  async countAll(): Promise<number> {
    const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM sessions');
    return row?.c ?? 0;
  },
  async clearAll(): Promise<number> {
    return exec('DELETE FROM sessions');
  },
};

// ═══════════════════════════════════════════════════════════════
// Runners — 控制面维护的执行节点注册表
// ═══════════════════════════════════════════════════════════════
export const runnersStore = {
  async sync(addresses: Array<{ name: string; addr: string; capacity: number }>): Promise<Runner[]> {
    const now = nowReadable();
    const ts = nowTs();

    const seen = new Set(addresses.map((a) => a.name));
    const existing = await queryAll<{ name: string }>('SELECT name FROM runners');
    for (const e of existing) {
      if (!seen.has(e.name)) {
        await exec("UPDATE runners SET status = 'down', updated_at = ? WHERE name = ?", [now, e.name]);
      }
    }

    for (const a of addresses) {
      await exec(
        `INSERT INTO runners (id, name, addr, capacity, status, last_heartbeat_ts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'up', NULL, ?, ?)
         ON DUPLICATE KEY UPDATE
           addr = VALUES(addr),
           capacity = VALUES(capacity),
           status = 'up',
           updated_at = VALUES(updated_at)`,
        [uuid(), a.name, a.addr, a.capacity, now, now]
      );
    }

    return this.list();
  },

  async list(): Promise<Runner[]> {
    return queryAll<Runner>('SELECT * FROM runners ORDER BY name');
  },
  async get(id: string): Promise<Runner | undefined> {
    return queryOne<Runner>('SELECT * FROM runners WHERE id = ?', [id]);
  },
  async getByName(name: string): Promise<Runner | undefined> {
    return queryOne<Runner>('SELECT * FROM runners WHERE name = ?', [name]);
  },
  async listUp(): Promise<Runner[]> {
    return queryAll<Runner>("SELECT * FROM runners WHERE status = 'up' ORDER BY name");
  },
  async setStatus(id: string, status: RunnerStatus): Promise<void> {
    await exec('UPDATE runners SET status = ?, updated_at = ? WHERE id = ?', [status, nowReadable(), id]);
  },
  async heartbeat(id: string): Promise<void> {
    await exec('UPDATE runners SET status = ?, last_heartbeat_ts = ?, updated_at = ? WHERE id = ?',
      ['up', nowTs(), nowReadable(), id]);
  },
  async markDown(id: string): Promise<void> {
    await exec('UPDATE runners SET status = ?, updated_at = ? WHERE id = ?', ['down', nowReadable(), id]);
  },
};

export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function comparePasswordSync(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export const usersStore = {
  async get(username: string): Promise<User | undefined> {
    return queryOne<User>(
      `SELECT id, username, password_hash, role, note,
        COALESCE(must_change_pwd,0) AS must_change_pwd,
        COALESCE(user_version,1) AS user_version,
        COALESCE(created_at,'') AS created_at, created_ts
       FROM users WHERE username = ?`, [username]
    );
  },
  async list(): Promise<User[]> {
    return queryAll<User>(
      `SELECT id, username, password_hash, role, note,
        COALESCE(must_change_pwd,0) AS must_change_pwd,
        COALESCE(user_version,1) AS user_version,
        COALESCE(created_at,'') AS created_at, created_ts
       FROM users ORDER BY id`
    );
  },
  async updatePassword(username: string, hash: string): Promise<boolean> {
    return (await exec('UPDATE users SET password_hash = ?, user_version = user_version + 1 WHERE username = ?', [hash, username])) > 0;
  },
  async clearMustChangePwd(username: string): Promise<boolean> {
    return (await exec('UPDATE users SET must_change_pwd = 0 WHERE username = ?', [username])) > 0;
  },
  async incrementUserVersion(username: string): Promise<void> {
    await exec('UPDATE users SET user_version = user_version + 1 WHERE username = ?', [username]);
  },
  async getAllVersions(): Promise<Map<string, number>> {
    const rows = await queryAll<{ username: string; user_version: number }>(
      'SELECT username, COALESCE(user_version,1) AS user_version FROM users'
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.username, r.user_version);
    return m;
  },
  async create(username: string, hash: string, role: number, note: string): Promise<boolean> {
    try {
      await exec(
        'INSERT INTO users (username, password_hash, role, note, must_change_pwd, user_version, created_at, created_ts) VALUES (?, ?, ?, ?, 0, 1, ?, ?)',
        [username, hash, role, note, nowReadable(), nowTs()]
      );
      return true;
    } catch {
      return false;
    }
  },
  async remove(username: string): Promise<boolean> {
    return (await exec('DELETE FROM users WHERE username = ?', [username])) > 0;
  },
};

export const configStore = {
  async get(key: string): Promise<string | undefined> {
    const row = await queryOne<{ value: string }>('SELECT value FROM config WHERE key = ?', [key]);
    return row?.value;
  },
  async set(key: string, value: string, note?: string): Promise<void> {
    await exec(
      'INSERT INTO config (key, value, note) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note)',
      [key, value, note ?? '']
    );
  },
  async del(key: string): Promise<void> {
    await exec('DELETE FROM config WHERE key = ?', [key]);
  },
};

// seed 默认 admin 用户（首次启动无用户时）
export async function seedDefaults(): Promise<void> {
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  if ((row?.c ?? 0) === 0) {
    await exec(
      'INSERT INTO users (username, password_hash, role, note, must_change_pwd, user_version, created_at, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['admin', hashPasswordSync('admin'), 1, '默认管理员', 1, 1, nowReadable(), nowTs()]
    );
  }
}

// 同步 prompts 目录到 agent_interfaces（保持与旧逻辑一致）
export async function syncInterfacesFromPrompts(promptFiles: Array<{ filename: string; path: string; name: string }>): Promise<void> {
  const existing = await queryAll<{ path: string }>('SELECT path FROM agent_interfaces');
  const existingPaths = new Set(existing.map(r => r.path));
  const now = nowReadable();
  const ts = nowTs();

  for (const pf of promptFiles) {
    if (existingPaths.has(pf.path)) {
      await exec('UPDATE agent_interfaces SET name = ?, updated_at = ?, updated_ts = ? WHERE path = ?',
        [pf.name, now, ts, pf.path]);
    } else {
      await exec(
        'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuid(), pf.name, pf.path, '', now, now, ts, ts]
      );
    }
  }

  const diskPaths = new Set(promptFiles.map(pf => pf.path));
  for (const ep of existingPaths) {
    if (!diskPaths.has(ep)) {
      await exec('DELETE FROM agent_interfaces WHERE path = ?', [ep]);
    }
  }
}
