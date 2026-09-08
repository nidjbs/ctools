# plan 模式（规划 → 批准 → 执行）— 行为契约

> 目标：让 agent 处理较复杂任务时先产出可执行计划、经用户批准后才动手（类 Claude Code plan mode）。用户可在 **直接 / 规划** 两种模式间主动切换。

## 触发

- **模式开关**：两处同源一个 直接/规划 分段开关（绑定 `ChatManager.mode`，Main 是唯一事实源）——Chat 顶栏**常驻**；Launcher 当输入**将进 agent**（自由内容 / agent 模板）时**按需浮现**（quick 命令、`#命令型模板` 参数态、settings 不显示）。切换即时生效、经 `session:mode` 广播两窗同步；持久于本次 app 运行（重启回 `normal`）。
- **plan 模式下的每次 agent send**（Chat 内回车；Launcher 自由内容回车按当前模式直发）都是一次**受控任务**：规划 pass → 待批准 → （可选）执行 pass。**冷启动首条可规划**：Launcher 输入自由内容 → chip 浮现 → 切 规划 → 回车即进规划 pass。普通消息/闲聊请用 直接 模式。
- quick 命令、`#模板` 中的命令型、Settings 等**不受**模式影响，仅 agent 对话流受控。

## 模式与事件模型

```ts
type AgentMode = 'normal' | 'plan'   // UI：直接 / 规划
```

- 模式是 **runtime 状态，不入会话事件**；一次对话处于哪种模式可由 `plan.*` 事件推导。
- 会话新增 role-less 事件（**不进模型上下文投影** `Session.messages()`，只作审计 + UI 状态源）：
  - `plan.propose`：规划 pass 结束、产出计划文本（`content` = 计划；`seq` 用于 pendingPlan）。
  - `plan.approved`：用户批准（`content` = 对应计划文本，便于回看）。
  - `plan.rejected`：用户放弃/拒绝重规划（`content` = 反馈文本；空 = 放弃）。

### 一次 plan 任务的时序（事件流 = 审计真相）

```
user.message
→ [规划 pass] agent 以 只读工具集 + 规划指令 运行（可多轮只读调研）
→ assistant.message（= 计划文本；无工具调用即天然结束点）
→ plan.propose（content=计划）            ← Main 进入「待批准」（running=false）
  用户操作其一：
   ├ 批准执行 → plan.approved
   │   → [执行 pass] agent 以 全量工具集 + 「已批准，按此计划执行」运行
   │       （执行中 bash/破坏性写删仍逐条 confirm）
   ├ 反馈 + 重规划 → plan.rejected（content=反馈）→ 重新跑一轮规划 pass（不新增 user.message）
   └ 放弃 → plan.rejected（content=空），回到待输入
```

- 待批准是**状态**而非角色事件：`pendingPlan = 最近一条 plan.propose 且其后无 plan.approved/plan.rejected`。晚挂载的 Chat 经 `session.pendingPlan()` 拉取恢复面板（复刻 confirm 的 pendingConfirm 模式）。

## 工具与指令策略

- 新增 `CommandMeta.planSafe?: boolean`（默认 false）。`Registry.planTools()` = 启用 && agentTool && planSafe。
- **规划 pass 只读工具集**（v1）：`file_read / file_list / find_file / office_read` → `planSafe: true`。`bash / file_write / file_rm / web_search / clipboard` **不进**规划工具集（web_search 涉及网络、须开关+批准，v1 排除；后续可放宽）。
- 工具集、规划/执行协议指令、轮数上限都是**每个 pass 派生注入**的，不持久化（副作用清零原则：只持久化用户事实 user.message/plan.*）。
  - `runAgentTurn` 抽"不 seed user.message 的多轮循环"，并接受 `opts { tools?, promptExtra?, maxTurns? }`：规划/执行/重规划 pass 共用，每轮模型请求都带上本次的工具集与 promptExtra。
  - 规划 pass：seed user.message + `tools=planTools()` + 规划指令 + `maxTurns=PLAN_MAX_TURNS(12)`；计划须为「首行 `摘要：…` + 编号步骤列表（每行 `1.` `2.` …）」——摘要供卡片头部、编号供逐条打勾与执行标记对齐。**步骤数 4-6**：prompt 明示「控制在 4-6 个、最多 6」，杜绝十几步流水账。**结构兜底**：产出后步数落在 `[2,6]` 之外（整段描述或超长列表）时，以 `tools=[]` 单轮改写收敛为 4-6 个编号步骤（解析在 `[2,6]` 才采用，否则保留原文）。
  - 执行 pass：不 seed user.message；先落 `plan.approved`，再 `promptExtra` = 「用户已批准以下计划，请按计划执行：\n<plan>」+ **执行协议**（每一步开始时先输出一行 `第 N 步：…`，N 对应计划步骤编号，再做该步操作），`tools=registry.toolIds()`，轮数同普通。UI 解析 `第 N 步` 标记逐条打勾。
  - 重规划 pass：落 `plan.rejected(feedback)` 后，不 seed user.message，`promptExtra` 追加「用户要求调整：<feedback>，请据此重出计划」。
- 规划 pass 内模型幻觉出非规划工具 → 复用白名单兜底（不执行，返回错误文本）。

## 输入 / 输出（IPC / UI）

新增到 `CtoolsApi.session` 与 preload：

