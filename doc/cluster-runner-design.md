# AI 数字员工横向扩展设计（方案 A 阶段 1：控制面 + 无状态 runner 拆分）

> 状态：设计草案，待评审。
> 范围：只做「控制面（调度/管理）+ 无状态 runner（执行）」的拆分，**不上** Postgres / Redis / 共享文件系统（那是后续阶段 2 的事）。
> 目标：让「跑 Claude Agent SDK」这个重活可以水平扩容，控制面保持单实例（轻量、单 SQLite 写者）。

---

## 1. 背景与结论

当前 dp-agt 是单实例：队列状态全在内存（`task-queue.ts` 的 `running` / `pending[]` / `linkChains` / `active`），SDK 子进程由本机 `/proc` 看门狗管理，session 历史和工作目录都在本机 `runtime/` 下。直接复制 N 份 + 负载均衡会出错（详见 `doc/` 之外的评审结论），但瓶颈只集中在「执行 SDK」这一层。

**拆分策略**：把「执行任务」从「调度/管理」中拆出，做成无状态、可水平扩容的 runner。控制面继续负责路由、鉴权、SQLite、提示词渲染、队列与 linkid 串行；runner 只负责「在一个工作目录里跑一次 SDK 并回传消息流」。

一个影响面很大、必须在阶段 1 一起处理的点：管理后台的**会话记录读取 / 工作目录文件浏览 / 下载 / 删除会话**现在直接读控制面本机磁盘（`admin.ts:290-520`），拆开后这些数据在 runner 本地。阶段 1 必须把这些接口改为「控制面按 `linkid → runner` 转发」。

---

## 2. 目标架构

```
                      ┌────────── LB / 反向代理（终止 TLS）──────────┐
                      │                                              │
       外部系统 ──▶  POST /api/v1/*（Bearer / X-Api-Key 鉴权）        │
       管理员   ──▶  /admin（Web 后台 + SSE 实时流）                  │
                      └───────────────────┬──────────────────────────┘
                                          │
                           ┌──────────────▼──────────────┐
                           │   控制面（单实例，改造现有    │
                           │   dp-agt）                  │
                           │  · Express 路由 / 鉴权       │
                           │  · SQLite（唯一写者）        │
                           │  · prompts / memory 管理     │
                           │  · 队列 + linkid 串行         │
                           │  · prompt 渲染 / buildEnv    │
                           │  · runner 注册 / 选路 / 心跳  │
                           │  · sse-bus（不变）           │
                           └──────┬──────────────┬───────┘
                    HTTP(NDJSON) 派发     │ 会话读/删 代理
                 ┌─────────────────┐  ┌────▼─────────────┐
                 │  runner #1      │  │  runner #2  …    │
                 │  · 跑 runAgent   │  │  （按需扩容）     │
                 │  · 本地 workdir  │  └──────────────────┘
                 │  · 本地 session  │
                 │  · 本地看门狗     │
                 │  · 本地杀进程树   │
                 └─────────────────┘
```

**核心原则**

1. **runner 完全无状态、无配置、无密钥**：不读 SQLite、不读 `secrets.key`、不读 `prompts/`、不读 `data/memory/`。所有它需要的东西（渲染好的 prompt、完整 CLAUDE.md、环境变量、resume session id、模型参数）都由控制面在派发请求里一次性下发。
2. **控制面是唯一写库者**：SQLite 保持单写者，`task-queue` / `sse-bus` 内存态继续当作权威，不需要为跨进程一致性引入新机制。
3. **runner 上只保留「执行态」**：`active` Map、滑动超时、看门狗、`killTaskProcessTree` 从控制面「搬家」到 runner（它们本来就只跟 SDK 子进程打交道）。
4. **linkid 亲和**：同一 `linkid` 永远路由到同一个 runner（用 `sessions.runner_id` 记住），session resume 语义原样保留。

---

## 3. 数据模型改动（全部在控制面的 SQLite）

### 3.1 新增 `runners` 表

```sql
CREATE TABLE IF NOT EXISTS runners (
  id               TEXT PRIMARY KEY,      -- uuid
  name             TEXT NOT NULL UNIQUE,  -- 例：runner-1
  addr             TEXT NOT NULL,         -- 例：https://runner-1:20002
  capacity         INTEGER NOT NULL DEFAULT 5,  -- 该 runner 最大并发 SDK 数
  status           TEXT NOT NULL DEFAULT 'up',  -- up | down
  last_heartbeat_ts INTEGER,              -- 最近一次心跳（Unix 毫秒）
  created_at       TEXT,
  updated_at       TEXT
);
```

