# 控制面多实例 HA 工作机制（MySQL + Redis）

> 状态：实施中。目标是把控制面从「单实例 + 本机 SQLite」改造成「多实例 + 共享 MySQL + Redis 协调层」，前面挂 LB 消除单点。Runner 层不变（已是无状态可扩）。

---

## 1. 目标架构

```
                 LB / 反向代理（终止 TLS）
              ┌──────────┴──────────┐
         控制面 #1             控制面 #2      ← 无状态，可水平扩
              └──────────┬──────────┘
                         │
        ┌────────────────┼────────────────┐
     Redis            MySQL            共享卷
   队列/锁/计数       持久化            prompts/ + data/memory/
   pub/sub/租约                        cfg.yml
                         │
            runner #1  runner #2 ...      ← 不变
```

| 组件 | 职责 | 状态 |
|------|------|------|
| MySQL | 全部业务数据持久化（8 张表），多实例共享 | ✅ 已接入 |
| Redis | 队列、并发信号量、linkid 锁、活跃任务注册、取消广播 | ✅ 队列/锁/取消已接入；其余见 §5 |
| 共享卷 | `prompts/`、`data/memory/`、`cfg.yml` 让所有实例看到同一份 | ⚠️ 需部署时挂载，代码已就绪 |
| LB | 外部流量分发到任意控制面实例 | ⚠️ 部署侧，尚未编排 |

---

## 2. 持久层：SQLite → MySQL

### 2.1 迁移内容

| 原（SQLite） | 新 | 说明 |
|-------------|-----|------|
| `better-sqlite3` 同步 API | `mysql2/promise` 异步 API | `store.ts` 全量异步化，所有方法返回 Promise |
| 本机 `data/app.db` | MySQL（Docker 容器） | 多实例共享同一 MySQL |
| 本机 `data/secrets.key` | 环境变量 `SECRETS_KEY` 优先 | 多实例同一密钥才能解密 `prompt_config` |
| `TEXT PRIMARY KEY` | `VARCHAR(36) PRIMARY KEY` | MySQL TEXT 不能做主键 |
| `ON CONFLICT(x) DO UPDATE` | `ON DUPLICATE KEY UPDATE` | upsert 方言适配 |
| `PRAGMA journal_mode=WAL` | InnoDB | 无对应项 |

### 2.2 数据访问层

- `src/db.ts`：连接池 + `queryAll` / `queryOne` / `exec` / `execInsert` 四个助手 + `initSchema()` 幂等建表。
- `src/store.ts`：`promptConfigStore` / `interfacesStore` / `taskLogsStore` / `sdkTracesStore` / `sessionsStore` / `runnersStore` / `usersStore` / `configStore` 全部改为 async。
- `src/crypto.ts`：`initCrypto()` 先读 `SECRETS_KEY`（hex 32 字节），未设置则回退本机 `data/secrets.key`（单机兼容）。

### 2.3 表清单

`agent_interfaces`、`prompt_config`、`task_logs`、`sessions`、`users`、`config`、`sdk_traces`、`runners`，共 8 张，与旧 SQLite 一一对应。索引保留 `task_logs(created_ts)`、`task_logs(linkid, created_ts)`、`task_logs(status)`、`sessions(updated_ts)`。

---

## 3. 协调层：Redis

### 3.1 Redis 是什么、不是什么

Redis 只存**可重建的协调态**，不是权威数据源。任务终态、session、配置全部在 MySQL。Redis 挂了只影响派发/推送，MySQL 里的数据不丢。

### 3.2 Key 规划（前缀 `dp:`，可配置）

