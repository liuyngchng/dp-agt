import Database from 'better-sqlite3';
import { join } from 'node:path';
import { readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { nowReadable, nowTs, fmtLocalTs } from './time.js';
import {
  encryptValue,
  decryptValue,
  initCrypto,
} from './crypto.js';
import type { AgentInterface, TaskLog, TaskStatus, User, Session } from './types.js';
import type { EncryptedValue } from './crypto.js';

let db: Database.Database;

export function initStore(dataDir: string): Database.Database {
  db = new Database(join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');

  // ── crypto ──
  initCrypto(dataDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_interfaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL UNIQUE,
      prompt      TEXT NOT NULL DEFAULT '',
      created_at  TEXT,
      updated_at  TEXT,
      created_ts  INTEGER,
      updated_ts  INTEGER
    );

    CREATE TABLE IF NOT EXISTS prompt_config (
      key         TEXT PRIMARY KEY,
      value_enc   TEXT NOT NULL DEFAULT '',
      iv          TEXT NOT NULL DEFAULT '',
      tag         TEXT NOT NULL DEFAULT '',
      is_secret   INTEGER NOT NULL DEFAULT 0,
      note        TEXT DEFAULT '',
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      task_id       TEXT PRIMARY KEY,
      linkid        TEXT,
      session_id    TEXT,
      path          TEXT,
      interface_id  TEXT,
      status        TEXT,
      request_body  TEXT,
      request_response TEXT,
      prompt        TEXT,
      sdk_output    TEXT,
      callback_body TEXT,
      callback_response TEXT,
      callback_url  TEXT,
      error_message TEXT,
      created_at    TEXT,
      finished_at   TEXT,
      created_ts    INTEGER,
      finished_ts   INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id  TEXT PRIMARY KEY,
      linkid      TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT,
      updated_at  TEXT,
      created_ts  INTEGER,
      updated_ts  INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      role            INTEGER DEFAULT 0,
      note            TEXT DEFAULT '',
      must_change_pwd INTEGER DEFAULT 0,
      created_at      TEXT,
      created_ts      INTEGER
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      note  TEXT
    );
  `);

  // ── migrations ──
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN session_id TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN sdk_trace TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN sdk_stream TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN request_response TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN callback_response TEXT`); } catch { /* */ }
  try { db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role INTEGER DEFAULT 0, note TEXT DEFAULT '', must_change_pwd INTEGER DEFAULT 0, created_at TEXT)`); } catch { /* */ }
  try { db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT)`); } catch { /* */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN must_change_pwd INTEGER DEFAULT 0`); } catch { /* */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN user_version INTEGER DEFAULT 1`); } catch { /* */ }
  try { db.exec(`ALTER TABLE agent_interfaces ADD COLUMN created_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE agent_interfaces ADD COLUMN updated_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN created_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN finished_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN created_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN created_at TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN updated_at TEXT`); } catch { /* */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN created_ts INTEGER`); } catch { /* */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN updated_ts INTEGER`); } catch { /* */ }
  try { db.exec(`CREATE TABLE IF NOT EXISTS prompt_config (key TEXT PRIMARY KEY, value_enc TEXT NOT NULL DEFAULT '', iv TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`); } catch { /* */ }
  try { db.exec(`ALTER TABLE prompt_config ADD COLUMN note TEXT DEFAULT ''`); } catch { /* */ }

  backfillTsColumns(db);
  seedDefaults(db);
  return db;
}

function backfillTsColumns(db: Database.Database): void {
  const rows = [
    { table: 'agent_interfaces', ts: 'created_ts', at: 'created_at' },
    { table: 'agent_interfaces', ts: 'updated_ts', at: 'updated_at' },
    { table: 'task_logs', ts: 'created_ts', at: 'created_at' },
    { table: 'task_logs', ts: 'finished_ts', at: 'finished_at' },
    { table: 'users', ts: 'created_ts', at: 'created_at' },
  ];
  for (const { table, ts, at } of rows) {
    const stale = db.prepare(
      `SELECT rowid, ${at} AS at_val FROM ${table} WHERE ${ts} IS NULL AND ${at} IS NOT NULL`
    ).all() as Array<{ rowid: number; at_val: string }>;
    const update = db.prepare(`UPDATE ${table} SET ${ts} = ?, ${at} = ? WHERE rowid = ?`);
    for (const r of stale) {
      const ms = Date.parse(r.at_val);
      if (Number.isNaN(ms)) continue;
      update.run(ms, fmtLocalTs(ms), r.rowid);
    }
  }
}

export function getDb(): Database.Database {
  return db;
}

