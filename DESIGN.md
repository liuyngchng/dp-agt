# AI 数字员工 — 自主任务执行平台（设计文档）

**版本**: V1.0-DRAFT  
**日期**: 2026-10-27  
**密级**: 内部

---

## 1. 核心理念

### 1.1 一句话描述

接收 JSON → 按 path 找到提示词模板 → 渲染提示词 → 调用 Claude Code Agent SDK → 回调结果。

### 1.2 设计原则

```
原则1: 系统不做任何业务逻辑
        → 不下载文件、不解析文档、不提取文本、不翻译 JSON key
        → 所有"智能"行为由 Claude 通过 Agent SDK 的 tool use 自行完成

原则2: 接口 path 可任意创建，调用方感知为"不同接口"
        → 每个 path 在管理后台配置一个提示词模板
        → 调用方 POST /api/v1/<path> 时，系统按 path 找到模板
        → 不同 path → 不同提示词 → 不同行为

原则3: Claude Code Agent SDK 是核心引擎
        → Claude 自行 curl 下载文件（URL 已在请求 JSON 中）
        → Claude 自行 Read 文件
        → Claude 自行 Bash 做任何它觉得必要的事情
        → Claude 按提示词 Schema 输出结构化 JSON

原则4: 管理员通过 Web 界面管理接口与提示词
        → 接口 path + 提示词是唯一需要配置的东西
        → 没有代码注册表、没有 Pipeline、没有钩子
        → 新增接口 = 后台新建一条 path 配置
```

---

## 2. 系统架构

```
外部业务系统                                              AI 数字员工
     |                                                         |
     |  POST /api/v1/document/classify                         |
     |  {                                                      |
     |    "linkid": "xxx",                                     |
     |    "callback_url": "https://...",                       |
     |    "process_type": "company_receive",                   |
     |    "form_data": {...},                                  |
     |    "files": [{file_url, file_type, file_name}],         |
     |    "next_nodes": [...],                                 |
     |    "current_step": "收文登记",                            |
     |    ... (任何字段)                                         |
     |  }                                                      |
     | ──────────────────────────────────────────────────────► |
     |                                                         |
     |                                                         | 1. 校验 linkid + callback_url
     |                                                         | 2. 按 path 查找模板 (document/classify)
     |                                                         | 3. 检查队列上限
     |                                                         | 4. 生成 task_id (UUID)
     |                                                         | 5. 立即返回
     |  {code:0, task_id:"uuid", linkid:"xxx"}                |
     | ◄────────────────────────────────────────────────────── |
     |                                                         |
     |                                                         | === 异步 Worker ===
     |                                                         |
     |                                                         | 6. 渲染提示词：
     |                                                         |    {{request.body}} → 整个请求 JSON
     |                                                         |    {{request.linkid}}
     |                                                         |    {{request.form_data}}
     |                                                         |    {{request.files}}
     |                                                         |    ... (任意字段均可引用)
     |                                                         |
     |                                                         | 7. 创建工作目录 data/tasks/{task_id}/
     |                                                         |    写入 CLAUDE.md（行为规范）
     |                                                         |
     |                                                         | 8. query({prompt, options})
     |                                                         |    → Claude 自己 curl 下载文件
     |                                                         |    → Claude 自己 Read 文件
     |                                                         |    → Claude 分析内容
     |                                                         |    → Claude 按 Schema 输出 JSON
     |                                                         |
     |                                                         | 9. 收集 Claude 输出的 JSON
     |                                                         |    打印日志
     |                                                         |
     |  POST {callback_url}                                    | 10. 回调对方
     |  {                                                      |
     |    "code": 0,                                           |
     |    "task_id": "uuid",                                   |
     |    "linkid": "xxx",                                     |
     |    "data": { Claude 输出的 JSON }                        |
     |  }                                                      |
     | ◄────────────────────────────────────────────────────── |
     |                                                         |
     |  200 OK                                                 |
     | ──────────────────────────────────────────────────────► |
     |                                                         |
     |  (回调失败自动重试，最多3次，指数退避)                       |
```

---

## 3. 接口定义

### 3.1 对外业务接口（任意 path）

| 项目 | 内容 |
|------|------|
| URL | `POST /api/v1/<path>`，`<path>` 任意，如 `document/classify`、`document/route`、`dispatch-review` |
| Content-Type | `application/json` |
| 认证 | `X-Api-Key: {api_key}` |
| 模式 | **异步**：受理立即返回，处理完后回调 |

**path 解析规则**：