### 3.2 `sessions` 表新增 `runner_id`

```sql
ALTER TABLE sessions ADD COLUMN runner_id TEXT;  -- 哪个 runner 持有该 linkid 的 session + workdir
```

- 新建 session 时写入；复用 session 时据此选路。
- 语义是「该 linkid 的 session 历史和工作目录在哪个 runner 的本地磁盘上」。

### 3.3 `task_logs` 表新增 `runner_id`（可观测性，可选但建议）

```sql
ALTER TABLE task_logs ADD COLUMN runner_id TEXT;
```

- 仅用于排查「这个任务被派到了哪台 runner」，不参与逻辑判断。

### 3.4 runner 注册方式（阶段 1 采用静态列表）

阶段 1 用**静态列表**（写进 `cfg.yml`），控制面启动时 `INSERT OR REPLACE` 到 `runners` 表，再通过心跳探测 `up/down`。

- 部署上对应 `docker-compose` 里固定数量的具名 runner 服务（`runner1`、`runner2`…）。
- **「手动加节点」的正确姿势**：改 docker-compose 加 runner 容器 + 改 `cfg.yml` 的 `runner.addresses` + **重启控制面**。只起一个新 runner 容器但控制面不重启，新 runner 不会被感知到（`runners` 表在控制面启动时同步，不会自动发现新节点）。后续可加 `PUT /api/inner/runners/reload` 热重载接口来避免重启。
- 后续弹性扩缩（k8s / 动态注册）可替换成「runner 启动时 POST 自己的地址到控制面注册」，接口见 §6.6，本阶段不做。

```yaml
runner:
  token: ${RUNNER_TOKEN}          # 控制面 ↔ runner 认证，从环境变量读，绝不写死
  port: 20002
  heartbeat_ms: 5000
  connect_timeout_ms: 5000
  request_timeout_ms: 15000       # 心跳/会话代理等短请求超时
  addresses:
    - name: runner-1
      addr: https://runner-1:20002
      capacity: 5
    - name: runner-2
      addr: https://runner-2:20002
      capacity: 5
```

---

## 4. 控制面 ↔ runner 派发协议

### 4.1 认证与传输

- 每个请求头带 `Authorization: Bearer <RUNNER_TOKEN>`，runner 用 `timingSafeEqual` 校验（与现有 `apiTokenMiddleware` 同款手法）。
- runner 端口**只在内网暴露**，不进 LB、不对公网。建议沿用 HTTPS（复用现有自签证书）；开发环境可退化为 HTTP。
- **自签证书注意**：控制面作为客户端请求 runner 时，Node 的 `https` 默认校验证书会握手失败，客户端必须 `rejectUnauthorized: false`（与现有 `admin.ts` 里 doc-util 缓存清空代理同一手法）；或改用内网 CA 签发的证书。
- 派发请求里携带大量机密（网关 token、`DP_*` 业务变量），因此**必须**走内网 + token，且 runner 侧约定：这些 env **只进 SDK 子进程，不写文件、不打日志**。

### 4.2 主派发接口 `POST /run`（长连接，NDJSON 回传）

控制面把一次任务的完整上下文一次性下发，runner 执行并逐行回传。

**请求体 `RunRequest`**

```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "linkid": "doc_001",
  "mode": "task",
  "prompt": "渲染后的提示词全文",
  "claude_md": "完整 CLAUDE.md 内容（resume 时可为空）",
  "resume_session_id": "…或 null",
  "sdk_options": {
    "model": "…",
    "max_turns": 100,
    "effort_level": "",
    "disable_nonessential_traffic": true,
    "attribution_header": false,
    "auto_mode_server": false
  },
  "env": {
    "ANTHROPIC_BASE_URL": "…",
    "ANTHROPIC_AUTH_TOKEN": "…",
    "DP_DOC_FILE_URL_TOKEN": "…",
    "FILE_URL_TOKEN": "…"
  }
}
```

字段来源（都在控制面算好）：

| 字段 | 来源 |
|------|------|
| `prompt` | `renderPrompt(...)`（`prompt-engine.ts`，不变） |
| `claude_md` | `buildClaudeMd(...)`（`sdk-runner.ts`，不变） |
| `env` | `buildEnv(cfg)`（`sdk-runner.ts`，不变），但**剔除** `CLAUDE_CONFIG_DIR`（runner 用自己的本地目录） |
| `sdk_options` | `cfg.llm` 里 SDK 需要的几个字段 |
| `resume_session_id` | `sessionsStore.getByLinkid(linkid)` |