// ── seed: 从 prompts/ 目录自动发现 agent_interfaces ──
export function syncInterfacesFromPrompts(promptFiles: Array<{ filename: string; path: string; name: string }>): void {
  const existingPaths = new Set(
    (db.prepare('SELECT path FROM agent_interfaces').all() as Array<{ path: string }>).map(r => r.path)
  );
  const now = nowReadable();
  const ts = nowTs();

  for (const pf of promptFiles) {
    if (existingPaths.has(pf.path)) {
      // 已有则更新 name
      db.prepare('UPDATE agent_interfaces SET name = ?, updated_at = ?, updated_ts = ? WHERE path = ?')
        .run(pf.name, now, ts, pf.path);
    } else {
      db.prepare(
        'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(uuid(), pf.name, pf.path, '', now, now, ts, ts);
    }
  }

  // 删除磁盘上已经不存在的路径
  const diskPaths = new Set(promptFiles.map(pf => pf.path));
  for (const ep of existingPaths) {
    if (!diskPaths.has(ep)) {
      db.prepare('DELETE FROM agent_interfaces WHERE path = ?').run(ep);
    }
  }
}

// ── seed: 初始 admin 用户 ──
function seedDefaults(db: Database.Database) {
  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role, note, must_change_pwd, created_at, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('admin', hashPasswordSync('admin'), 1, '默认管理员', 1, nowReadable(), nowTs());
  }
}

// ═══════════════════════════════════════════════════════════════════
// Prompt Config — 加密 KV（上传 CSV 落盘）
// ═══════════════════════════════════════════════════════════════════

