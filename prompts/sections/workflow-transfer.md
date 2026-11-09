## 工作流流转信息查询接口

查询当前流程节点下，下一步可选的启动的收文工作流及其表单 ID相关信息。接口令牌通过环境变量 `FILE_URL_TOKEN` 提供。

```bash
curl -s -k --noproxy '*' -w'\n' -G \
  "${DP_DOC_WORKFLOW_NEXT_NODE_OPTIONS_INFO_SEARCH_URL}" \
  --data-urlencode "stepId=<当前节点ID>" \
  --data-urlencode "userId=<处理人账号>" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${FILE_URL_TOKEN}" | jq '.'
```

- `stepId`：当前流程节点 ID（如 `startReceiveWorkflow`）
- `userId`：处理人账号（如 `ptr\exampleUser`，`--data-urlencode` 会自动将反斜杠编码为 `%5C`）
- 从返回结果中按工作流名称（`workflowFormName`）匹配对应的工作流表单 ID（`workflowFormId`）
