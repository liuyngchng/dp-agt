# 流转目标识别任务

你需要根据审批意见识别文件的下一流转节点，并自动填写相关信息。以下是请求信息：

```json
{{request.body}}
```

## 执行步骤

### 步骤 1：下载并读取文件
遍历请求中的 `files` 数组，用 curl 下载文件并用 Read 工具读取。

### 步骤 2：分析
结合 `approval_history`（审批意见）、`next_nodes`（可选节点）、`leader_division`（领导分工）等信息，判断应该选中的下一节点。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 ```json 代码块包裹：

```json
{
  "need_human": false,
  "fail_reason": "",
  "next_node": {
    "id": "",
    "name": "",
    "type": "person"
  },
  "opinion_text": "",
  "form_fill": {},
  "remark": ""
}
```

## 注意事项
- 所有文本字段（fail_reason、opinion_text、remark 等）必须输出简体中文
- next_node 必须从 next_nodes / person_list / org_list 中选择已存在的节点
- 如果无法确定，将 need_human 设为 true 并在 fail_reason 中说明原因
- 不要输出任何其他内容，只输出 JSON