**响应（NDJSON，每行一个 JSON 对象）**

```
{"type":"session","session_id":"…"}
{"type":"msg","message":{…}}          ← 原始 SDK message，逐条回传
{"type":"msg","message":{…}}
{"type":"result","result":{…}}        ← 最终结果，见下
{"type":"end"}
```

`result` 复用现有 `SdkResult` 形状：

```json
{
  "success": true,
  "raw_output": "…",
  "trace": "[…]",                     // 全量 SDK 消息流 JSON 字符串
  "session_id": "…",
  "error_message": "…",
  "duration_ms": 12345,
  "aborted": false,
  "watchdog_killed": false
}
```

> `aborted` / `watchdog_killed` 为新增字段，用于控制面区分「管理员取消」与「看门狗强杀」并写出正确的终态（对应现有 `processItem` 里 `wasAborted && timeoutFired` 等分支）。

### 4.3 取消接口 `POST /cancel`

控制面取消「已派发」的任务时，**不关闭**派发长连接，而是调 runner 的取消接口，让 runner 仍能通过原连接把 `result` 回传、控制面忠实落库（等价于现在进程内的 `AbortController.abort()`）。

```
POST /cancel
{ "task_id": "…" }
```

runner 内部：`active.get(task_id).abortController.abort()`；SDK 中断后 `runAgent` 正常走收尾，`/run` 回传 `{"type":"result","result":{"aborted":true,...}}`。

> 兜底：若控制面拿不到 runner（网络断 / runner 已死），直接 abort 本机派发连接并自己标记 `cancelled`（丢弃 runner 的最终回传），与现有 `api_cancel_task` 的「任务停止中」语义一致。

### 4.4 会话读取 / 文件代理接口

控制面不再本地读工作目录，而是按 `sessions.runner_id` 转发到 runner：

| 控制面现有路由 | 转发到 runner | 说明 |
|----------------|---------------|------|
| `GET /admin/sessions/:sid/messages` | `GET /session/:sid/messages` | `getSessionMessages` 在 runner 本地执行 |
| `GET /admin/sessions/:sid/files` | `GET /session/:sid/files` | 列目录（runner 本地 `workdir`） |
| `GET /admin/sessions/:sid/file-content?path=` | `GET /session/:sid/file-content?path=` | 读文件 |
| `GET /admin/sessions/:sid/file-download?path=` | `GET /session/:sid/file-download?path=` | 流式下载 |
| `DELETE /admin/sessions/:sid` | `DELETE /session/:sid` | 取消该 linkid 队列任务 + 删 workdir + 关闭 session |

runner 侧的这些接口，逻辑就是从现有 `admin.ts` 原样搬过去（`sessionWorkDir`、防路径穿越、`getSessionMessages` 调用、`rmSync` workdir 等），只是把 `cfg.sys.runtime_dir` 换成 runner 本地的 `RUNTIME_DIR`。

### 4.5 心跳/状态接口 `GET /status`

```
GET /status
→ { "capacity": 5, "running_count": 2, "uptime_ms": 123456 }
```

控制面定时轮询，更新 `runners.status` 与 `last_heartbeat_ts`。runner 无自定义状态，只上报「还能跑多少」。

### 4.6 保留的后续扩展位

- runner 动态注册：`POST /register { name, addr, capacity }`（本阶段不实现，静态列表够用）。

---

## 5. 控制面逻辑

### 5.1 runner 选路（`selectRunner`）

新增 `src/services/dispatcher.ts`：

```
选路(linkid):
  1. s = sessions.getByLinkid(linkid)
     if s 且 s.runner_id 对应的 runner.status == 'up' 且 有空位:
         return 该 runner            // 保住 session 亲和
  2. 否则选 status=='up' 且 running_count 最小的 runner（同名打破平局）
  3. 无可用 runner → 任务挂起 / 503
```

- 控制面内存维护 `Map<runnerId, assigned>`（派发 +1、收尾 -1），并用心跳回传的 `running_count` 作为真实值校准。
- 全局闸门仍是 `sys.max_concurrent_tasks`（总在跑）与 `sys.max_pending_tasks`（总排队）；runner 自身 `capacity` 是第二道闸门，`/run` 满时 runner 回 503，控制面换一台。