- 每个 path 在管理后台配置一条记录，绑定一个提示词模板
- 请求到达后，去掉 `/api/v1/` 前缀，余下部分作为 path 查找模板
- 找不到对应 path → 返回 `404 {code: 1001, message: "接口不存在: <path>"}`

**内置示例 path**（部署后管理员可随意增删改）：

| path | 说明 |
|------|------|
| `document/classify` | 收文分类与信息提取 |
| `document/route` | 流转目标识别 |
| `document/dispatch-review` | 发文审核 |

### 3.2 请求体（自由 JSON）

强制字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `linkid` | string | 业务流水号，回调时原样带回 |
| `callback_url` | string | 回调地址，处理完后 POST 到这里 |

其他字段**无任何限制**，全部透传给 Claude。

### 3.3 立即响应

```json
{
  "code": 0,
  "timestamp": "2026-10-27 10:00:00",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "linkid": "doc_20261027_0001",
  "data": {}
}
```

接口不存在：

```json
{
  "code": 1001,
  "timestamp": "2026-10-27 10:00:00",
  "message": "接口不存在: document/xxx",
  "task_id": "",
  "linkid": "",
  "data": {}
}
```

队列满时：

```json
{
  "code": 2002,
  "timestamp": "2026-10-27 10:00:00",
  "message": "任务队列已满，当前处理中 X/Y，请稍后重试",
  "task_id": "",
  "linkid": "",
  "data": {}
}
```

### 3.4 回调格式

成功：

```json
{
  "code": 0,
  "timestamp": "2026-10-27 10:02:30",
  "message": "success",
  "task_id": "550e8400-...",
  "linkid": "doc_20261027_0001",
  "data": {
    "need_human": false,
    "doc_type": "company",
    "form_fill": {"file_no": "X委办〔2026〕12号"},
    "opinion_text": "请刘总阅示。",
    ...
  }
}
```

失败：

```json
{
  "code": 5000,
  "timestamp": "2026-10-27 10:02:30",
  "message": "Claude 处理失败: context deadline exceeded",
  "task_id": "550e8400-...",
  "linkid": "doc_20261027_0001",
  "data": null
}
```

---

## 4. 接口与提示词模板系统

### 4.1 管理界面

管理员通过 Web 界面创建「接口」。每个接口 = 一个 path + 一个提示词模板：

| 字段 | 说明 |
|------|------|
| 接口名称 | 用于界面展示，如 "收文分类" |
| path | 对外访问路径，如 `document/classify`，全局唯一 |
| 提示词内容 | 自由文本，支持 `{{placeholder}}` 占位符 |

新增接口只需在后台填一个 path + 一段提示词，无需改代码、无需重启。

### 4.2 占位符语法

提示词中用 `{{path}}` 引用请求 JSON 中的任意字段，支持点号路径：

```
{{request.body}}           → 整个请求 JSON
{{request.linkid}}         → "doc_20261027_0001"
{{request.process_type}}   → "company_receive"
{{request.form_data}}      → {"title": "关于XX"}
{{request.files}}          → [{"file_url":"...", "file_type":"main_body"}]
{{request.current_step}}   → "收文登记"
```

实现方式：在提示词渲染时，直接用 `JSON.stringify(value, null, 2)` 替换占位符。

### 4.3 提示词示例（path = document/classify）

```markdown
# 文档处理任务

你需要处理一份文件。以下是请求信息：

```json
{{request.body}}
```

## 执行步骤

### 步骤 1：下载文件
遍历请求中的 `files` 数组，用 curl 下载每个 `file_url` 到工作目录。
文件 URL 无需认证即可直接下载。

### 步骤 2：读取文件内容
用 Read 工具读取下载的文件。

### 步骤 3：分析并输出
根据文件内容和表单数据进行分析。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 ```json 代码块包裹：

```json
{
  "need_human": false,
  "fail_reason": "",
  "doc_type": "company",
  "source_type": "group",
  "form_fill": {
    "file_no": "",
    "from_org": "",
    "deadline": "",
    "doc_date": ""
  },
  "opinion_text": "",
  "need_manual_restart": false,
  "ledger_data": null
}
```

## 注意事项
- 文件下载前先检查本地是否已有该文件
- 如果文件无法下载，将 need_human 设为 true 并在 fail_reason 中说明原因
```

---

## 5. 技术实现

### 5.1 Claude Code Agent SDK 调用方式

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// 创建工作目录
const workDir = path.join(DATA_DIR, 'tasks', taskId);
await fs.mkdir(workDir, { recursive: true });

// 写入 CLAUDE.md 设定基本行为规范
await fs.writeFile(path.join(workDir, 'CLAUDE.md'),
  `# AI 数字员工 工作规范

