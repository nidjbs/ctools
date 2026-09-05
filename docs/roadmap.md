# cTools 后续计划

> 主框架与核心流程已贯通（Launcher 快捷命令 + agent Chat 对话流）。本文为下一步计划，按依赖排序。

## 已完成（主流程跑通）

- CommandRegistry（命令即插件）+ 悬浮 Launcher（前缀联想 / 最近常用 MRU）
- quick 命令（trans / find_file）inline 快结果
- **agent 对话流**：自由内容回车 → Chat 窗口 → gateway 流式（SSE）→ 会话事件（事件溯源）→ 工具调用分发到 `agentTool` 命令 → 可取消
- runtime：gatewayClient（流式+abort）/ session（lean 事件溯源）/ agent loop / usage
- **Chat 交互修复**：agent 进入时 Launcher 让位、Chat 窗聚焦；Chat 渲染改为 transcript 唯一事实源 + 流式 draft 气泡；agent 运行错误落 `agent.error` 事件（晚挂载也可见）
- **会话持久化（#7）**：`Session.fromJSONL` 重放重建 + `latestSessionId` 保留（供将来显式续聊）；**默认每次打开即新会话**（不自动续上次）
- **Chat markdown + 复制**：气泡渲染轻量 markdown（标题/列表/引用/代码块，无 innerHTML 无注入面），每条气泡与代码块一键复制
- **窗口打磨（#2）**：Launcher 失焦收起（生产）/ 每次唤起即清空聚焦（`launcher:show`）/ Chat 关闭回 Launcher
- **gateway 管理（#3）**：GatewayManager 探测 / `gw up` 拉起 / down / reload（admin HTTP）/ restart（依赖注入可单测）；启动 auto-start 受 `managedGateway` 开关控制（默认关，避免误拉外部进程）
- **UI e2e**：Playwright 驱动真实 Electron + mock gateway（`tests/ui/`），覆盖启动/联想、quick+MRU、Chat 流式、gateway 不可达优雅失败、Settings
- **Settings UI（#4）**：`settings` 触发开窗；gateway 状态/热更新/重启/托管开关、网络与别名表单（datalist 提示真实别名）、偏好（hotkey/file_roots/writeConfirm）、命令启停即刻生效；`config:update` 统一副作用（registry.syncEnabled + 热键重绑 + ctx 原地合并）
- **Registry 启停覆盖**：`config.enabledCommands` 驱动 match/list/recent/toolIds/run，不改命令模块单例（specs/settings.md）
- **file 只读工具（Phase 1，#5 起步）**：`file_read` / `file_list`，`shared/filePolicy` file_roots 强校验（含 `..` 穿越拒绝），无写/删入口；agentTool 可被 agent 调用（specs/file-tools.md）
- **file 写/删 + 通用两段 confirm（#5/#8）**：`file_write` / `file_rm`，`needConfirm` 策略（never/always/auto→删除与覆盖已存在才确认）；Launcher 展示确认面板 → `commands.confirm` 带 `confirmApproved` 重放；命令非 agentTool（specs/file-tools.md Phase 2）
- **agent 工具白名单（#8）**：agent 只执行 `toolIds()` 内工具；分发层对幻觉出的非白名单工具一律拒绝不执行。file 全套（read/list/write/rm）开放给 agent；破坏性写/删仍被 confirm 闸门拦截（agent 无 `confirmApproved` → 只返回确认、不落盘）（specs/agent-whitelist.md）
- **上下文压缩（#6 TS 移植）**：`main/context.ts`——大 `tool.result` 无条件裁剪（head+tail，原事件保留审计）+ surface 计数 > high 时 shadow 最旧非 system 消息到 low；agent 每次模型请求前调用（specs/context.md）
- **clipboard 本地召回（#5）**：`ClipboardStore`（append-only jsonl + 可注入 watcher）+ `clipboard` 命令（历史列表 / `clipboard <q>` 语义召回仅走 `clipboardLocalAlias` 本地模型，agentTool=false，specs/clipboard.md）
- **office_read（#5）**：txt 系直读 + docx/xlsx（jszip 解包提文本）+ pdf（pdfjs-dist，best-effort）；只读 agentTool，file_roots 限定（specs/office-read.md）
- **bash 命令执行（人工在环）**：`bash <cmd>`（agentTool，agent 可发起）——每次执行经 Chat 内 批准/拒绝 或 Launcher confirm；批准才真正执行（cwd=file_roots[0]，超时 30s，退出码+输出回显）；拒绝/超时记 `用户未批准`（specs/bash.md）
- **agent 人工在环（onConfirm）**：工具返回 confirm → agent 循环暂停 → Chat 弹批准 → 批准后以 confirmApproved 重放（覆盖 bash 与 file_write/file_rm 破坏性操作）
- 测试：单测 99 + UI e2e 11 全绿；typecheck + build 全绿

## 待办（建议顺序）

| # | 项 | 说明 | 依赖 |
|---|---|---|---|
| 1 | **真机端到端验证** | 用户 `npm run dev`：Launcher 快捷命令 + 自由内容→Chat 流式；配 gateway 别名（`config.json` defaultAlias=common 或 gateway 加 chat alias） | 本机 |
| 2 | **全局热键 + 窗口管理** | `globalShortcut` 唤起/隐藏 Launcher、失焦收起、Esc 隐藏 | — |
| 3 | **gateway 管理落地（architecture §6）** | Settings 编辑受管 gateway 配置 → `reload`(POST /admin/reload) / `restart`；auto-start 用受管配置 | 2 |
| 4 | **Settings UI** | 命令启停/热键/gateway URL/本地 alias/file_roots/write_confirm；config 改动 → 热重建 runtime | 2,3 |
| 5 | **命令迁移（带安全约束）** | clipboard recall（本地模型 alias，远端不碰）、file 工具（file_roots + confirm）、office_read 等 | 4 |
| 6 | **上下文压缩（TS 移植 context.go）** | 长会话 compaction（head+tail 裁剪 / shadow） | agent 会话稳定后 |
| 7 | **会话持久化 / resume** | session JSONL 重放、续聊 | — |
| 8 | **安全强化** | agent 可调工具白名单；写/删除类命令默认不经 agent 直跑，走 quick+confirm | 5 |

## 结构性待验证项

- Chat 窗口多轮（连续 send）串行是否正确、取消是否干净。
- gatewayClient SSE 的 tool_calls 分片累积（多工具并行 index）。
- 自由内容路由的歧义（有命令前缀但意图是对话时如何处理）。