export const promptConfigStore = {
  /** 批量导入 CSV 行。key 以 .token/.key/.secret/.password 或 _token/_key/_secret/_password 结尾的视为敏感。 */
  importRows(rows: Array<{ key: string; value: string; is_secret: boolean; note?: string }>): number {
    let count = 0;
    const stmt = db.prepare(
      'INSERT INTO prompt_config (key, value_enc, iv, tag, is_secret, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, iv = excluded.iv, tag = excluded.tag, is_secret = excluded.is_secret, note = excluded.note, updated_at = excluded.updated_at'
    );
    const now = nowReadable();
    for (const row of rows) {
      let enc: EncryptedValue;
      try {
        enc = encryptValue(row.value);
      } catch { continue; }
      stmt.run(row.key, enc.enc, enc.iv, enc.tag, row.is_secret ? 1 : 0, row.note ?? '', now);
      count++;
    }
    return count;
  },

  /** 获取单个 key 的明文 */
  getPlain(key: string): string | null {
    const row = db.prepare('SELECT value_enc, iv, tag FROM prompt_config WHERE key = ?').get(key) as { value_enc: string; iv: string; tag: string } | undefined;
    if (!row || !row.value_enc) return null;
    return decryptValue(row.value_enc, row.iv, row.tag);
  },

  /** 列出所有 key。敏感项默认脱敏，公开项直接明文；reveal=true 时敏感项也明文 */
  list(reveal = false): Array<{ key: string; value: string; is_secret: boolean; note: string; updated_at: string }> {
    const rows = db.prepare('SELECT key, value_enc, iv, tag, is_secret, note, updated_at FROM prompt_config ORDER BY key').all() as Array<{
      key: string; value_enc: string; iv: string; tag: string; is_secret: number; note: string; updated_at: string;
    }>;
    return rows.map((r) => {
      const plain = r.value_enc ? decryptValue(r.value_enc, r.iv, r.tag) : '';
      const isSecret = r.is_secret === 1;
      // 公开项直接返回明文；敏感项默认脱敏，reveal 时返回明文
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
  getAllPlain(): Map<string, string> {
    const m = new Map<string, string>();
    const rows = db.prepare('SELECT key, value_enc, iv, tag FROM prompt_config').all() as Array<{ key: string; value_enc: string; iv: string; tag: string }>;
    for (const r of rows) {
      if (!r.value_enc) continue;
      const plain = decryptValue(r.value_enc, r.iv, r.tag);
      if (plain !== null) m.set(r.key, plain);
    }
    return m;
  },

  /** 清空所有配置（重新上传 CSV 前用） */
  clearAll(): void {
    db.prepare('DELETE FROM prompt_config').run();
  },

  /** key 数量 */
  count(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM prompt_config').get() as { c: number }).c;
  },

  /** 获取所有 key 名，用于占位符校验 */
  listKeys(): string[] {
    return (db.prepare('SELECT key FROM prompt_config ORDER BY key').all() as Array<{ key: string }>).map(r => r.key);
  },
};

function maskValue(plain: string | null): string {
  if (!plain) return '';
  if (plain.length <= 4) return '****';
  return plain.substring(0, 2) + '****' + plain.substring(plain.length - 2);
}

// ═══════════════════════════════════════════════════════════════════
// Agent Interfaces — 保留路径映射，prompt 列废弃（改走磁盘文件）
// ═══════════════════════════════════════════════════════════════════

export const interfacesStore = {
  list(): AgentInterface[] {
    return db.prepare('SELECT * FROM agent_interfaces ORDER BY created_at DESC').all() as AgentInterface[];
  },
  get(id: string): AgentInterface | undefined {
    return db.prepare('SELECT * FROM agent_interfaces WHERE id = ?').get(id) as AgentInterface | undefined;
  },
  getByPath(path: string): AgentInterface | undefined {
    return db.prepare('SELECT * FROM agent_interfaces WHERE path = ?').get(path) as AgentInterface | undefined;
  },
  create(name: string, path: string, prompt: string): AgentInterface {
    const id = uuid();
    const now = nowReadable();
    const ts = nowTs();
    db.prepare(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, path, prompt, now, now, ts, ts);
    return this.get(id)!;
  },
  update(id: string, name: string, path: string, prompt: string): AgentInterface | undefined {
    const now = nowReadable();
    const ts = nowTs();
    db.prepare(
      'UPDATE agent_interfaces SET name = ?, path = ?, prompt = ?, updated_at = ?, updated_ts = ? WHERE id = ?'
    ).run(name, path, prompt, now, ts, id);
    return this.get(id);
  },
  remove(id: string): boolean {
    return db.prepare('DELETE FROM agent_interfaces WHERE id = ?').run(id).changes > 0;
  },
};

// ═══════════════════════════════════════════════════════════════════
// Task logs / sessions / users / config — unchanged below
// ═══════════════════════════════════════════════════════════════════

export const taskLogsStore = {
  create(log: TaskLog): void {
    db.prepare(
      `INSERT INTO task_logs
       (task_id, linkid, session_id, path, interface_id, status, request_body, request_response, prompt, sdk_output, sdk_trace, error_message, created_at, finished_at, created_ts, finished_ts)
       VALUES (@task_id, @linkid, @session_id, @path, @interface_id, @status, @request_body, @request_response, @prompt, @sdk_output, @sdk_trace, @error_message, @created_at, @finished_at, @created_ts, @finished_ts)`
    ).run(log);
  },
  updateStatus(taskId: string, status: TaskStatus): void {
    db.prepare('UPDATE task_logs SET status = ? WHERE task_id = ?').run(status, taskId);
  },
  updateResult(taskId: string, fields: Partial<TaskLog>): void {
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
    db.prepare(`UPDATE task_logs SET ${sets.join(', ')} WHERE task_id = ?`).run(...vals);
  },
  get(taskId: string): TaskLog | undefined {
    return db.prepare('SELECT * FROM task_logs WHERE task_id = ?').get(taskId) as TaskLog | undefined;
  },
  getLatestByLinkid(linkid: string): TaskLog | undefined {
    return db.prepare(
      'SELECT * FROM task_logs WHERE linkid = ? ORDER BY created_at DESC LIMIT 1'
    ).get(linkid) as TaskLog | undefined;
  },
  list(limit = 100): TaskLog[] {
    return db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?').all(limit) as TaskLog[];
  },
  listPaged(offset: number, limit: number): { items: TaskLog[]; total: number } {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs').get() as { c: number }).c;
    const items = db.prepare(
      'SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as TaskLog[];
    return { items, total };
  },
  countActive(): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM task_logs WHERE status IN ('pending', 'processing')`
    ).get() as { c: number };
    return row.c;
  },
  listActive(): TaskLog[] {
    return db.prepare(
      `SELECT * FROM task_logs WHERE status IN ('pending', 'processing') ORDER BY created_at ASC`
    ).all() as TaskLog[];
  },
  hasActiveByLinkid(linkid: string): boolean {
    const row = db.prepare(
      `SELECT 1 AS c FROM task_logs WHERE linkid = ? AND status IN ('pending', 'processing') LIMIT 1`
    ).get(linkid);
    return !!row;
  },
  deleteExpired(retentionDays: number): number {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    const result = db.prepare(
      `DELETE FROM task_logs
       WHERE created_ts < ?
         AND status NOT IN ('pending', 'processing')`
    ).run(cutoffMs);
    return result.changes;
  },
  listTaskIds(): string[] {
    return (db.prepare('SELECT task_id FROM task_logs').all() as Array<{ task_id: string }>)
      .map((r) => r.task_id);
  },
  search(taskId: string, linkid: string, limit = 100): TaskLog[] {
    if (taskId && linkid) {
      return db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%${taskId}%`, `%${linkid}%`, limit) as TaskLog[];
    }
    if (taskId) {
      return db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%${taskId}%`, limit) as TaskLog[];
    }
    if (linkid) {
      return db.prepare('SELECT * FROM task_logs WHERE linkid LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%${linkid}%`, limit) as TaskLog[];
    }
    return db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?').all(limit) as TaskLog[];
  },
  searchPaged(taskId: string, linkid: string, offset: number, limit: number): { items: TaskLog[]; total: number } {
    const like = (s: string) => `%${s}%`;
    const items: TaskLog[] = [];
    let total = 0;
    if (taskId && linkid) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ?').get(like(taskId), like(linkid)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(taskId), like(linkid), limit, offset) as TaskLog[]);
    } else if (taskId) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE task_id LIKE ?').get(like(taskId)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(taskId), limit, offset) as TaskLog[]);
    } else if (linkid) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE linkid LIKE ?').get(like(linkid)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE linkid LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(linkid), limit, offset) as TaskLog[]);
    } else {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs').get() as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as TaskLog[]);
    }
    return { items, total };
  },
};