你是 AI 数字员工。你的任务是根据提示词分析文件并输出结构化结果。

文件下载：
- 对方传递的 JSON 中的文件 URL 开放白名单，无认证
- 使用 curl 下载文件到当前工作目录

输出规范：
- 严格按照提示词中要求的 JSON Schema 输出
- 用 \`\`\`json 代码块包裹 JSON
- 不要输出任何其他内容`
);

// 调用 SDK
const q = query({
  prompt: renderedPrompt,         // 渲染后的提示词
  options: {
    cwd: workDir,
    permissionMode: 'bypassPermissions',  // 自动批准所有工具
    tools: { type: 'preset', preset: 'claude_code' },
    model: config.model || 'claude-sonnet-4-20250514',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  },
});

let fullOutput = '';
for await (const message of q) {
  if (message.type === 'assistant') {
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text') fullOutput += block.text;
    }
  }
}
```

### 5.2 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js ≥22 (TypeScript) |
| HTTP 框架 | Express.js |
| Claude SDK | `@anthropic-ai/claude-agent-sdk` |
| 前端 | 内嵌 SPA (Vanilla JS) |
| 存储 | SQLite (better-sqlite3) — 存接口/模板配置 + 任务日志 |
| 日志 | pino |

### 5.3 项目结构

```
AI 数字员工/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                # 服务入口 (Express + 路由注册)
│   ├── config.ts               # 配置加载 (cfg.yml → env)
│   ├── types.ts                # 类型定义
│   │
│   ├── routes/
│   │   ├── process.ts          # POST /api/v1/:path (通配路由)
│   │   ├── health.ts           # GET /health
│   │   ├── tasks.ts            # GET /tasks, DELETE /tasks/:id
│   │   └── admin.ts            # 管理后台 API (接口/模板 CRUD + 任务日志)
│   │
│   ├── services/
│   │   ├── sdk-runner.ts       # 封装 query() — 创建 workdir、写入 CLAUDE.md、调用 SDK
│   │   ├── prompt-engine.ts    # 模板查找 + 占位符渲染
│   │   ├── callback.ts         # 回调投递 + 重试 (3次，指数退避)
│   │   └── task-queue.ts       # 简单异步任务队列 (pending → processing → done)
│   │
│   ├── store/
│   │   ├── sqlite.ts           # SQLite 连接 + 表初始化
│   │   ├── interfaces.ts       # 接口(path+模板) CRUD
│   │   └── task-logs.ts        # 任务日志 CRUD
│   │
│   └── middleware/
│       └── auth.ts             # X-Api-Key 认证中间件
│
├── web/                        # 管理后台前端 (内嵌)
│   ├── index.html
│   ├── app.js                  # SPA: 接口管理 + 任务日志
│   └── style.css
│
├── data/                       # 运行时数据 (容器挂载卷)
│   ├── tasks/                  # 各任务的工作目录 (Claude 在此读写)
│   │   └── {task_id}/
│   │       ├── CLAUDE.md
│   │       └── (Claude 下载的文件)
│   ├── app.db                  # SQLite
│   └── cfg.yml                 # 配置文件
│
└── build/
    ├── build.sh
    └── Dockerfile
```

### 5.4 数据库表结构

```sql
-- 接口 = path + 提示词模板
CREATE TABLE agent_interfaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,          -- 展示名，如 "收文分类"
  path        TEXT NOT NULL UNIQUE,   -- 对外 path，如 "document/classify"
  prompt      TEXT NOT NULL,          -- 提示词模板（含 {{placeholder}}）
  created_at  TEXT,
  updated_at  TEXT
);

-- 任务日志
CREATE TABLE task_logs (
  task_id       TEXT PRIMARY KEY,
  linkid        TEXT,
  path          TEXT,                 -- 命中的接口 path
  interface_id  TEXT,                 -- 使用的接口记录 ID
  status        TEXT,                 -- pending/processing/success/failed/completed/callback_fail
  request_body  TEXT,                 -- 原始请求 JSON
  prompt        TEXT,                 -- 渲染后的完整提示词
  sdk_output    TEXT,                 -- Claude 返回的原始文本
  callback_body TEXT,                 -- 回调的完整 JSON
  callback_url  TEXT,
  error_message TEXT,
  created_at    TEXT,
  finished_at   TEXT
);
```

### 5.5 配置文件 (cfg.yml)

```yaml
server:
  port: 20001
  debug: false

