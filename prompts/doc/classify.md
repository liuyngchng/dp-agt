# 流转文件分类任务

你需要处理一份在组织内流转的文件，识别是部门内收文还是部门外收文。如果需要组织机构关系信息，请自行调用相关工具查看。以下是请求信息：

```json
{{request.body}}
```

## 执行步骤

### 步骤 1：下载文件
遍历请求中的 `files` 数组，用 curl 下载每个 `file_url` 到工作目录。文件 URL 无需认证即可直接下载。

### 步骤 2：读取文件内容
用 Read 工具读取下载的文件，获取公文正文、发文单位、收文单位等关键信息。

### 步骤 3：识别收文类型
根据公文内容和请求中的组织信息，判断是部门内收文还是部门外收文：
- **部门内收文**：发文方和收文方属于同一部门（或同一组织分支）
- **部门外收文**：发文方来自其他部门/外部单位

如果需要确认组织机构关系，可主动调用相关接口查询。

### 步骤 4：执行结果回调

重要参数：
- 当前任务 task_id: `{{task_id}}`
- 本次请求 linkid: `{{request.linkid}}`

在输出最终 JSON 之前，**必须**先执行结果回调。回调 payload 的 `data` 字段，就是下方「输出要求」中定义的 JSON 结果（步骤 3 构建完成后填入）。
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
  "doc_type": "internal",
  "source_type": "",
  "form_fill": {
    "file_no": "",
    "from_org": "",
    "deadline": "",
    "doc_date": ""
  },
  "opinion_text": "",
  "need_manual_restart": false,
  "ledger_data": null
}
```

字段说明：
- `doc_type`: "internal" 表示部门内收文，"external" 表示部门外收文
- `source_type`: 如有更细分类（如 "group" 集团来文、"gov" 政府来文等）则填写，否则留空

## 注意事项
- 所有文本字段（fail_reason、opinion_text 等）必须输出简体中文
- 文件下载前先检查本地是否已有该文件
- 如果文件无法下载，将 need_human 设为 true 并在 fail_reason 中说明原因