### 5.2 任务生命周期（重写 `processItem`）

现有 `task-queue.ts` 的 `processItem` 保持骨架，把「本地 `runAgent(...)`」替换为「HTTP 派发 + 流式回传处理」：

```
processing 状态落库（不变）
→ 磁盘读模板 + renderPrompt（不变）
→ buildClaudeMd / buildEnv（控制面，仅此处在执行前算好）
→ 查 resumeSessionId（不变）
→ selectRunner(linkid)
→ POST /run（长连接）
→ 逐行解析 NDJSON：
     frame.type == 'session' → sessionsStore.upsert(sid, linkid, runnerId)；onSessionId
     frame.type == 'msg'     → publish(sid, msg)（喂给现有 sse-bus）；armTimeout()（滑动超时）
     frame.type == 'result'  → 进入现有成功/失败/取消/超时收尾逻辑
→ HTTP 异常 / 连接中途断开 → 按现有 catch 分支落 failed（必要时重试，见 §5.4）
```

### 5.3 滑动超时与看门狗的归属

| 机制 | 现状 | 拆分后 |
|------|------|--------|
| 滑动超时（连续 `timeout_ms` 无消息就中断） | 控制面 `processItem.armTimeout` | **留在控制面**：无 `msg` 帧超时 → abort 派发连接 + 调 `/cancel` |
| 看门狗（硬杀 SDK 进程树） | 控制面 `sweepStuckTasks` | **搬到 runner**：runner 本地无活动超 `timeout_ms + grace_ms` → `killTaskProcessTree` + 回传 `watchdog_killed` |

两层是防御纵深：控制面滑动超时是主路径，runner 看门狗是兜底（防 SDK 卡死、abort 不干净时残留进程树）。

### 5.4 失败重试与 runner 故障

- 派发在收到第一个 `session` 帧**之前**失败（连接拒绝 / runner 挂 / 503 满）→ 视为「还没开始」，换一台 runner 重试一次（新 linkid 安全；resume linkid 若原 runner 已 down，走「降级新建 session」）。
- 收到 `session` 帧**之后**连接中断 → 不重试，落 `failed`（避免同 linkid 双跑、session 冲突）。此时该 linkid 的 session 已写入 DB，下次提交仍能 resume 到原 runner。
- runner 心跳超时 → `status='down'`；控制面不再向它派发新任务，但不主动杀它已在跑的任务（靠它的看门狗或连接断开兜底）。

### 5.5 控制面重启（`recoverOrphanedTasks` 语义基本不变）

- 控制面进程退出 → 所有派发长连接断开 → runner 检测到连接关闭，主动 abort 其 SDK 并清理（见 §6.4）。
- 控制面重启后：
  - `pending` → 重新入队（不变）
  - `processing` → 落 `failed`（不变；对应任务在 runner 侧已被连接断开 abort）
  - 未完成的 `sessions` 保留（session 文件仍在 runner 磁盘），下次提交 resume 仍可用。

> 因此「连接关闭 = 取消」是控制面重启语义能保持的关键：它让 runner 侧的孤儿任务自动终止，等价于现在「SDK 与调度在同一进程，进程退出一同死」的行为。

---

## 6. runner 逻辑

### 6.1 职责边界

runner 只做：
- 接收 `RunRequest`，`mkdir workdir`（`runtime/tasks/<sanitize(linkid)>`）、新 session 时写 `CLAUDE.md`。
- 用下发的参数跑 SDK `query(...)` 流式循环（就是现在 `sdk-runner.ts:349-417` 那段）。
- 逐条回传 SDK message；捕获 session_id 后立即回传 `session` 帧。
- 本地滑动看门狗 + `killTaskProcessTree`。
- 提供会话读/删代理接口（§4.4）。

runner **不**做：鉴权业务逻辑、队列、SQLite 读写、prompt 渲染、`prompt_config` 解密、回调投递（回调本来就是 Agent 自己 curl）。

### 6.2 环境与目录

- `RUNTIME_DIR`（默认 `./runtime`）为 runner 本地目录，含 `tasks/` 与 `claude-config/`，不挂载、重启丢弃。
- runner 自己设置 `process.env.CLAUDE_CONFIG_DIR = <RUNTIME_DIR>/claude-config`，**覆盖**控制面下发的 env（控制面会先剔除该变量）。
- `env` 里其余项（网关地址、token、`DP_*`）直接透传给 `query({ env })`。

