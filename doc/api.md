# AI 数字员工 对外接口文档

Base URL: `https://<host>:20001`

认证方式：请求头 `Authorization: Bearer <token>` 或 `X-Api-Key: <token>`

---

## 1. 提交任务

```
POST /api/v1/<path>
```

核心业务接口。path 由管理员在后台配置，每个 path 绑定一套提示词模板。请求到达后立即返回 task_id，异步处理完成后回调 `callback_url`。

**请求体（JSON）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `linkid` | string | 是 | 业务流水号，回调时原样带回 |
| `callback_url` | string | 是 | 回调地址，处理完后 POST 到这里 |
| `*` | any | 否 | 其他字段无限制，全部透传给 AI 智能体 |

**响应** (200)

```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:00:00",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "linkid": "doc_001"
}
```

**错误响应**

| code | HTTP | 说明 |
|------|------|------|
| 1001 | 404 | 接口路径不存在 |
| 1001 | 400 | 缺少 linkid / callback_url / 请求体为空 |
| 1003 | 401 | API Token 无效 |
| 2002 | 503 | 任务队列已满 |

**回调格式**（AI 数字员工 → callback_url）

成功：
```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:02:30",
  "message": "success",
  "task_id": "550e8400-...",
  "linkid": "doc_001",
  "data": { ... }
}
```

失败：
```json
{
  "code": 5000,
  "timestamp": "2026-01-01 12:02:30",
  "message": "Claude 处理失败: <错误原因>",
  "task_id": "550e8400-...",
  "linkid": "doc_001",
  "data": null
}
```

回调失败会自动重试（最多 3 次，指数退避）。

**示例**

```bash
curl -k -w'\n' --noproxy '*' -X POST https://localhost:20001/api/v1/document/classify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_token" \
  -d '{
    "linkid": "doc_20260101_0001",
    "callback_url": "https://your-system/api/callback",
    "process_type": "company_receive",
    "current_step": "收文登记",
    "form_data": {
      "title": "关于2026年度工作安排的通知",
      "from_org": "集团办公室",
      "deadline": "2026-02-15"
    },
    "files": [
      {
        "file_url": "https://file-server/attachments/doc.pdf",
        "file_type": "main_body",
        "file_name": "红头文件.pdf"
      }
    ],
    "next_nodes": ["部门会签", "领导审批"]
  }'
```

---

## 2. 查询进行中任务

```
GET /api/v1/tasks
```

列出所有未结束的任务（pending / processing 状态）。

**响应** (200)

```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:05:00",
  "message": "success",
  "task_id": "",
  "linkid": "",
  "data": {
    "total": 2,
    "tasks": [
      {
        "task_id": "550e8400-...",
        "linkid": "doc_001",
        "interface_path": "document/classify",
        "status": "processing",
        "callback_url": "https://your-system/api/callback",
        "created_at": "2026-01-01 12:00:00"
      },
      {
        "task_id": "660e8400-...",
        "linkid": "doc_002",
        "interface_path": "document/route",
        "status": "pending",
        "callback_url": "https://your-system/api/callback",
        "created_at": "2026-01-01 12:04:00"
      }
    ]
  }
}
```

**示例**

```bash
curl -k -w'\n' --noproxy '*' https://localhost:20001/api/v1/tasks \
  -H "Authorization: Bearer your_api_token"
```

---

## 3. 取消任务

```
DELETE /api/v1/tasks/<task_id>
```

取消一个尚未开始处理（pending 状态）的任务。

**响应** (200)

```json
{
  "code": 0,
  "message": "任务已取消",
  "task_id": "550e8400-...",
  "linkid": "doc_001"
}
```

**注意**：只有 `pending` 状态的任务可以取消，`processing`（正在执行）及之后状态的任务无法取消。

**示例**

```bash
curl -k -w'\n' --noproxy '*' -X DELETE https://localhost:20001/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your_api_token"
```

---

## 4. 任务追踪

```
GET /api/v1/task/trace?taskid=<task_id>
```

查看任务的完整上下文，包括原始请求、渲染后的提示词、AI 智能体输出、回调体等。

**响应** (200)

