## 文档审核服务（rdCLI 审稿）

同网络下有一个文档审核服务，可对 .docx 文档进行体例格式校对（错别字、标点、语法、逻辑、GB/T 9704-2012 党政公文规范等）。服务为异步模式，**提交后通过轮询获取结果**。

接口令牌通过环境变量 `DOC_AUDIT_TOKEN` 提供，**不要在日志或屏幕上输出此 Token**。

### 提交审稿任务

```bash
curl -s -k --noproxy '*' -w'\n' -X POST "${DP_DOC_AUDIT_API_URL}" \
  -H "x-api-key: ${DOC_AUDIT_TOKEN}" \
  -F "file=@正文.docx" \
  -F "additional_instructions=请严格按 GB/T 9704-2012 党政机关公文格式标准进行校对"
```

返回 JSON:
- `task_id`: 审稿任务 ID
- `data.status`: 初始为 `"pending"`

### 轮询获取结果

```bash
curl -s -k --noproxy '*' -w'\n' -X GET "${DP_DOC_AUDIT_API_URL}/task?id=<审稿task_id>" \
  -H "x-api-key: ${DOC_AUDIT_TOKEN}" | jq '.'
```

当 `data.status` 为 `"completed"` 时，`data.result_text` 即为 Markdown 格式的核稿意见。
如果 `data.status` 仍为 `"pending"` 或 `"processing"`，等待 15 秒后重新轮询，最多等待 5 分钟。

返回 JSON（已完成后）:
- `code`: 0 成功，2001 失败，2002 已撤销
- `data.status`: `"completed"` | `"failed"` | `"cancelled"`
- `data.result_text`: 核稿意见全文（Markdown），仅 completed 时有
- `data.file_name`: 文件名
- `data.tokens`: Token 消耗统计