sys:
  # 并发控制
  max_concurrent_tasks: 5       # 同时处理的任务数上限
  max_pending_tasks: 10         # 总排队上限 (pending + processing)

  # 回调
  callback_url_token: ""        # 回调时的 Bearer token
  callback_retries: 3           # 重试次数
  callback_retry_interval_sec: 2 # 退避基础间隔

  # 数据保留
  retention_days: 30

  # LLM
  model: "claude-sonnet-4-20250514"
```

### 5.6 任务状态机

```
pending → processing → success → completed (回调成功)
                    ↓          ↓
                    failed ← callback_fail (回调重试耗尽)
                    ↓
                  cancelled (用户取消)
```

---

## 6. 管理后台

### 6.1 页面：接口管理

```
┌──────────────────────────────────────────────────────┐
│  AI 数字员工 管理后台                           │
│──────────────────────────────────────────────────────│
│                                                      │
│  [接口管理] [任务日志] [系统设置]                        │
│                                                      │
│  ┌───────────────┬─────────────────────┬──────────┐   │
│  │ 名称           │ path                │ 操作      │   │
│  ├───────────────┼─────────────────────┼──────────┤   │
│  │ 收文分类       │ document/classify   │ [编辑]    │   │
│  │ 流转目标识别   │ document/route      │ [编辑]    │   │
│  │ 发文审核       │ document/dispatch-review│[编辑]│   │
│  └───────────────┴─────────────────────┴──────────┘   │
│                                                      │
│  [+ 新建接口]                                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 6.2 页面：接口编辑

```
┌──────────────────────────────────────────────────────┐
│  编辑接口: 收文分类                                    │
│──────────────────────────────────────────────────────│
│                                                      │
│  名称: [　收文分类　　　　　　　　　　　　　　]           │
│                                                      │
│  path: [document/classify　　　　　　　　　]           │
│        (调用方 POST /api/v1/document/classify)         │
│                                                      │
│  提示词:                                              │
│  ┌──────────────────────────────────────────────┐    │
│  │ # 文档处理任务                                 │    │
│  │                                               │    │
│  │ 请求数据：                                     │    │
│  │ ```json                                       │    │
│  │ {{request.body}}                              │    │
│  │ ```                                           │    │
│  │                                               │    │
│  │ ## 任务                                       │    │
│  │ 1. curl 下载 files 中的文件                    │    │
│  │ 2. Read 读取文件内容                           │    │
│  │ 3. 分析并返回 JSON                             │    │
│  │ ...                                           │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  可用占位符: {{request.body}} {{request.linkid}}       │
│             {{request.process_type}} {{request.files}} │
│             {{request.form_data}} ...                  │
│                                                      │
│  [保存]  [取消]                                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 6.3 页面：任务日志

```
┌──────────────────────────────────────────────────────┐
│  任务日志                                            │
│──────────────────────────────────────────────────────│
│                                                      │
│  task_id          linkid     path       状态   时间    │
│  ─────────────────────────────────────────────────── │
│  550e...          doc_001   classify  completed 10:02│
│  660e...          doc_002   route     failed   10:03 │
│  770e...          doc_003   dispatch  processing 10:05│
│                                                      │
│  [点任务看详情: 原始请求 / 提示词 / Claude输出 / 回调]  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 7. 认证体系

### 7.1 外部业务系统 → Agent

```
X-Api-Key: edoc_sk_xxxxxxxxxxxx
```

在 `cfg.yml` 的 `api_keys` 数组中配置。

### 7.2 Agent → 外部业务系统回调

```
Authorization: Bearer {cfg.sys.callback_url_token}
```

### 7.3 管理员 → 管理后台

```
Cookie/Session 登录
admin / 初始密码 (首次登录强制修改)
```

---

## 8. 部署

### 8.1 目录挂载

```
AI 数字员工 容器:
  挂载点: /app/data/
  内容:
    data/cfg.yml        — 配置文件
    data/app.db         — SQLite
    data/tasks/         — 任务工作目录 (Claude SDK 在此执行)
    data/logs/          — 应用日志
```

### 8.2 端口

```
20001 — HTTPS (自签证书)
```

### 8.3 健康检查

```
GET /health → {"status":"ok","timestamp":"2026-10-27 10:00:00"}
```

---

## 9. 下一步

本方案已完整定义系统架构、接口规范、提示词系统、技术栈、项目结构。直接按此实现即可。

实现顺序建议：
1. 项目初始化 + Express 骨架 + SQLite
2. SDK runner 封装（核心）
3. `POST /api/v1/:path` 通配路由 + 任务队列
4. 提示词引擎 + 接口(path+模板) 管理 API
5. 回调投递 + 重试
6. 管理后台前端
7. 部署脚本 + Dockerfile