export const sessionsStore = {
  upsert(sessionId: string, linkid: string): Session {
    const now = nowReadable();
    const ts = nowTs();
    const existing = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (existing) {
      db.prepare('UPDATE sessions SET updated_at = ?, updated_ts = ? WHERE session_id = ?').run(now, ts, sessionId);
    } else {
      db.prepare(
        'INSERT INTO sessions (session_id, linkid, status, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, linkid, 'active', now, now, ts, ts);
    }
    return this.get(sessionId)!;
  },
  get(sessionId: string): Session | undefined {
    return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Session | undefined;
  },
  getByLinkid(linkid: string): Session | undefined {
    return db.prepare(
      'SELECT * FROM sessions WHERE linkid = ? AND status = ?'
    ).get(linkid, 'active') as Session | undefined;
  },
  listAll(): Session[] {
    return db.prepare('SELECT * FROM sessions ORDER BY updated_ts DESC').all() as Session[];
  },
  remove(sessionId: string): boolean {
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
  deleteExpired(retentionDays: number): Session[] {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    const expired = db.prepare(
      'SELECT * FROM sessions WHERE updated_ts < ?'
    ).all(cutoffMs) as Session[];
    db.prepare('DELETE FROM sessions WHERE updated_ts < ?').run(cutoffMs);
    return expired;
  },
};

export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function comparePasswordSync(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export const usersStore = {
  get(username: string): User | undefined {
    return db.prepare(
      'SELECT id, username, password_hash, role, note, COALESCE(must_change_pwd,0) AS must_change_pwd, COALESCE(user_version,1) AS user_version, COALESCE(created_at,\'\') AS created_at, created_ts FROM users WHERE username = ?'
    ).get(username) as User | undefined;
  },
  list(): User[] {
    return db.prepare(
      'SELECT id, username, password_hash, role, note, COALESCE(must_change_pwd,0) AS must_change_pwd, COALESCE(user_version,1) AS user_version, COALESCE(created_at,\'\') AS created_at, created_ts FROM users ORDER BY id'
    ).all() as User[];
  },
  updatePassword(username: string, hash: string): boolean {
    return db.prepare('UPDATE users SET password_hash = ?, user_version = user_version + 1 WHERE username = ?').run(hash, username).changes > 0;
  },
  clearMustChangePwd(username: string): boolean {
    return db.prepare('UPDATE users SET must_change_pwd = 0 WHERE username = ?').run(username).changes > 0;
  },
  incrementUserVersion(username: string): void {
    db.prepare('UPDATE users SET user_version = user_version + 1 WHERE username = ?').run(username);
  },
  getAllVersions(): Map<string, number> {
    const rows = db.prepare('SELECT username, COALESCE(user_version,1) AS user_version FROM users').all() as Array<{ username: string; user_version: number }>;
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.username, r.user_version);
    return m;
  },
  create(username: string, hash: string, role: number, note: string): boolean {
    try {
      db.prepare(
        'INSERT INTO users (username, password_hash, role, note, must_change_pwd, user_version, created_at, created_ts) VALUES (?, ?, ?, ?, 0, 1, ?, ?)'
      ).run(username, hash, role, note, nowReadable(), nowTs());
      return true;
    } catch {
      return false;
    }
  },
  remove(username: string): boolean {
    return db.prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0;
  },
};

export const configStore = {
  get(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  },
  set(key: string, value: string, note?: string): void {
    db.prepare('INSERT INTO config (key, value, note) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, note = excluded.note').run(key, value, note ?? '');
  },
};