- `mode(): Promise<AgentMode>` / `setMode(m): Promise<AgentMode>`：读/改 `ChatManager.mode`；Main 改后向 Chat/Launcher 两窗广播 `session:mode`。
- `executePlan(): Promise<void>`：存在待批准计划且未在运行 → 执行 pass；否则抛错。
- `replan(feedback?: string): Promise<void>`：同上前提 → 记 `plan.rejected`（content=feedback，可为空=按原方向重规划）并重跑规划 pass。
- `discardPlan(): Promise<void>`：同上前提 → 记 `plan.rejected`（content 空，即放弃）并回到待输入，不重跑。
- `pendingPlan(): Promise<{ seq: number; text: string } | null>`。
- 新增订阅 `onMode(cb)`；`onSessionEvent` 已覆盖 `plan.*` 推送（驱动 Chat 面板显隐 + transcript 重建）。

**UI 行为**：
- **计划卡（Claude Code 风格）**：`plan.propose` 起在当前 user 气泡下**内联插入计划卡**（随流走，不置顶），默认**展开可见编号步骤**。头部 = `📋 第 N 版 · 摘要` + 状态；正文 = 步骤列表（编号 + 标题，逐条状态图标）；有摘要/步骤外的多余段落才提供「查看原文」折叠。`pending` 态含反馈输入框 + `[批准并执行]/[按反馈重新规划]/[放弃]`；`exec` 态操作区消失。新 `user.message`/放弃后卡片收起，其计划文本**沉回历史气泡**；卡片激活期仅隐藏**当前段**计划文本气泡（`planTextSeqs` 段内生效），更早完成任务的计划文本照常以气泡保留。
- **版本序号**：UI 按 `user.message` 段内 `plan.propose` 序数派生第 N 版（重规划 → 第 2 版…），不落盘、不改事件。
- **执行进度逐条打勾**：批准后卡片步骤原地 tick，由已批准后 assistant 文本中的 `第 N 步` 标记推进（`stepStates`：`done ✓ / active ▶ / todo ○`）；解析不到标记只显示「执行中…」不误报。正常收尾（running=false 且无 `agent.error`）→ 全部 ✓ +「已完成」；中断 → 头部「✗ 执行中断」。纯文本计划（解析不到 ≥2 编号步骤）不假装打勾，整块展示原文。
- 计划卡与工具 confirm 弹层互斥；执行 pass 中途的逐条 confirm 照常弹出。
- Chat/Launcher 的模式 chip 经 `onSessionMode` 与 Main 同源（Launcher 按需浮现）。

## 边界与失败

- 待批准期间 running=false：用户可发新消息（**取代**当前待批准计划，先清 pendingPlan）或切回 直接 模式直接聊天。
- 运行中（running=true）调 `setMode`：不打断当前 pass，**下一轮生效**；`executePlan/replan` 若已在运行 → 抛"上一轮仍在运行"。
- 规划 pass 可取消（`session.cancel`/停止按钮）：取消则不产生 `plan.propose`，pendingPlan 保持原状/无。
- 规划 pass 未产出非空计划文本（含被取消、纯空）→ 不产生 `plan.propose`，记 `agent.error` 提示。
- 规划/执行 pass 超轮数上限 → 现有 MAX_TURNS 语义（返回已得内容，不回滚）。
- 直接/规划互切发生在 pass 之间时：新 pass 以新模式跑；旧待批准计划若仍在则被新 send 取代。
- 被重规划/放弃的旧计划气泡**保留**在 transcript（事件溯源即审计，不做隐藏改写）。

## 安全约束

- **批准≠免审**：执行 pass 中 bash / 破坏性写删仍必须逐条 confirm（不削弱 AGENTS.md「写操作必须经 confirm」不变量；计划批准只是粗粒度放行）。
- 规划 pass 只读：无写/删/网络工具进入规划工具集；写权只在用户批准后的执行 pass 内、且仍受 confirm 闸门。
- 事件落盘无损：模式虽不入事件，但计划/批准/拒绝均以 `plan.*` 落盘，可完整回看决策链。
- 无新增远端模型/网络路径；文件读取照旧受 file_roots 与既有开关约束。

## 测试（编码本 spec）

- 单测 `tests/plan.test.ts`（或并入现有文件）：
  - `Registry.planTools()` 只含 planSafe 且启用的工具；写/删/bash/web_search 不在内。
  - `runAgentTurn` 的 `opts.tools / promptExtra / maxTurns`：注入只读工具集（发往 mock 的请求 tools 仅 planSafe）；promptExtra 出现在每次请求 messages 的系统首条；seed 语义（seed 有 user.message、不 seed 则无）。
  - ChatManager 模式分发：mode=plan 走规划 pass，mode=normal 维持现状。
- 运行时 e2e（`tests/e2e.test.ts` mock gateway HTTP，按 `messages`/`tools` 分流）：
  - 全链路：plan 模式 send → mock 先放只读工具调用（规划调研）→ 产出计划文本 → 断言 `plan.propose` + `pendingPlan` 就绪（无 approved/rejected）→ `executePlan` → 事件序含 `plan.approved` + 执行 pass 工具调用（全量工具）→ `plan.*` 事件 role-less、不进消息投影。
  - 拒绝+带反馈重规划：`replan('太粗')` → `plan.rejected(content='太粗')` → 新规划轮（请求带"请据此调整"）→ 再次 `plan.propose`。
  - 纯文本计划也 gate：模型无工具直接回答 → 仍产生 `plan.propose` 进入待批准。
  - 新 send 取代待批准计划。
- UI e2e（`tests/ui/plan.spec.ts`）：Launcher 自由内容浮现 chip → 切 规划 → 冷启动首条即规划；计划卡默认展开步骤、批准后逐条打勾、replan 版本递增、放弃后卡片收起且计划文本沉回历史气泡。
- 改动跨 shared types / agent loop / ChatManager / IPC / 两窗 UI → 回归跑 `npm run typecheck && npm test && npm run build && npx playwright test tests/ui/`。