### 6.3 内部结构（把 `task-queue` 的 active/watchdog 结构搬过来）

```ts
// runner 进程内
const active = new Map<task_id, {
  abortController: AbortController;
  res: http.ServerResponse;          // 派发长连接，用于回传
  lastActivity: number;
  watchdogKilled?: boolean;
}>();
```

- `/run` 到达：`capacity` 满则 503；否则建 `active` 项，跑 `runAgent`。
- `/cancel`：`active.get(task_id).abortController.abort()`（不关连接）。
- 看门狗 sweep：复用现有 `sweepStuckTasks` 逻辑 + 从 `task-queue.ts` 抽出的 `killTaskProcessTree`（建议抽到 `src/services/process-tree.ts` 共享）。

### 6.4 连接断开 = 取消

runner 监听派发请求的 `close` 事件：客户端（控制面）断开且任务尚未结束 → `abortController.abort()`，SDK 中断，随后清理 `active` 项与本地看门狗标记。这样控制面重启或主动断开时，runner 不留孤儿 SDK 进程。

---

## 7. 文件级改动清单

### 新增

| 文件 | 内容 |
|------|------|
| `src/services/process-tree.ts` | 从 `task-queue.ts` 抽出 `killTaskProcessTree`（runner 看门狗复用） |
| `src/services/dispatcher.ts` | 控制面：runner 注册加载、心跳轮询、`selectRunner`、`assigned` 计数 |
| `src/services/runner-client.ts` | 控制面：`/run` 流式派发、`/cancel`、会话读/删代理的 HTTP 客户端封装 |
| `src/runner/index.ts` | runner 入口：Express + 上述 `/run` `/cancel` `/status` `/session/*` 路由 |
| `src/runner/watchdog.ts` | runner 本地看门狗（从 `task-queue.ts` 搬 `sweepStuckTasks`） |
| `doc/cluster-runner-design.md` | 本文档 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/config.ts` | `Config` 增加 `runner` 段；`loadConfig` 解析（含 `RUNNER_TOKEN` 环境变量） |
| `src/types.ts` | 新增 `Runner`、`RunRequest`、`RunFrame`、`SdkResult` 增 `aborted`/`watchdog_killed` |
| `src/store.ts` | 建 `runners` 表 + `runnersStore`；`sessions`/`task_logs` 增 `runner_id`（migration）；`sessionsStore.upsert` 增 `runnerId` 参数 |
| `src/services/sdk-runner.ts` | 把 `runAgent` 重构为接受 `emit(frame)` 回调（runner 用它写 NDJSON；控制面旧路径暂保留直连能力）；`buildEnv` 剔除 `CLAUDE_CONFIG_DIR` 时增加开关 |
| `src/services/task-queue.ts` | `processItem` 改为经 `dispatcher` 派发；移除本地看门狗启动（`startWatchdog` 移走）；`recoverOrphanedTasks` 增加 runner 相关处理 |
| `src/routes/admin.ts` | 会话读/删/文件浏览下载改为按 `sessions.runner_id` 走 `runner-client` 代理 |
| `src/index.ts` | 初始化 runner 注册 + 心跳轮询；不再在任务队列里启看门狗 |
| `build/Dockerfile` | 产两个 bundle：`dist/index.js`（控制面）+ `dist/runner.js`（runner），同一镜像两个入口 |
| `build/deploy.sh` / 新增 `build/compose.yml` | 用 docker-compose 起 1 控制面 + N runner |

### 暂不迁移（阶段 1 明确不做）

- 管理后台的 **chat（新建/续聊）**：低流量、调试用途，阶段 1 保留在控制面本地运行（其 `chat-<uuid>` linkid 与业务 linkid 天然不冲突）。业务 session 的续聊 `POST /admin/sessions/:sid/chat` 若指向 runner 上的 session，阶段 1 会读不到，作为已知限制记录，阶段 2 一并迁到 runner 的 `/run`（`mode: chat`）。

---

## 8. 部署编排（docker-compose 草案）

```yaml
services:
  control:
    image: dp-agt:0.2.0
    command: ["node", "dist/index.js"]
    environment:
      DATA_DIR: /app/data
      RUNNER_TOKEN: ${RUNNER_TOKEN}
      # runner 静态列表从 cfg.yml 读，或由环境变量覆盖
    volumes:
      - ./data:/app/data
    ports:
      - "20001:20001"

  runner1:
    image: dp-agt:0.2.0
    command: ["node", "dist/runner.js"]
    environment:
      RUNTIME_DIR: /app/runtime
      RUNNER_PORT: 20002
      RUNNER_MAX_CONCURRENT: 5
      RUNNER_TOKEN: ${RUNNER_TOKEN}
    # 无 data 挂载：runner 无状态，runtime 重启即丢

  runner2:
    image: dp-agt:0.2.0
    command: ["node", "dist/runner.js"]
    environment:
      RUNTIME_DIR: /app/runtime
      RUNNER_PORT: 20002
      RUNNER_MAX_CONCURRENT: 5
      RUNNER_TOKEN: ${RUNNER_TOKEN}
