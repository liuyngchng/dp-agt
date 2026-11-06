# 公文信息填充任务

你需要从公文正文中自动提取登记所需的字段信息，用于收文登记时填充表单。以下是请求信息：

```json
{{request.body}}
```

## 请求结构说明

- `linkid` / `target` / `deptid`：公文与处理人身份信息，需原样透传到结果
- `form_data`：当前已有的表单元数据（可能为空或部分字段已填）
- `form_data_desc`：表单字段的中文说明映射（字段名 → 中文含义）
- `files`：公文附件数组，其中 `file_type = "main_body"` 的是正文
- `next_nodes`：当前节点可选的下一流转节点

## 执行步骤

### 步骤 1：下载并读取公文正文

遍历 `files` 数组，用 curl 下载正文（`file_type = "main_body"`）到工作目录，并用文档解析服务提取纯文本（下载与解析方式见系统提示 CLAUDE.md）。若上下文中已有该文件文本，直接复用，无需重复下载。

### 步骤 2：提取公文登记字段

从正文文本中提取以下信息（结合 `form_data` 中已有的内容，能确认的字段优先从正文提取，正文未提及的保留原有值或留空）：

- **标题**（`title`）：公文的标题
- **文号**（`documentNumber`）：发文字号
- **来文单位**（`unitOfReceipt`）：发文单位/来文单位名称
- **成文日期**（`writtenDate`）：落款日期，格式 `YYYY-MM-DD`
- **紧急程度**（`emergencyLevel`）：如"加急"、"特急"
- **办文时限**（`timeLimitWriting`）：正文中要求反馈的期限（如"请于 X 年 X 月 X 日前反馈"）
- **密级**（`secretClass`）：如"绝密"、"机密"、"秘密"

字段名以请求 `JSON` 中 `form_data` 实际出现的字段名为准，参考 `form_data_desc` 判断每个字段的含义。

### 步骤 3：组装填充结果

将提取到的字段整理进 `filled_fields`，仅包含能够从正文中确认的字段；无法确认的字段不要填充。

### 步骤 4：执行结果回调

重要参数：
- 当前任务 `task_id`: `{{task_id}}`
- 本次请求 `linkid`: `{{request.linkid}}`

在输出最终 `JSON` 之前，**必须**先执行结果回调。回调 payload 的 `data` 字段，就是下方「输出要求」中定义的 `JSON` 结果（步骤 3 构建完成后填入）。
回调的具体 curl 命令模板见系统提示（`CLAUDE.md`）中的「结果回调」章节，直接照做即可。
回调 payload 中的 `task_id` 和 `linkid` 必须使用上面给出的准确值。

回调成功（HTTP 2xx）后再输出下面的 `JSON`。回调失败重试最多 3 次（间隔 2/4/8 秒），
仍失败则在 `JSON` 的 `fail_reason` 中补充「结果回调失败：<错误信息>」并将 `need_human` 设为 `true`。

## 输出要求

请按以下 `JSON` Schema 输出最终结果，用 ```json 代码块包裹：

```json
{
  "need_human": false,
  "fail_reason": "",
  "filled_fields": {
    "title": "某公司关于某某事项的通知",
    "documentNumber": "",
    "unitOfReceipt": "某外部单位",
    "writtenDate": "2026-01-15",
    "emergencyLevel": "",
    "timeLimitWriting": "",
    "secretClass": ""
  }
}
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `need_human` | 正常完成时为 `false`；仅当正文无法读取、回调失败等异常时才设为 `true` 并在 `fail_reason` 说明原因 |
| `fail_reason` | 正常为空字符串；异常时填简体中文原因 |
| `filled_fields` | 从正文提取出的登记字段键值对，字段名与 `form_data` 一致；未提取到的字段不要出现，或保留空字符串 |

## 注意事项

- 所有文本字段（`fail_reason` 等）必须使用简体中文
- 只填充能够从正文中确认的字段，不要臆造值
- 日期统一为 `YYYY-MM-DD` 格式
- 若正文无法下载或解析失败，将 `need_human` 设为 `true` 并在 `fail_reason` 中说明原因
- `JSON` 代码块之外不要输出任何其他内容
