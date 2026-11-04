# AI 数字员工 — 自主任务执行平台

接收 JSON → 按 path 查找提示词模板 → 渲染提示词 → 异步调用 Claude Code Agent SDK → 回调结果。

系统本身不做任何业务逻辑（不下载文件、不解析文档、不提取文本），所有"智能"行为由 Claude 通过 Agent SDK 的 tool use 自行完成。

## 快速开始

```bash
# 1. 准备配置
cp data/cfg.yml.template data/cfg.yml
# 编辑 cfg.yml，至少填写 llm.base_url（Anthropic 协议兼容网关地址）

# 2. 安装依赖并编译
npm install
npm run build

# 3. 启动服务
npm start          # HTTP 模式
# 或配置 cert_file / key_file 后自动切换为 HTTPS
```

### Docker 部署

```bash
./build/build.sh          # 构建镜像
./build/run.sh start      # 启动容器
```

## 工作原理

```
外部系统                             AI 数字员工
   |                                     |
   |  POST /api/v1/document/classify     |
   |  {"linkid":"...","callback_url":"...","files":[...], ...}
   | ───────────────────────────────────►|
   |                                     | 1. 按 path 查找提示词模板
   |  {"code":0, "task_id":"uuid"}       | 2. 入队，立即返回
   | ◄───────────────────────────────────|
   |                                     | === 异步 ===
   |                                     | 3. 渲染提示词（{{placeholder}}）
   |                                     | 4. 创建 workdir，调用 Claude Agent SDK
   |                                     |    → Claude 自行 curl 下载文件
   |                                     |    → Claude 自行 Read 文件
   |                                     |    → Claude 分析并输出结构化 JSON
   |  POST {callback_url}                | 5. 回调结果（失败自动重试，指数退避）
   | ◄───────────────────────────────────|
```

## 核心设计

- **Path 即接口**：管理员在 Web 后台为每个 path 配置一段提示词模板，调用方感知为"不同接口"，无需改代码、无需重启
- **占位符渲染**：提示词中用 `{{request.field}}` 引用请求 JSON 中的任意字段
- **无业务逻辑**：系统只是 Claude Agent SDK 的网关壳，所有文档分析判断全交给 LLM
## 任务状态机

```
                   ┌─────────────────────┐
                   │       pending       │  排队等待
                   └─────────┬───────────┘
                             │  worker 取出
                             ▼
                   ┌─────────────────────┐
        ┌──────────│     processing      │──────────┐
        │          └─────────┬───────────┘          │
        │                    │                       │
        │   SDK 调用异常      │  SDK 返回成功          │  外部取消
        │                    │                       │
        ▼                    ▼                       ▼
  ┌──────────┐     ┌──────────────────┐     ┌──────────────┐
  │  failed  │     │  回调 callback_url │     │  cancelled   │
  └──────────┘     └────────┬─────────┘     └──────────────┘
                            │
                   ┌────────┴────────┐
                   │                 │
               回调成功           回调失败（重试耗尽）
                   │                 │
                   ▼                 ▼
           ┌───────────┐     ┌───────────────┐
           │ completed │     │ callback_fail │
           └───────────┘     └───────────────┘
```

| 状态 | 含义 |
|------|------|
| `pending` | 已入队，等待 worker 消费 |
| `processing` | worker 正在调用 Claude Agent SDK |
| `completed` | SDK 处理完成 + 回调对方 URL 成功，整条链路走完 |
| `failed` | SDK 调用本身异常（网络、超时、模型错误等） |
| `callback_fail` | SDK 输出成功，但回调对方 URL 失败（重试次数耗尽） |
| `cancelled` | 仍在排队 `pending` 时被外部系统取消 |

失败时回调**仍然尝试投递**（状态为 `failed` 时也会回调，payload 里 `code: 5000`，`data: null`），以便对方感知失败。

## 项目结构

```
AI 数字员工/
├── src/
│   ├── index.ts              # 服务入口
│   ├── config.ts             # 配置加载
│   ├── routes/
│   │   ├── process.ts        # POST /api/v1/:path（通配路由）
│   │   ├── tasks.ts          # 任务查询/取消
│   │   ├── admin.ts          # 管理后台 API（接口/模板 CRUD）
│   │   └── auth.ts           # 登录鉴权
│   └── services/
│       ├── sdk-runner.ts     # Claude Agent SDK 封装
│       ├── prompt-engine.ts  # 模板查找 + 占位符渲染
│       ├── callback.ts       # 回调投递 + 重试
│       └── task-queue.ts     # 异步任务队列
├── web/                      # 管理后台前端（内嵌 SPA）
├── prompts/                  # 提示词文件（无需重编译，热更新）
│   ├── doc/                   # 业务提示词（目录结构即访问路径）
│   │   ├── classify.md         → path = doc/classify
│   │   ├── route.md            → path = doc/route
│   │   └── review.md           → path = doc/review
│   ├── claude-md.md            # CLAUDE.md 主模板（Agent 工作区行为规范）
│   └── sections/               # 可插拔的"外部服务调用说明"片段
│       ├── wps.md              # WPS 文件下载回退
│       └── audit.md            # rdCLI 审稿服务
├── data/                     # 运行时数据（SQLite + 日志 + 密钥）
└── build/                    # Dockerfile + 部署脚本
```

