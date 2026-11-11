# [3]办公室主任拟办意见生成任务

公文流转流程如下：文书账号启动公司收文 — 办公室主任账号拟办 — 文书账号操作 — 送领导批示 — 领导批示完毕，转承办部门 — 部门办结后，回到文书账号 — 办结。

你需要为一份待拟办的公文生成办公室拟办意见，包括：建议呈送的领导、建议承办的部门，以及一段规范的中文拟办意见文本。以下是请求信息：

```json
{{request.body}}
```

## 请求结构说明

- `linkid` / `target` / `deptid`：公文与处理人身份信息，需原样透传到结果
- `targetName` / `deptFullPath`：处理人姓名 / 部门完整路径，若输入提供则原样透传
- `workflow_id` / `current_stepid` / `current_step`：流程标识信息，需原样透传到结果（`workflow_id` 缺省固定为 `00000000-0000-0000-0000-000000000000`）
- `form_data`：表单元数据（标题 `title`、来文单位 `unitOfReceipt`、所属部门 `docDeptDisplayName`、紧急程度 `emergencyLevel`、办文时限 `timeLimitWriting` 等）
- `files`：公文附件数组，其中 `file_type = "main_body"` 的是正文
- `approval_history`：审批流转记录，其中 `stepName` 为 `"公司领导批示"` 的节点包含领导最终的批示意见（`flowOpinionList` 中各条目的 `content` 字段），这是生成拟办意见文本和确定承办部门的核心依据
- `next_nodes`：当前节点可选的下一流转节点
- `承办部门`：可选承办部门的树形组织结构，顶层为分类节点（`type: "分类"`），每个分类下的 `giveOrgModels` 数组中为具体部门；部门有 `id` 和 `text`（部门名称），建议承办的部门必须从此列表中选取

## 执行步骤

### 步骤 1：下载并读取公文正文

遍历 `files` 数组，用 curl 下载正文（`file_type = "main_body"`）到工作目录，并用文档解析服务提取纯文本（下载与解析方式见系统提示 `CLAUDE.md`）。若上下文中已有该文件文本，直接复用，无需重复下载。

### 步骤 2a：提取公司领导批示意见

从 `approval_history` 数组中找到 **`stepName` 为 `"公司领导批示"`** 的节点，读取其 `flowOpinionList` 中各条目的 `content` 字段内容。这是公司领导对本文的最终批示意见（通常包含"请某部门阅处/牵头/会同…"等指示），是生成拟办意见文本、选择承办部门的首要依据。

若 `approval_history` 中没有 `stepName` 为 `"公司领导批示"` 的节点，说明领导尚未批示，此时将 `need_human` 设为 `true`，`fail_reason` 注明「领导尚未批示，无法生成拟办意见」。

### 步骤 2b：从"承办部门"列表匹配部门

从输入 JSON 的 `"承办部门"` 节点的 `list` 中提取所有可用部门。该列表为树形结构：

- 顶层元素 `type` 为 `"分类"` 的，其具体部门在 `giveOrgModels` 数组中
- 顶层元素 `type` 为 `"部门"` 的，直接就是可选部门
- 每个部门条目含 `id`（部门 ID）和 `text`（部门名称）

根据公司领导批示中**点名提到的部门**（如"xx部""某某部""某某研究院"等），在 `"承办部门"` 列表中逐项匹配：

- 将批示中提到的部门简称与列表中部门的 `text` 做模糊匹配（如"xx部"匹配到 `text` 为"xx部"的条目）
- 输出每个匹配到部门的 `id` 和 `name`（`name` 取该条目 `text` 的值）

### 步骤 2c：生成拟办意见文本

综合以下信息生成 `opinion_text`：

1. 公司领导批示意见（步骤 2a 提取的内容）—— **核心依据**
2. 公文正文内容（步骤 1 获取）
3. `form_data` 关键字段（标题、来文单位、紧急程度、办文时限等）

