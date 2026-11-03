# dp-agt — AI 数字员工（Claude Agent SDK 网关）

接收 JSON → 按 path 查找提示词模板 → 渲染提示词 → 异步调用 Claude Agent SDK → 回调结果。
系统本身不做业务逻辑，所有「智能」行为由 Claude 通过 Agent SDK 的 tool use 完成。

详细设计见 `DESIGN.md`、`README.md`；代码评审见 `CODE_REVIEW.md`。

## 敏感信息脱敏（必须遵守，最高优先级）

本仓库涉及真实的单位、人员和内部系统信息，**任何新增或修改的代码、提示词、示例数据、日志、注释中，都严禁出现真实信息**。

- **单位名称**：一律用占位符（如 `某公司`、`xx公司`、`某外部单位`、`某分公司-某部门`），不得写真实单位名、集团名、品牌名。
- **人名**：一律用占位符（如 `张三`、`李四`、`某处理人`），不得写真实姓名。
- **账号 / 域名前缀**：示例账号用虚构值，如 `exampleUser`；域名前缀用 `ptr` 之外的通用占位，不得暴露真实域前缀或 LDAP/AD 域名。
- **内部系统标识**：网关名、模型名、接口地址等内部命名（如 `api-gate`、`deepseek-v4-pro`、`oa-server:8080`）仅出现在配置或必要的内部说明中，示例和对外文档里用 `{{占位符}}` 或 `example.com` 代替。
- **Token / 密钥 / 密码**：只允许通过环境变量或 `prompt_config` 表（加密）引用，示例中只写 `$FILE_URL_TOKEN`、`$CALLBACK_TOKEN` 等变量名，绝不写死真实值。
- **日志输出**：打印配置、请求体时先脱敏（参考 `src/index.ts` 的 `mask()`），请求体、文档内容等可能含真实单位/人名的内容，落到日志前要确认或脱敏。

已存在仓库中的示例数据（`张三`、`某分公司-某部门`、`北京XX科技有限公司` 等）均已是脱敏占位符，修改时保持脱敏，不要替换成真实值。

## 项目结构

- `src/`：服务入口（`index.ts`）、配置（`config.ts`）、路由（`routes/`）、业务服务（`services/`）
- `prompts/`：提示词模板，目录结构即对外访问路径，无需重编译、热更新
  - `prompts/doc/*.md` → 访问路径 `doc/*`；`claude-md.md`、`sections/` 不作为访问路径
- `web/`：管理后台前端（Vanilla JS SPA）
- `data/`：运行时数据（SQLite + 任务工作目录，含 `secrets.key`，勿提交）
- `build/`、`deploy/`：Docker 构建与部署

## 开发约定

- TypeScript，Node.js ≥22；构建 `npm run build`，本地热更 `npm run dev`。
- 提示词占位符语法：业务模板用 `{{request.xxx}}`，CLAUDE.md 用 `{{key}}`（来自 CSV 配置），条件段落用 `{{section:片段名:key}}`。
- `prompts/` 下的 `.md` 修改后下一个新任务立即生效，无需重启；session 复用的任务不会重新读取 CLAUDE.md。
- 所有面向业务的文本（`fail_reason`、`opinion_text`、`result_text` 等）要求简体中文。

## Git 注意

- 不要提交 `data/` 下的运行时数据、`secrets.key`、证书、`node_modules`、构建产物（见 `.gitignore`）。
- 提交/推送前确认改动未引入真实单位名、人名、Token 等敏感信息。
