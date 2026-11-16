# 控制面多实例 HA 设计（MySQL + Redis）

> 状态：实施中。控制面前挂 LB，多实例水平扩展，消除「控制面单点」。
> Runner 层不变（已是无状态可扩）；本文只改控制面。

## 目标架构

```
                 LB / 反向代理（终止 TLS，sticky session 可选）
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

## 数据层迁移

| 原（SQLite） | 新 | 说明 |
|-------------|-----|------|
| `better-sqlite3` 同步 API | `mysql2/promise` 异步 API | store.ts 全量异步化 |
| 本机 `data/app.db` | MySQL（Docker 容器） | 所有实例共享同一 MySQL |
| 本机 `data/secrets.key` | 环境变量 `SECRETS_KEY` | 各实例同一密钥才能解密 prompt_config |
| 本机 `prompts/`、`data/memory/` | 共享卷挂载 | 管理台上传即时对所有实例一致 |

## Redis 协调层

| 用途 | Key | 类型 |
|------|-----|------|
| 待处理队列 | `dp:queue:pending` | LIST |
| linkid 占用 | `dp:lock:linkid:{linkid}` | STRING (SET NX EX) |
| 活跃任务 | `dp:active:{task_id}` | HASH |
| runner 已派发计数 | `dp:runner:assigned:{id}` | STRING (INCR/DECR) |
| 并发槽 | `dp:sem:running` | STRING (INCR/DECR) |
| SSE 频道 | `dp:sse:{session_id}` | PUB/SUB |
| 心跳 leader | `dp:lock:heartbeat` | STRING (SET NX EX) |
| 启动恢复锁 | `dp:lock:recover` | STRING (SET NX EX) |
| 取消路由 | `dp:inst:{id}:cancel` | PUB/SUB |

## 实施步骤

- [x] 阶段 1a：db.ts + redis.ts + config + store 异步化（本周）
- [ ] 阶段 1b：task-queue 队列/锁/信号量迁 Redis
- [ ] 阶段 1c：sse-bus pub/sub、dispatcher 计数、取消路由
- [ ] 阶段 1d：compose 编排 + 灰度