### 数据目录与挂载（重要）

数据按「是否需要在容器外持久化」分为三类，Docker 部署时**只挂载第 1 类目录**。

| 类别 | 目录 | 内容 | 持久化 | 说明 |
|------|------|------|--------|------|
| 第 1 类 | `DATA_DIR`（宿主机挂载到 `/app/data`） | `cfg.yml`、`app.db`、`logs/`、`secrets.key` | ✅ 重启保留 | 配置文件、数据库、日志、加密密钥 |
| 第 2 类 | `/app/assets`（镜像内，不挂载） | `cfg.csv.template`、`mock.json` | ✅ 随镜像 | 静态模板资源，构建时打入镜像 |
| 第 3 类 | `RUNTIME_DIR`（容器内，不挂载） | `tasks/`、`claude-config/` | ❌ 重启丢弃 | SDK 工作目录与会话历史，ephemeral |

**环境变量**：

- `DATA_DIR` — 第 1 类持久化数据根目录（默认 `./data`，Docker 中为 `/app/data`）
- `RUNTIME_DIR` — 第 3 类运行时工作目录（默认 `./runtime`，Docker 中为 `/app/runtime`）

**关键点**：

- SDK 会话历史写入 `RUNTIME_DIR/claude-config`（通过 `CLAUDE_CONFIG_DIR` 环境变量指定），**不再使用 `~/.claude`**。这避免了宿主机 UID 与容器 UID 不一致时，bind mount 的 `~/.claude` 目录无法写入导致历史消息丢失的问题。
- `tasks/`（每个任务的 SDK 工作目录，含下载的文件、上下文快照）同样放在 `RUNTIME_DIR`，重启后自动丢弃，不影响持久化数据。
- 因此 Docker 部署**不需要**再挂载 `$DATA_DIR/.claude`，`run.sh` 已移除该挂载项。


### 提示词与配置管理（模板管理页面）

所有提示词和业务配置统一在**模板管理页面**（管理员 → 模板管理）通过三步引导式流程管理。

#### 设计原则

| 数据 | 存放位置 | 流向 | 说明 |
|------|----------|------|------|
| 提示词模板（txt） | `prompts/` 目录 | **双向**：可上传 / 可下载 | 下载 → 离线编辑 → 上传覆盖 |
| 业务配置（key/value/说明） | `prompt_config` 表（加密） | **单向**：只能上传，不可下载 | CSV 上传后 AES-256-GCM 加密入库 |

- **CSV 单向不可逆**：接口地址、Token 等敏感信息一旦上传就无法再下载明文，防止泄露
- **Tar 双向可迭代**：下载当前版本 → 离线修改 → 上传替换，闭环编辑
- **加密密钥分离**：密钥独立存放在 `data/secrets.key`（首次启动自动生成，权限 600），与 `app.db` 分离，单独偷走任一文件无法解密

#### 三步引导式流程

```
步骤 1                   步骤 2                   步骤 3
上传配置 CSV  ──────────▶ 上传 Prompt tar 包 ─────▶ 预览 / 下载
  │                          │                        │
  │ ① 下载 CSV 模板         │ ① 下载当前 tar         │ 预览所有文件
  │ ② 填写 key/value/说明    │ ② 解压，编辑 txt       │ 下载当前 tar
  │ ③ 上传（加密入库）       │ ③ 打包，上传（校验）   │
  │                          │                        │
  │ CSV 模板格式：           │ tar 包结构：            │
  │ key,value,说明           │ classify.md           │
  │                          │ route.md              │
  │                          │ review.md             │
  │                          │ claude-md.md          │
  │                          │ sections/*.md         │
```

##### 步骤 1：上传配置 CSV

CSV 为三列：`key`, `value`, `说明`。点击「下载 CSV 模板」获取空模板，填写后上传。

