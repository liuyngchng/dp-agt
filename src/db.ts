/**
 * MySQL 连接池与 schema 初始化
 *
 * 控制面多实例共享同一 MySQL。所有实例启动时幂等执行 initSchema()，
 * 建表/索引（CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）。
 * 类型与旧 SQLite 表一一对应，仅做方言适配。
 */
import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { getLogger } from './logger.js';

const log = getLogger();

let pool: Pool | null = null;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connection_limit: number;
}

export async function initDb(cfg: DbConfig): Promise<Pool> {
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connection_limit,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    // 大字段（sdk_trace/sdk_output/prompt/request_body）与中文兼容
    timezone: 'local',
    dateStrings: true,
  });

  // 连接池默认懒连接：启动时显式探活一次，失败早暴露
  await pool.query('SELECT 1');
  await initSchema(pool);
  log.info({ host: cfg.host, port: cfg.port, database: cfg.database }, 'mysql_ready');
  return pool;
}

export function getDb(): Pool {
  if (!pool) throw new Error('MySQL 连接池未初始化');
  return pool;
}

/** 关闭连接池（进程退出清理用） */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type DbRow = RowDataPacket;

/** 查询多行（SELECT） */
export async function queryAll<T = RowDataPacket>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await getDb().query(sql, params);
  return rows as T[];
}

/** 查询单行（SELECT，无结果返回 undefined） */
export async function queryOne<T = RowDataPacket>(sql: string, params: any[] = []): Promise<T | undefined> {
  const [rows] = await getDb().query(sql, params);
  return (rows as T[])[0];
}

/** 执行写操作（INSERT/UPDATE/DELETE），返回受影响行数 */
export async function exec(sql: string, params: any[] = []): Promise<number> {
  const [result] = await getDb().execute(sql, params);
  return (result as ResultSetHeader).affectedRows;
}

/** 执行写操作并返回 insertId（INSERT 用） */
export async function execInsert(sql: string, params: any[] = []): Promise<number> {
  const [result] = await getDb().execute(sql, params);
  return (result as ResultSetHeader).insertId;
}

/**
 * 幂等建表 + 索引。与旧 store.ts 的 SQLite schema 对齐：
 *  - TEXT PRIMARY KEY → VARCHAR(36) PRIMARY KEY
 *  - TEXT → LONGTEXT（大字段）/ VARCHAR（短字段）
 *  - INTEGER 0/1 布尔 → TINYINT
 */
async function initSchema(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_interfaces (
      id          VARCHAR(36) PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      path        VARCHAR(255) NOT NULL UNIQUE,
      prompt      LONGTEXT NOT NULL,
      created_at  VARCHAR(32),
      updated_at  VARCHAR(32),
      created_ts  BIGINT,
      updated_ts  BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_config (
      key         VARCHAR(128) PRIMARY KEY,
      value_enc   LONGTEXT NOT NULL,
      iv          VARCHAR(64) NOT NULL,
      tag         VARCHAR(64) NOT NULL,
      is_secret   TINYINT NOT NULL DEFAULT 0,
      note        VARCHAR(512),
      updated_at  VARCHAR(32)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS task_logs (
      task_id       VARCHAR(36) PRIMARY KEY,
      linkid        VARCHAR(255),
      session_id    VARCHAR(128),
      path          VARCHAR(255),
      interface_id  VARCHAR(36),
      status        VARCHAR(16),
      request_body  LONGTEXT,
      request_response LONGTEXT,
      prompt        LONGTEXT,
      sdk_output    LONGTEXT,
      callback_body LONGTEXT,
      callback_response LONGTEXT,
      callback_url  VARCHAR(1024),
      error_message LONGTEXT,
      runner_id     VARCHAR(36),
      created_at    VARCHAR(32),
      finished_at   VARCHAR(32),
      created_ts    BIGINT,
      finished_ts   BIGINT,
      started_ts    BIGINT,
      KEY idx_task_logs_created_ts (created_ts DESC),
      KEY idx_task_logs_linkid_created_ts (linkid, created_ts DESC),
      KEY idx_task_logs_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id  VARCHAR(128) PRIMARY KEY,
      linkid      VARCHAR(255) NOT NULL UNIQUE,
      status      VARCHAR(16) NOT NULL DEFAULT 'active',
      runner_id   VARCHAR(36),
      created_at  VARCHAR(32),
      updated_at  VARCHAR(32),
      created_ts  BIGINT,
      updated_ts  BIGINT,
      KEY idx_sessions_updated_ts (updated_ts DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      username        VARCHAR(128) NOT NULL UNIQUE,
      password_hash   VARCHAR(255) NOT NULL,
      role            INT DEFAULT 0,
      note            VARCHAR(512),
      must_change_pwd TINYINT DEFAULT 0,
      user_version    INT DEFAULT 1,
      created_at      VARCHAR(32),
      created_ts      BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS config (
      key   VARCHAR(128) PRIMARY KEY,
      value LONGTEXT NOT NULL,
      note  VARCHAR(512)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sdk_traces (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      task_id   VARCHAR(36) NOT NULL UNIQUE,
      sdk_trace LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS runners (
      id                VARCHAR(36) PRIMARY KEY,
      name              VARCHAR(128) NOT NULL UNIQUE,
      addr              VARCHAR(255) NOT NULL,
      capacity          INT NOT NULL DEFAULT 5,
      status            VARCHAR(16) NOT NULL DEFAULT 'up',
      last_heartbeat_ts BIGINT,
      created_at        VARCHAR(32),
      updated_at        VARCHAR(32)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