拟办意见文本用规范的中文公文用语表述，形式如"请XX部门会同XX部门阅处"、"转XX部门承办落实"等，内容须**呼应并贯彻领导批示精神**，需符合机关公文拟办习惯。

### 步骤 3：执行结果回调

前置检查：若系统提示（`CLAUDE.md`）中**没有**「结果回调」章节，或环境变量 `${DP_CALLBACK_URL}` 为空，说明回调地址未配置。此时**立即停止**，严禁从数据库、源码、日志、配置文件或历史会话中查找/猜测回调地址；跳过回调步骤，并在输出 `JSON` 中把 `need_human` 设为 `true`、`fail_reason` 注明「结果回调未配置」。回调地址已配置时才继续执行下方回调。

重要参数：
- 当前任务 task_id: `{{task_id}}`
- 本次请求 `linkid`: `{{request.linkid}}`

在输出最终 `JSON` 之前，**必须**先执行结果回调。回调 payload 的 `data` 字段，就是下方「输出要求」中定义的 JSON 结果（步骤 2 构建完成后填入）。
回调的具体 curl 命令模板见系统提示（`CLAUDE.md`）中的「结果回调」章节，直接照做即可。
回调 payload 中的 task_id 和 linkid 必须使用上面给出的准确值。

回调成功（HTTP 2xx）后再输出下面的 `JSON`。回调失败重试最多 3 次（间隔 2/4/8 秒），
仍失败则在 `JSON` 的 `fail_reason` 中补充「结果回调失败：<错误信息>」并将 `need_human` 设为 `true`。

## 输出要求

请按以下 `JSON` Schema 输出最终结果，用 ```json 代码块包裹：

```json
{
  "linkid": "<linkid>",
  "target": "ptr\\exampleUser",
  "targetName": "张三",
  "deptid": "<deptid>",
  "deptFullPath": "某分公司-某部门",
  "workflow_id": "00000000-0000-0000-0000-000000000000",
  "current_stepid": "<current_stepid>",
  "current_step": "<current_step>",
  "need_human": false,
  "fail_reason": "",
  "opinion_text": "请某某部门会同某某部门、某某研究院阅处，落实好工作要求",
  "suggest_leaders": [],
  "suggest_departments": [
    { "name": "某部门", "id":"<部门ID>" },
    { "name": "某部门", "id":"<部门ID>" }
  ],
  "form_fill": {}
}
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `need_human` | 正常完成时为 `false`；仅当正文无法读取、无法判断领导或部门、回调失败等异常时才设为 `true` 并在 `fail_reason` 说明原因 |
| `fail_reason` | 正常为空字符串；异常时填简体中文原因 |
| `opinion_text` | 生成的拟办意见文本，规范的中文公文用语 |
| `suggest_leaders` | 建议呈送的领导列表；本任务领导已批示，正常完成时为空数组 `[]` |
| `suggest_departments` | 建议承办的部门列表（`name` 为部门名称，取自 `承办部门` 列表中的 `text`；`id` 为对应部门 ID）；无明确部门时可为空数组 |
| `form_fill` | 若拟办意见需要回填表单字段（如办理意见字段），填入对应的键值对；否则为 `{}` |

## 注意事项

- 所有文本字段（`fail_reason`、`opinion_text` 等）必须使用简体中文
- 凡输入 `JSON` 中已有的同名字段（`linkid`、`target`、`targetName`、`deptid`、`deptFullPath`、`workflow_id`、`current_stepid`、`current_step`），一律原样透传，不要改动值
- 拟办意见文本要符合机关公文习惯，简明扼要，避免口语化
- 拟办意见文本和承办部门必须依据 `approval_history` 中 `stepName` 为 `"公司领导批示"` 的批示意见生成，不得凭空猜测
- 承办部门的 `id` 和 `name` 必须来自输入 `JSON` 的 `承办部门` 列表，不得自行编造
- json 代码块之外不要输出任何其他内容