- key 以 `_token` / `_secret` / `_password` / `_key` 结尾的自动标记为 🔒 敏感项
- 敏感项的 value 默认脱敏显示（`ab****cd`），点击 👁 图标可临时查看明文
- CSV **只能上传，无法下载**（下载按钮只返回空模板，不包含已配置数据）

配置列表上传后实时展示，供后续步骤中子 tar 的占位符校验使用。

##### 步骤 2：上传 Prompt tar 包

首次使用点击「下载当前 tar」获取内置默认模板。解压后所见结构：

```
prompts/
├── doc/                  # 业务提示词目录（目录结构即访问路径）
│   ├── classify.md        → path = doc/classify（收文分类）
│   ├── route.md           → path = doc/route（流转目标识别）
│   └── review.md          → path = doc/review（发文审核）
├── claude-md.md           # CLAUDE.md 主模板（Agent 工作区行为规范）
└── sections/              # 条件段落（可插拔）
    ├── wps.md             # WPS 文件下载回退
    └── audit.md           # rdCLI 审稿服务
```

**路径映射规则**：`prompts/` 下的相对路径去掉 `.md` 后缀即对外访问路径。例如：

- `prompts/doc/classify.md` → 访问路径 `doc/classify`
- `prompts/hr/recruit.md` → 访问路径 `hr/recruit`
- `prompts/finance/approval.md` → 访问路径 `finance/approval`

想要新增入口，在 tar 包里加对应子目录 + `.md` 文件即可，无需改代码。

**排除规则**：`claude-md.md`、`sections/` 目录、以下划线 `_` 开头的文件/目录，不作为访问路径。

离线编辑后打包为 `.tar.gz`，上传时自动执行占位符校验：

- 扫描所有 `.md` 文件中的 `{{...}}` 占位符
- 对照步骤 1 已上传的 CSV key，**key 不存在则拒绝上传并列出缺失项**
- `{{request.*}}` 和 `{{section:...}}` 开头的占位符无需 CSV 配置

##### 步骤 3：预览 / 下载

上传成功后可在步骤 3 中按文件折叠预览模板内容，也可重新下载当前 tar 进入下一轮编辑迭代。

#### 占位符语法

**① 业务提示词（`classify.md` 等）— `{{request.xxx}}`**

运行时由请求 JSON 替换。例如模板里写 `{{request.body}}`，运行时替换为整个请求体。

**② CLAUDE.md — `{{key}}` （来自 CSV）**

直接引用 CSV 中配置的 key，运行时替换为对应的 value。例如模板里写 `{{sys.doc_util_url}}`，运行时从 `prompt_config` 表中取 `sys.doc_util_url` 的值替换。

**③ 条件段落 — `{{section:名称:触发key}}`**

语法：`{{section:片段名:CSV中的key}}`

只有当 CSV 中对应的 key **有值**时，才会把 `sections/片段名.md` 的内容插入此处；否则整段静默删除。

示例：
```markdown
{{section:audit:doc_audit.api_url}}
```
- `doc_audit.api_url` 在 CSV 中有值 → 读取 `sections/audit.md` 插入
- 为空或不存在 → 整行移除

#### 新增外部服务接口（无需改代码）

假设要新增"组织机构查询服务"：

**① 在 CSV 中新增一行**
```
sys.org_api_url,https://oa-server:8080/api/org,组织机构查询服务地址
```

**② 新建 `sections/org.md`**
```markdown
## 组织机构查询服务

查询组织架构、部门归属关系。接口令牌通过环境变量 `FILE_URL_TOKEN` 提供。

```bash
curl -s -k --noproxy '*' -w'\n' -X GET '{{sys.org_api_url}}/dept/tree' \
  -H "Authorization: Bearer $FILE_URL_TOKEN" | jq '.'
```
```

**③ 在 `claude-md.md` 中添加引用行**
```markdown
{{section:org:sys.org_api_url}}
```

**④ 重新打包 tar 并上传。下一个新任务自动生效。**

#### 注意事项
- `claude-md.md` 和 `sections/*.md` 是**每个新任务启动时读取**的，上传 tar 后下一个新任务立即生效，无需重启服务
- 通过 session 复用的已有任务不会重新读取 CLAUDE.md（首次快照固化）
- `classify.md` / `route.md` / `review.md` 也是**每个新任务启动时从磁盘实时读取**，上传 tar 后即刻生效
- 代码仓库自带的 `prompts/` 目录作为种子模板，首次部署即可用

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js ≥22, TypeScript |
| HTTP | Express.js |
| AI 引擎 | `@anthropic-ai/claude-agent-sdk` |
| 存储 | SQLite (better-sqlite3) |
| 前端 | Vanilla JS SPA |
| 部署 | Docker, 自签 HTTPS |