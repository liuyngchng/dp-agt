# 承办部门识别任务

你需要根据公文内容、领导批示意见以及部门职责，判断公文应转交给哪个（或哪些）部门承办。以下是请求信息：

```json
{{request.body}}
```

## 请求结构说明

- `linkid` / `target` / `deptid`：公文与处理人身份信息，需原样透传到结果
- `form_data`：表单元数据（标题 `title`、来文单位 `unitOfReceipt`、所属部门 `docDeptDisplayName` 等）
- `files`：公文附件数组，其中 `file_type = "main_body"` 的是正文
- `approval_history`：审批流转记录（含领导批示意见）
- `next_nodes`：当前节点可选的下一流转节点（含可选部门/人员列表）

## 执行步骤

### 步骤 1：下载并读取公文正文

遍历 `files` 数组，用 curl 下载正文（`file_type = "main_body"`）到工作目录，并用文档解析服务提取纯文本（下载与解析方式见系统提示 CLAUDE.md）。若上下文中已有该文件文本，直接复用，无需重复下载。

### 步骤 2：读取业务知识记忆库

参考系统提示（CLAUDE.md）中的「业务知识记忆库」章节，读取部门及附属单位职责文件（使用表中给出的绝对路径），用于判断公文事项应归属哪个部门的职责范围。

### 步骤 3：分析领导批示意见

阅读 `approval_history` 中的领导批示意见，重点关注领导在批注中点名要求承办或协办的部门（例如"请某部门承办"、"请某部门协同落实"等）。

### 步骤 4：判断承办部门

综合以下信息判断承办部门：

1. 公文正文内容（事项归属）
2. `form_data` 中的标题、来文单位等字段
3. `approval_history` 中领导的批示意见
4. 部门职责记忆库

得到建议承办的部门列表。若领导批示中已明确点名部门，优先以批示为准；否则依据部门职责与公文事项匹配。

### 步骤 5：执行结果回调

重要参数：
- 当前任务 task_id: `{{task_id}}`
- 本次请求 linkid: `{{request.linkid}}`

在输出最终 JSON 之前，**必须**先执行结果回调。回调 payload 的 `data` 字段，就是下方「输出要求」中定义的 JSON 结果（步骤 4 构建完成后填入）。
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
  "departments": [
    {
      "id": "",
      "name": "某部门"
    }
  ],
  "next_node": {
    "id": "",
    "name": ""
  },
  "opinion_text": "转某部门承办",
  "remark": ""
}
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `need_human` | 正常完成时为 `false`；仅当正文无法读取、部门无法判断、回调失败等异常时才设为 `true` 并在 `fail_reason` 说明原因 |
| `fail_reason` | 正常为空字符串；异常时填简体中文原因 |
| `departments` | 建议承办的部门列表；`id` 若能在 `next_nodes` 中匹配到则填入，否则为空字符串；`name` 为部门名称 |
| `next_node` | 若能从 `next_nodes` 中匹配到对应流转节点则填入其 `id` 和 `name`，否则留空 |
| `opinion_text` | 承办意见文本，规范的中文公文用语 |
| `remark` | 补充说明，可为空字符串 |

## 注意事项

- 所有文本字段（`fail_reason`、`opinion_text`、`remark` 等）必须使用简体中文
- 承办部门必须依据领导批示或部门职责判断，不得凭空猜测
- 优先从 `next_nodes` 中匹配已存在的节点，避免选择不存在的节点
- 若正文无法下载、部门无法判断、接口调用失败，将 `need_human` 设为 `true` 并在 `fail_reason` 中说明原因
- json 代码块之外不要输出任何其他内容
