/**
 * Redis 协调层
 *
 * 控制面多实例共享的协调状态：任务队列、linkid 锁、活跃任务、runner 负载计数、
 * SSE pub/sub、leader 租约。Redis 只存「可重建的协调态」，任务终态始终落 MySQL。
 */
import { Redis } from 'ioredis';
import { getLogger } from '../logger.js';

const log = getLogger();

let client: Redis | null = null;
// pub/sub 需要独立连接：ioredis 单连接进入 subscriber 模式后不能执行普通命令
let subscriber: Redis | null = null;
let keyPrefix = 'dp:';
let instanceId = '';

export interface RedisConfig {
  url: string;
  key_prefix: string;
}

export async function initRedis(cfg: RedisConfig): Promise<Redis> {
  keyPrefix = cfg.key_prefix;
  client = new Redis(cfg.url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    enableReadyCheck: true,
  });

  client.on('error', (err) => log.error({ error: String(err) }, 'redis_error'));
  client.on('ready', () => log.info({ url: cfg.url }, 'redis_ready'));

  // 每个实例一个随机 id，用于取消路由 / 任务归属
  instanceId = Math.random().toString(36).slice(2, 10);
  log.info({ instanceId }, 'redis_instance_registered');
  return client;
}

export function getRedis(): Redis {
  if (!client) throw new Error('Redis 未初始化');
  return client;
}

export function getInstanceId(): string {
  return instanceId;
}

export function k(key: string): string {
  return keyPrefix + key;
}

export async function closeRedis(): Promise<void> {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
  if (client) {
    await client.quit();
    client = null;
  }
}

// ── 队列（dp:queue:pending） ──
export const queue = {
  /** 入队（尾部） */
  async push(taskId: string): Promise<void> {
    await getRedis().rpush(k('queue:pending'), taskId);
  },
  /** 放回队头（优先级高于后续任务） */
  async pushFront(taskId: string): Promise<void> {
    await getRedis().lpush(k('queue:pending'), taskId);
  },
  /** 阻塞弹出（头部，FIFO）；超时返回 null */
  async pop(timeoutSec = 2): Promise<string | null> {
    const res = await getRedis().blpop(k('queue:pending'), timeoutSec);
    return res ? res[1] : null;
  },
  /** 从队列中移除指定 task_id（取消 pending 任务），返回移除条数 */
  async remove(taskId: string): Promise<number> {
    return getRedis().lrem(k('queue:pending'), 0, taskId);
  },
  async len(): Promise<number> {
    return getRedis().llen(k('queue:pending'));
  },
};

// ── linkid 占用锁（SET NX EX） ──
export const linkidLock = {
  async acquire(linkid: string, ttlSec = 3600): Promise<boolean> {
    const ok = await getRedis().set(k(`lock:linkid:${linkid}`), instanceId, 'EX', ttlSec, 'NX');
    return ok === 'OK';
  },
  async release(linkid: string): Promise<void> {
    await getRedis().del(k(`lock:linkid:${linkid}`));
  },
};

// ── 并发信号量（dp:sem:running） ──
export const semaphore = {
  async incr(): Promise<number> {
    return getRedis().incr(k('sem:running'));
  },
  async decr(): Promise<number> {
    const v = await getRedis().decr(k('sem:running'));
    if (v < 0) await getRedis().set(k('sem:running'), 0);
    return v;
  },
  async reset(): Promise<void> {
    await getRedis().set(k('sem:running'), 0);
  },
  async value(): Promise<number> {
    const v = await getRedis().get(k('sem:running'));
    return v ? Number(v) : 0;
  },
};

