## 1. 日志位置

运行日志写入`APP` 当前目录下的  `data/logs/`（`DATA_DIR/logs`，Docker 中为 `/app/data/logs`），按天滚动：

- 文件名：`app.<yyyy-MM-dd>.<n>.log`（当天活跃文件）；滚动后的旧文件压缩为 `app.<yyyy-MM-dd>.<n>.log.gz`
- 格式：每行一条 `JSON`，含 `datetime`（`YYYY-MM-DD HH:mm:ss`）、`msg`（事件名）、`task_id`、`linkid` 等字段
- `zgrep` 能同时读未压缩的 `.log` 与压缩的 `.gz`，历史日志无需先解压

## 2. 关键事件

按 `msg` 字段（事件名）区分日志类型：

| 事件 `msg`                                                   | 含义                          | 关键字段                                                  |
| ------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| `request_received`                                           | 收到调用方请求                | `path`、`body`（含 `linkid`、`files`、`callback_url` 等） |
| `api_request_completed`                                      | 入队成功，返回给调用方        | `task_id`、`linkid`、`response`                           |
| `request_rejected`                                           | 请求被拒绝（400/404/409/503） | `request`、`response`（错误码/原因）                      |
| `task_processing` / `task_done` / `task_failed` / `task_cancelled` | 任务状态流转                  | `task_id`、`linkid`                                       |
| `sdk_run_start` / `sdk_run_complete` / `sdk_run_error`       | Claude Agent `SDK` 执行起止   | `taskId`、`linkid`、`durationMs`                          |
| `callback_request`                                           | Agent 发起回调的 curl 命令    | `command`                                                 |
| `callback_response`                                          | 回调对方的返回内容            | `callbackResponse`                                        |

> 说明：`SDK` 的**最终输出正文**不落日志文件（只记长度 `outputLen`），完整结果存于数据库 `task_logs.sdk_output`，可在管理后台的「任务」/「数据表」页面查看。

## 3. 按 `linkid` 查看

假设 `linkid` 为 `xxxx`：

```bash
cd data/logs

# ① request —— 调用方的请求体 + 系统同步返回体
zgrep -h 'request_received\|api_request_completed\|request_rejected' app.*.log* \
  | grep 'xxxx'

# ② response —— 系统返回给调用方的响应体
zgrep -h 'api_request_completed' app.*.log* | grep 'xxxx'

# ③ callback —— Agent 回调的 curl 命令 + 对方返回内容
zgrep -h 'callback_request\|callback_response' app.*.log* | grep 'xxxx'

# ④ 一键串起完整链路（request → 任务流转 → SDK → callback）
zgrep -h -e 'request_received' -e 'api_request_completed' -e 'request_rejected' \
  -e 'task_processing' -e 'task_done' -e 'task_failed' -e 'task_cancelled' \
  -e 'sdk_run_start' -e 'sdk_run_complete' -e 'sdk_run_error' \
  -e 'callback_request' -e 'callback_response' \
  app.*.log* | grep 'xxxx'
```

每行是一条 `JSON`，可直接交给 `jq` 美化查看：

```bash
zgrep -h 'callback_response' app.*.log* | grep 'xxxx' | jq .
```

## 4. 技巧

- **只查某天**：把 glob 换成具体日期，如 `zgrep 'xxxx' app.2025-11-23.*.log*`
- **同一 `linkid` 有多轮任务**（session 复用）时，用 `task_id` 区分每次提交：先由 `api_request_completed` 拿到 `task_id`，再用 `grep '<task_id>'` 追对应的 `SDK` / `callback`记录
- **注意脱敏**：`request_received` 的 `body` 会打印原始请求体，可能含真实单位/人名，导出或贴出日志前先按需脱敏