```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:10:00",
  "message": "success",
  "task_id": "550e8400-...",
  "linkid": "doc_001",
  "data": {
    "task_id": "550e8400-...",
    "linkid": "doc_001",
    "path": "document/classify",
    "status": "completed",
    "request_body": { "linkid": "doc_001", ... },
    "prompt": "# 文档处理任务\n\n...",
    "sdk_output": "```json\n{\"need_human\": false, ...}\n```",
    "callback_body": { "code": 0, "data": { ... } },
    "error_message": null,
    "created_at": "2026-01-01 12:00:00",
    "finished_at": "2026-01-01 12:02:30"
  }
}
```

**字段说明**

| 字段 | 说明 |
|------|------|
| `request_body` | 原始请求 JSON |
| `prompt` | 占位符渲染后的完整提示词 |
| `sdk_output` | AI 智能体输出的原始文本 |
| `callback_body` | 投递给 callback_url 的回调体 |
| `error_message` | 失败时的错误信息 |

**示例**

```bash
curl -k -w'\n' --noproxy '*' "https://localhost:20001/api/v1/task/trace?taskid=550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer your_api_token"
```

---

## 5. 任务实时流

```
GET /api/v1/task/stream?taskid=<task_id>
```

查看 AI 智能体执行过程中的实时流式输出（文本、工具调用、工具返回等）。

**响应** (200)

```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:01:30",
  "message": "success",
  "task_id": "550e8400-...",
  "linkid": "doc_001",
  "data": {
    "status": "processing",
    "stream": [
      {
        "ts": "12:00:02.123",
        "type": "text",
        "text": "开始处理文档分类任务..."
      },
      {
        "ts": "12:00:05.456",
        "type": "tool",
        "tool_name": "Bash",
        "text": "curl -k -o doc.pdf https://...",
        "tool_input": "{\"command\":\"curl -k -o doc.pdf https://...\"}"
      },
      {
        "ts": "12:00:07.789",
        "type": "tool_result",
        "text": "文件下载完成 (123KB)",
        "tool_output": "..."
      },
      {
        "ts": "12:00:10.000",
        "type": "text",
        "text": "已读取文件内容，正在分析..."
      }
    ]
  }
}
```

**流式事件类型**

| type | 说明 |
|------|------|
| `text` | 智能体文本输出 |
| `tool` | 工具调用（如 Bash、Read） |
| `tool_result` | 工具返回结果 |
| `system` | 系统消息 |
| `error` | 异常信息 |

任务处理中可反复轮询，`status` 变为 `success`/`failed`/`completed`/`callback_fail` 后流内容不再变化。

**示例**

```bash
curl -k -w'\n' --noproxy '*' "https://localhost:20001/api/v1/task/stream?taskid=550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer your_api_token"
```

---

## 6. 任务审计日志

```
GET /api/v1/task/log/<task_id>[?format=json|html]
```

查看任务生命周期的时间线，按创建 → 渲染 → 执行 → 回调的顺序展示完整事件链。默认返回 HTML（`format=html`），指定 `?format=json` 返回 JSON。

**响应** (200, `format=json`)

```json
{
  "code": 0,
  "timestamp": "2026-01-01 12:10:00",
  "message": "success",
  "task_id": "550e8400-...",
  "linkid": "doc_001",
  "data": {
    "task_id": "550e8400-...",
    "linkid": "doc_001",
    "path": "document/classify",
    "status": "completed",
    "callback_url": "https://your-system/api/callback",
    "created_at": "2026-01-01 12:00:00",
    "finished_at": "2026-01-01 12:02:30",
    "timeline": [
      {
        "time": "2026-01-01 12:00:00",
        "type": "create",
        "title": "任务创建",
        "detail": "访问路径: document/classify"
      },
      {
        "time": "2026-01-01 12:00:00",
        "type": "input",
        "title": "收到请求数据",
        "detail": "{\n  \"linkid\": \"doc_001\", ...\n}"
      }
    ]
  }
}
```

`format=html`（默认）时返回一个可直接在浏览器中查看的 HTML 页面，带时间线可视化。

**示例**

```bash
# HTML 格式（默认）
curl -k -w'\n' --noproxy '*' "https://localhost:20001/api/v1/task/log/550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer your_api_token"

# JSON 格式
curl -k -w'\n' --noproxy '*' "https://localhost:20001/api/v1/task/log/550e8400-e29b-41d4-a716-446655440000?format=json" \
  -H "Authorization: Bearer your_api_token"
```

---

## 7. 按 linkid 查询任务审计日志

```
GET /api/v1/task/link/log/<linkid>[?format=json|html]
```

与 `GET /api/v1/task/log/<task_id>` 逻辑一致，但按 `linkid` 查询。由于 linkid 不保证唯一，服务端按任务创建时间倒序取**最新一条**记录渲染。

**响应 / 示例**

与任务审计日志接口完全相同，仅 URL 中的标识符换成 linkid：

```bash
curl -k -w'\n' --noproxy '*' "https://localhost:20001/api/v1/task/link/log/doc_001?format=json" \
  -H "Authorization: Bearer your_api_token"
```

---

## 任务状态说明

| 状态 | 说明 |
|------|------|
| `pending` | 排队等待处理 |
| `processing` | 智能体正在执行 |
| `completed` | 回调成功，任务完结 |
| `failed` | 智能体执行失败 |
| `callback_fail` | 回调重试耗尽，最终失败 |
| `cancelled` | 用户取消 |