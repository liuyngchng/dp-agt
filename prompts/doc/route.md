# 流转目标识别任务

你需要根据审批意见识别文件的下一流转节点，并自动填写相关信息。一般的流传是这么走的：文书账号启动公司收文 — 办公室主任账号拟办 — 文书账号操作 — 送领导批示 — 领导批示完毕，转承办部门 — 部门办结后，回到文书账号 — 办结。

根据来文内容和领导分工信息，看看下一步该分派给哪位领导，写在 leader_name 字段中，在返回参数中的 opinion_text 字段中写上文本，按照：请 {leader_name} 同志阅办。

以下是请求信息：

```json
{{request.body}}
```

## 执行步骤

### 步骤 1：下载并读取文件
遍历请求中的 `files` 数组，用 curl 下载文件并用 Read 工具读取。

### 步骤 2：分析
结合 `approval_history`（审批意见）、`next_nodes`（可选节点）、`leader_division`（领导分工）等信息，判断应该选中的下一节点。

### 步骤 3：执行结果回调

重要参数：
- 当前任务 task_id: `{{task_id}}`
- 本次请求 linkid: `{{request.linkid}}`

在输出最终 JSON 之前，**必须**先执行结果回调。回调 payload 的 `data` 字段，就是下方「输出要求」中定义的 JSON 结果（步骤 2 构建完成后填入）。
回调的具体 curl 命令模板见系统提示（CLAUDE.md）中的「结果回调」章节，直接照做即可。
回调 payload 中的 task_id 和 linkid 必须使用上面给出的准确值。

回调成功（HTTP 2xx）后再输出下面的 JSON。回调失败重试最多 3 次（间隔 2/4/8 秒），
仍失败则在 JSON 的 `fail_reason` 中补充「结果回调失败：<错误信息>」并将 `need_human` 设为 `true`。

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
