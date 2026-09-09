# agent 运行态：最大轮次 + 思考/工具 loading — 行为契约

> 2026-09。让 agent 干活时不至于静默空转/无限循环：给上限，且每阶段都有可见状态。

## 触发

- Chat 每次 send（normal/plan 执行）进入 agent 循环期间，UI 展示运行状态。
- 主进程 agent 循环每轮模型请求都有轮次计数。

## 最大轮次

- agent 循环默认上限 `MAX_TURNS = 50`（`src/main/agent.ts`）——单次用户输入内的模型请求轮数；超限停止本轮并返回空串。
- plan 规划 pass 保持 `PLAN_MAX_TURNS = 12`；改写 pass `maxTurns = 1`（chat.ts）。
- 用户仍可随时「停止」（abort），上限只是防 runaway 的最后闸。

## Chat 运行 loading（纯渲染，Chat.tsx）

- `running=true` 时显示「运行气泡」，头部 = spinner + 阶段文案：
  - 无正文且无正在执行工具 → `思考中…`
  - transcript 尾部为**未配对 tool.call**（其后尚无 tool.result）→ `正在执行 <tool>…`
  - 已有流式正文 → `生成中…`（正文实时渲染）
- 推理内容（`reasoning_content`）**不流式上屏**——思考阶段只有动画 + 文案，避免长推理刷屏、中间分析外泄。
- 工具过程组块（specs/tool-visible.md）在运行中对「当前执行调用」标 live（⏳ + 脉冲色），折叠态头部也带小 spinner。

## 边界与失败

- 工具执行中（等 tool.result）与模型生成中（等正文）都归 `running`；二者由 transcript 尾部事件区分，无事件期间一律视为「思考中」。
- 人工批准等待（onConfirm）期间 running 仍为 true（显示思考中 + 批准框），不新增专用态。
- 计划卡批准/重规划期间不显示运行气泡（非 running）。

## 可测性

- 单测：`shellSandbox/pathGuard` 无涉；轮次上限是常量（agent.test 覆盖无工具即返）。
- UI e2e：断言运行气泡阶段文案/`⏳ 正在执行`（在既有 chat 流式 e2e 内顺带断言）。