| 用途 | Key | 类型 | 状态 |
|------|-----|------|------|
| 待处理队列 | `queue:pending` | LIST | ✅ 已接入 |
| linkid 占用锁 | `lock:linkid:{linkid}` | STRING (SET NX EX) | ✅ 已接入 |
| 并发信号量 | `sem:running` | STRING (INCR/DECR) | ✅ 已接入 |
| 活跃任务归属 | `active:{task_id}` | HASH | ✅ 已接入 |
| 本实例任务集合 | `inst:{instance_id}:tasks` | SET | ✅ 已接入 |
| 取消广播 | `cancel` | PUB/SUB | ✅ 已接入 |
| runner 已派发计数 | `runner:assigned:{id}` | STRING (INCR/DECR) | ⚠️ 原语已写，dispatcher 未接入 |
| SSE 频道 | `sse:{session_id}` | PUB/SUB | ⚠️ 原语已写，sse-bus 未接入 |
| 心跳 leader 锁 | `lock:heartbeat` | STRING (SET NX EX) | ⚠️ 原语已写，dispatcher 未接入 |
| 启动恢复锁 | `lock:recover` | STRING (SET NX EX) | ⚠️ 原语已写，未接入 |
| 清理锁 | `lock:cleanup` | STRING (SET NX EX) | ⚠️ 原语已写，未接入 |

> `src/services/redis.ts` 暴露 `queue` / `semaphore` / `linkidLock` / `activeTasks` / `runnerAssigned` / `sseBus` / `cancelRoute` / `leader` 八组原语。§3.3–§3.6 是**已接入**的部分。

### 3.3 任务队列（已接入）

队列从「进程内存 `pending[]`」改为 Redis LIST：

```
enqueue:
  task_logs 落库（status=pending）→ RPUSH queue:pending

每个实例的消费者循环 pump():
  1. INCR sem:running，若 > max_concurrent_tasks 则 DECR + 退避
  2. BLPOP queue:pending（阻塞 2s）
  3. 从 MySQL 读 task_logs 重建 WorkerItem
  4. SET lock:linkid:{linkid} NX EX：抢不到 → LPUSH 回队头 + 退避
  5. 执行 processItem（逻辑与旧版一致，只是落库走 MySQL）
  6. finally：释放 linkid 锁 + DECR sem:running
```

- 每个控制面实例都跑一个 `pump()`，从同一个 Redis 队列抢任务 → 天然水平扩。
- `sem:running` 是全局并发闸门；`max_concurrent_tasks` 仍是全局上限（不是每实例上限）。
- `linkid` 锁是跨实例的同 linkid 串行兜底（提交侧已有 `hasActiveByLinkid` 检查，锁堵 TOCTOU 竞态）。

### 3.4 并发信号量（已接入）

`getRunningCount()` 返回本实例 `active.size`；`getPendingCount()` 返回 `queue.len()`（Redis 全局排队数）。提交侧的队列上限检查 `running + pending` 据此计算。

### 3.5 活跃任务注册（已接入）

任务出队执行时写：

```
HSET active:{task_id}  { linkid, instance_id }
SADD inst:{instance_id}:tasks {task_id}
```

用途：跨实例取消时定位「任务在哪个实例」。任务收尾时 DEL / SREM。

### 3.6 跨实例取消（已接入）

这是多实例正确性的关键。原来 `AbortController` 只在持有任务的实例内存里，其它实例无法直接 abort。现在用 **Redis pub/sub 统一广播频道 `cancel`**：

```
取消请求到达实例 A：
  1. 查本实例 active Map → 命中直接 abort
  2. LREM queue:pending 移除排队任务 → 命中返回 pending
  3. 都未命中 → PUBLISH cancel {"kind":"task","target":task_id}

每个实例订阅 cancel 频道：
  收到 {kind:'task'}    → 查本实例 active，命中 abort
  收到 {kind:'linkid'}  → abort 本实例 active 中该 linkid 的所有任务
```

- **用广播而非点对点**：实例重启后 `instanceId` 会变，点对点频道会发到失效 id；广播让订阅方自己判断命中，容忍实例漂移。
- **独立订阅连接**：ioredis 单连接进入 subscriber 模式后不能执行普通命令，故用 `getRedis().duplicate()` 建独立 `subscriber`。
- 两种粒度：`cancelTask(task_id)` 精确取消；`cancelByLinkidInQueue(linkid)` 删会话时批量取消。
- 排队任务兜底：`taskLogsStore.cancelByLinkid` 落库 `cancelled` 后，消费者读到非 `pending` 自动跳过。

