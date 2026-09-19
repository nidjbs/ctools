# Settings 设置窗 — 行为契约

## 触发

- Launcher 输入框输入 `settings` / `设置` / `config`（无命令命中时）回车 → 打开设置窗，Launcher 让位。
- 设置窗为独立带框窗口，路由 `#/settings`；关闭设置窗 → 回到 Launcher。
- 也可由命令注册的 `window.openSettings` IPC 打开。

## 分区与输入 / 输出

### 1. Gateway 状态卡
- 状态：探测 `{adminUrl}/readyz` → 显示 `运行中` / `已停止`（含探测失败时的 `lastError`）。
- 按钮：`热更新` = POST `{adminUrl}/admin/reload`（Bearer adminToken）；`重启` = down + `gw up` 并等 ready。结果以内联文字反馈（成功 / 失败原因）。
- 开关：`启动时自动托管 gateway`（`config.managedGateway`，默认 false）。开启且当前停止时立即 `ensureStarted()`。

### 2. 模型分配（主字段）
- `defaultAlias`：默认模型别名（agent 对话、上下文摘要、`/save` 蒸馏等未单独指定的场景都用它）。
- **各场景模型**：`config.commandModels[<命令 id>]` —— 固定场景可各用各的模型，与默认模型解耦。
  - 当前暴露：`trans`（翻译）→ `commandModels.trans`。
  - 取值规则（`shared/model.ts` 的 `resolveModel`）：`commandModels[id]` 非空则用它，否则回退 `defaultAlias`。
  - 为空串 / 未设置 → 回退默认，**不报错**（用户只想改默认模型时不必逐个填）。
- `clipboardLocalAlias`：剪贴板语义召回专用（**隐私语义独立**，不复用 `commandModels`）——留空则回退默认模型，UI 须标注「不推荐」。
- 所有别名字段用 datalist 提示 `/v1/models` 返回的真实别名。

### 3. 连接（高级，默认折叠）
- `gatewayUrl` / `adminUrl` / `adminToken`。
- **默认值即正确值**（`127.0.0.1:8080` / `127.0.0.1:8081`），**不作为主字段推荐修改**：这三点是本地网关的固定入口，误改会导致「命令/对话全不可用」且难以自查。故收纳在折叠区内，并注明「通常无需修改」。
- 仍然可编辑——托管外部网关或换端口时有用。

### 4. 偏好
- `hotkey`（Electron accelerator 字符串）、`fileRoots`（每行一个路径）、`writeConfirm`（auto/always/never 下拉）。

### 5. 命令启停
- 列出注册表全部命令（含已禁用）：每行 `id · title · [agentTool 徽标]` + checkbox。
- 切换 checkbox 立即持久化 `config.enabledCommands` 并使 Launcher 联想 / agent 工具即刻反映：
  - 禁用后 `match` / `list` / `recent` / `toolIds` 不再返回该命令；`run` 抛 `command disabled: <id>`。

## 边界与失败

- gateway 不可达：状态卡 `已停止`，热更新/重启返回失败文案；其余表单仍可编辑保存。
- `hotkey` 非法/为空：保存不崩溃，主进程跳过注册（记录 warn）。
- `fileRoots` 空 / 不存在目录：接受（运行时命令按自身逻辑报错）。
- 命令默认 enabled 与 config 覆盖：config 未列出的命令保持自身默认；覆盖存在则以 config 为准。

## 安全约束

- `adminToken` 输入以 password 框呈现；仍存本地 userData config.json（与现有一致）。
- 无新网络路径；reload/restart 仅作用于本地 gateway。
- 命令启停只影响「可见/可执行」；不修改命令代码。
