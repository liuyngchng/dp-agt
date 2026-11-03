# 收文流程启动任务

你需要处理一份「待收公文」，识别应启动的收文工作流（公司收文 / 部门收文），
并组装启动收文流程所需的完整数据体返回给调用方。以下是请求信息：

```json
{{request.body}}
```

## 请求结构说明

- `linkid` / `target` / `deptid`：公文与处理人身份信息，需原样透传到结果
- `targetName` / `deptFullPath`：处理人姓名 / 部门完整路径，若输入提供则原样透传
- `current_stepid` / `current_step`：当前流程节点（如 `startReceiveWorkflow` / `待收公文`）
- `form_data`：表单元数据（标题 `title`、来文单位 `unitOfReceipt`、所属部门 `docDeptDisplayName`、类型 `type` 等）
- `feedback`：反馈信息（`direction` 流转方向、`needIdea` 是否需要办理意见）
- `workflow_transfer`：工作流名称 → 工作流表单 ID 的映射（如 `{"公司收文": "<formId>"}`）
- `files`：公文附件数组，其中 `file_type = "main_body"` 的是正文

## 执行步骤

### 步骤 1：读取公文内容

遍历 `files` 数组，用 curl 下载正文（`file_type = "main_body"`）到工作目录，并用 Read 工具读取，
获取发文单位、收文单位、来文单位等关键信息（下载与解析方式见系统提示 CLAUDE.md）。
若上下文中已有该文件文本，直接复用，无需重复下载。

### 步骤 2：识别收文工作流

根据公文内容，结合 `form_data.unitOfReceipt`（来文单位）、`form_data.docDeptDisplayName`（所属部门）等信息，
判断应启动的收文工作流，得到 `workflowFormName`：

- **公司收文**：来文来自外部单位（其他公司、集团、政府机关等），进入公司层面收文流程。
  例如 `unitOfReceipt = "某外部单位"` 这类外部单位来文。
- **部门收文**：来文在本公司内部部门之间或部门内部流转。

### 步骤 3：获取工作流表单 ID

调用工作流转接口，获取 `workflowFormName` 对应的表单 ID（`workflowFormId`）。
接口调用方法见系统提示（CLAUDE.md）中的「工作流转接口」章节，直接照做即可。

参数取自请求 JSON：
- `stepId` = `current_stepid`（如 `startReceiveWorkflow`）
- `userId` = `target`

从返回结果中匹配 `workflowFormName` 对应的 ID。若输入 JSON 的 `workflow_transfer` 里已含该映射，也可直接取用。

### 步骤 4：组装返回数据体

按下方「输出要求」的 JSON Schema 组装数据体，字段来源如下：

| 字段 | 来源 |
|------|------|
| `linkid` | 透传 `linkid` |
| `target` | 透传 `target` |
| `targetName` | 透传 `targetName` |
| `deptid` | 透传 `deptid` |
| `deptFullPath` | 透传 `deptFullPath` |
| `workflow_id` | 固定 `"00000000-0000-0000-0000-000000000000"` |
| `current_stepid` | 透传 `current_stepid` |
| `current_step` | 透传 `current_step` |
| `need_human` | 固定 `false` |
| `next_node.name` | 固定 `"启动"`（待收公文选择流程启动时固定传此值） |
| `feedback.workflowFormId` | 步骤 3 获取的表单 ID |
| `feedback.workflowFormName` | 步骤 2 判断的工作流名（如 `"公司收文"`） |
| `feedback.direction` | 透传 `feedback.direction` |
| `feedback.feedBackIdea` | 根据公文标题与内容生成的简短办理意见 |
| `feedback.needIdea` | 透传 `feedback.needIdea` |
| `feedback.userId` | 透传 `target` |

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
  "linkid": "<linkid>",
  "target": "ptr\\exampleUser",
  "targetName": "张三",
  "deptid": "<deptid>",
  "deptFullPath": "某分公司-某部门",
  "workflow_id": "00000000-0000-0000-0000-000000000000",
  "current_stepid": "startReceiveWorkflow",
  "current_step": "待收公文",
  "need_human": false,
  "fail_reason": "",
  "next_node": {
    "name": "启动"
  },
  "feedback": {
    "workflowFormId": "<workflowFormId>",
    "workflowFormName": "公司收文",
    "direction": "发文到收文",
    "feedBackIdea": "请相关部门阅处",
    "needIdea": true,
    "userId": "ptr\\exampleUser"
  }
}
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `need_human` | 正常完成时为 `false`；仅当工作流无法判断、接口调用失败、回调失败等异常时才设为 `true` 并在 `fail_reason` 说明原因 |
| `fail_reason` | 正常为空字符串；异常时填简体中文原因 |
| `next_node` | 「待收公文」节点选择流程启动时，固定 `{"name": "启动"}` |
| `feedback.workflowFormName` | 即识别出的收文工作流名称（"公司收文" / "部门收文"），决定后续走哪条流程 |
| `feedback.feedBackIdea` | 办理意见；`feedback.needIdea` 为 `true` 时根据公文内容生成一句简短意见，否则可留空 |

## 注意事项

- 所有文本字段（`fail_reason`、`feedBackIdea` 等）必须使用简体中文
- 凡输入 JSON 中已有的同名字段，一律原样透传，不要改动值
- 文件下载前先检查本地是否已有该文件
- 如果文件无法下载、工作流无法判断或接口调用失败，将 `need_human` 设为 `true` 并在 `fail_reason` 中说明原因
- json 代码块之外不要输出任何其他内容