---

## 4. 启动与恢复

### 4.1 启动流程（`src/index.ts`）

```
loadConfig → ensureDirs → initLogger
→ initStore（crypto 密钥）
→ initDb（MySQL 建连接池 + 建表）
→ initRedis（Redis 连接 + 实例注册）
→ seedDefaults（无用户则建 admin）
→ migrateApiTokenToHash（一次性）
→ syncInterfacesFromPrompts（prompts/ → agent_interfaces）
→ initDispatcher（runner 列表同步 + 心跳）
→ initTaskQueue（恢复孤儿任务 + 订阅取消广播 + 启动消费者循环）
→ Express 监听
```

### 4.2 孤儿任务恢复（`recoverOrphanedTasks`）

- `pending` 任务：重新 `RPUSH` 进 Redis 队列。
- `processing` 任务：落 `failed`（原进程已退出，SDK 被连接断开中断）。

> ⚠️ 当前未加 `lock:recover` 锁。**多实例同时启动时会重复执行恢复**：`pending` 任务被重复入队（幂等，但会重复派发），`processing` 重复落 `failed`（幂等覆盖）。需要在 `initTaskQueue` 里抢 `lock:recover` 后只让一个实例执行。

---

## 5. 已知未完成项（如实记录）

| 项 | 现状 | 影响 | 建议 |
|----|------|------|------|
| **dispatcher 负载计数仍是内存态** | `assigned` / `runningCount` 是进程 Map，未用 `runnerAssigned` 原语 | 多实例下各自算选路计数，可能超卖 runner 容量 | 接入 `runnerAssigned`（Redis INCR/DECR） |
| **sse-bus 仍是进程内存** | `channels Map` 未用 Redis pub/sub | 前端 SSE 连在实例 A，消息从实例 B 产生收不到 | 接入 `sseBus` pub/sub + 本机订阅者过滤 |
| **心跳/恢复/清理未加 leader 锁** | 每实例都跑心跳、清理定时器、恢复 | 心跳重复轮询（浪费但无害）；恢复重复（§4.2）；清理重复删数据（幂等但浪费） | 接入 `leader` 租约 |
| **compose 编排** | 未加 MySQL/Redis/LB 服务 | 无法直接 `up` 起多实例 | 补 `compose.control.yml` + nginx/traefik LB |
| **共享卷挂载** | 代码就绪，部署未配置 | 多实例各自 prompts/memory 不一致 | compose 里挂同一卷 |

---

## 6. 配置参考（`data/cfg.yml`）

```yaml
mysql:
  host: "mysql"                # Docker compose 内服务名；跨机填内网 IP/域名
  port: 3306
  user: "dp_agt"
  password: ""                 # 建议用 MYSQL_PASSWORD 环境变量注入
  database: "dp_agt"
  connection_limit: 10

redis:
  url: "redis://redis:6379"    # Docker compose 内服务名
  key_prefix: "dp:"
```

环境变量映射：

| 配置 | 环境变量 |
|------|---------|
| `mysql.host` | `MYSQL_HOST` |
| `mysql.port` | `MYSQL_PORT` |
| `mysql.user` | `MYSQL_USER` |
| `mysql.password` | `MYSQL_PASSWORD` |
| `mysql.database` | `MYSQL_DATABASE` |
| `mysql.connection_limit` | `MYSQL_CONNECTION_LIMIT` |
| `redis.url` | `REDIS_URL` |
| `redis.key_prefix` | `REDIS_KEY_PREFIX` |
| 加密密钥 | `SECRETS_KEY`（hex 32 字节，多实例必须一致） |

---

## 7. 回滚与兼容

- **回退单机 SQLite 已不可行**：`better-sqlite3` 依赖已移除，`store.ts` 已是 MySQL 异步实现。要回滚需 revert 本批 commit。
- **runner 层完全不变**：控制面 ↔ runner 的 `/run` NDJSON 协议、心跳、会话代理接口无任何改动。
- **对外接口不变**：`POST /api/v1/*`、任务查询/取消/trace/时间线的 URL 与响应格式不变。
