## 电子公文流转工作流配置接口

查询当前公文流转所属的工作流配置信息。接口令牌通过环境变量 `FILE_URL_TOKEN` 提供。

```bash
curl -s -k --noproxy '*' -w'\n' \
  "${DP_DOC_WORKFLOW_CONFIG_URL}/<workflow_id>?_t=<当前时间戳毫秒>" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $FILE_URL_TOKEN" | jq '.'
```

- `workflow_id`：工作流 ID（如 `01a1a45f-f546-7d4a-b955-4b97b39a55e1`），取自请求 `JSON` 中的 `workflow_id` 字段
- `_t`：当前时间戳（毫秒），用于避免缓存
- 返回该工作流的完整步骤配置数据