```

- 只有控制面挂 `data/`（`cfg.yml` / `app.db` / `secrets.key` / `memory/` / 日志）。
- runner 只挂空 `runtime/`（或不挂，用容器内卷）。
- 控制面与 runner 在同一个 docker network，runner 不映射宿主机端口。

---

## 9. 兼容与回滚

- **同镜像双入口**：老的单实例部署（`node dist/index.js` + 本地 `runAgent`）通过一个配置开关保留——`runner.addresses` 为空时，`dispatcher` 退化为「本进程执行」（调用本地 `runAgent`），行为与今天完全一致。这样阶段 1 可以平滑灰度，出问题一键回滚到单实例模式。
- **DB migration 可逆**：只 `ADD COLUMN`，老代码读到新列也不会出错；回滚不删列即可。
- **对业务方无感**：对外 `POST /api/v1/*`、任务查询/取消/trace/时间线接口的 URL 与响应**完全不变**，只有内部部署拓扑变化。

---

## 10. 风险与未决点

| # | 风险 / 未决 | 影响 | 建议 | 我的看法 |
|---|-------------|------|------|------|
| 1 | 控制面仍是单点（调度 + 唯一 SQLite 写者） | 控制面挂了全体不可用（但 runner 上的在跑任务会被连接断开中止） | 阶段 1 接受；控制面很轻，短中期不是瓶颈。需要控制面 HA 再进阶段 2 | 控制面单点，没问题，暂时不考虑控制面的扩展，因为任务中的是runner |
| 2 | 机密随 `RunRequest` 下发到 runner | 内网明文传输的 token 泄露面增大 | 内网 + Bearer + 建议 mTLS/HTTPS；runner 不打日志不落盘 | 没问题，目前https传输，而且是内网 |
| 3 | 静态 runner 列表不够弹性 | 扩容要改 compose + cfg | 阶段 1 接受；预留 `/register` 动态注册扩展位 | 没关系，手动改compose，手动加节点，这个没问题 |
| 4 | 会话读/删走代理，多一跳 | 大文件下载时控制面成为转发瓶颈 | 文件不大（文档类），阶段 1 接受；必要时让控制面返回 runner 直连 URL | 会话文件浏览/下载是低频排查操作，删除会话是低频生产运维动作（清会话 + 取消在跑任务 + 关 session），都非高频，走代理多一跳可接受 |
| 5 | 连接断开=取消的时序竞争 | 控制面恰好在 runner 回传 `result` 前断开，可能丢终态 | runner 收到 `result` 时若连接已断则仅打日志丢弃；控制面已有终态标记路径兜底 | 没问题 |
| 6 | runner 崩溃导致该机所有 session/workdir 丢失 | 该 linkid 下次提交退化为新建 session | 复用现有 `resume_session_gone_creating_new` 兜底（`sdk-runner.ts:300-316`），可接受 | 没问题 |

---

## 11. 建议实施顺序

1. **阶段 0（纯重构，不改行为）**：抽 `process-tree.ts`；把 `runAgent` 改成接受 `emit` 回调；`buildEnv` 支持剔除 `CLAUDE_CONFIG_DIR`。跑通现有单实例回归。
2. **阶段 1a**：新增 runner 服务 + `POST /run`（流式）+ `/status` + `/cancel`，先用手工 curl 验证单 runner 端到端。
3. **阶段 1b**：控制面接入 `dispatcher` + `runner-client`，`processItem` 改派发，`linkid` 亲和 + 心跳 + 失败重试。
4. **阶段 1c**：会话读/删/文件代理接口改造 + chat 已知限制确认。
5. **阶段 1d**：docker-compose 编排 + 灰度（`runner.addresses` 为空回退单实例）。