// ── 活跃任务（dp:active:{task_id} → HASH） ──
export const activeTasks = {
  async set(taskId: string, fields: Record<string, string>): Promise<void> {
    await getRedis().hset(k(`active:${taskId}`), fields);
  },
  async get(taskId: string): Promise<Record<string, string> | null> {
    const v = await getRedis().hgetall(k(`active:${taskId}`));
    return Object.keys(v).length ? v : null;
  },
  async del(taskId: string): Promise<void> {
    await getRedis().del(k(`active:${taskId}`));
  },
  /** 本实例持有的所有活跃 task_id */
  async listMine(): Promise<string[]> {
    return getRedis().smembers(k(`inst:${instanceId}:tasks`));
  },
  async addMine(taskId: string): Promise<void> {
    await getRedis().sadd(k(`inst:${instanceId}:tasks`), taskId);
  },
  async removeMine(taskId: string): Promise<void> {
    await getRedis().srem(k(`inst:${instanceId}:tasks`), taskId);
  },
};

// ── runner 已派发计数（dp:runner:assigned:{id}） ──
export const runnerAssigned = {
  async incr(runnerId: string): Promise<number> {
    return getRedis().incr(k(`runner:assigned:${runnerId}`));
  },
  async decr(runnerId: string): Promise<number> {
    const v = await getRedis().decr(k(`runner:assigned:${runnerId}`));
    if (v < 0) await getRedis().set(k(`runner:assigned:${runnerId}`), 0);
    return v;
  },
  async get(runnerId: string): Promise<number> {
    const v = await getRedis().get(k(`runner:assigned:${runnerId}`));
    return v ? Number(v) : 0;
  },
};

// ── SSE pub/sub（dp:sse:{session_id}） ──
export const sseBus = {
  async publish(sessionId: string, message: unknown): Promise<void> {
    await getRedis().publish(k(`sse:${sessionId}`), JSON.stringify(message));
  },
};

// ── 取消路由（统一广播频道 dp:cancel） ──
// 消息：JSON { kind: 'task'|'linkid', target: string }
// 所有实例都订阅该频道，收到后查自己 active 中是否命中，命中则 abort。
// 相比「点对点」定向到实例，广播更简单且容忍实例 id 漂移（实例重启后 id 变化也不丢取消）。
export const cancelRoute = {
  async publishTask(taskId: string): Promise<void> {
    await getRedis().publish(k('cancel'), JSON.stringify({ kind: 'task', target: taskId }));
  },
  async publishLinkid(linkid: string): Promise<void> {
    await getRedis().publish(k('cancel'), JSON.stringify({ kind: 'linkid', target: linkid }));
  },
  /** 订阅取消广播。handler 收到解析后的 { kind, target }。 */
  async subscribe(handler: (msg: { kind: 'task' | 'linkid'; target: string }) => void): Promise<void> {
    if (!subscriber) {
      subscriber = getRedis().duplicate();
      subscriber.on('error', (err) => log.error({ error: String(err) }, 'redis_subscriber_error'));
      await subscriber.subscribe(k('cancel'));
    }
    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== k('cancel')) return;
      try {
        const parsed = JSON.parse(message) as { kind: 'task' | 'linkid'; target: string };
        if (parsed && (parsed.kind === 'task' || parsed.kind === 'linkid') && typeof parsed.target === 'string') {
          handler(parsed);
        }
      } catch { /* 坏消息忽略 */ }
    });
  },
};

// ── leader 租约（SET NX EX + 续约） ──
export const leader = {
  async tryAcquire(lockName: string, ttlSec = 10): Promise<boolean> {
    const ok = await getRedis().set(k(`lock:${lockName}`), instanceId, 'EX', ttlSec, 'NX');
    return ok === 'OK';
  },
  async renew(lockName: string, ttlSec = 10): Promise<boolean> {
    // 只有当前实例持有才续约
    const holder = await getRedis().get(k(`lock:${lockName}`));
    if (holder !== instanceId) return false;
    await getRedis().expire(k(`lock:${lockName}`), ttlSec);
    return true;
  },
  async release(lockName: string): Promise<void> {
    const holder = await getRedis().get(k(`lock:${lockName}`));
    if (holder === instanceId) await getRedis().del(k(`lock:${lockName}`));
  },
};
