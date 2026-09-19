# ask（agent 向用户澄清）— 行为契约

## 目标

现在 agent 遇到歧义只能**猜**或返回一段话——多轮任务容易跑偏。`ask` 给它一个**打断并提问**的通道：模型主动问，用户答，答案作为工具结果回填，任务继续。

## 触发

- Agent：`agentTool: true`（**不** planSafe —— 提问有交互副作用）。
- Launcher：`ask <问题>` → 返回同样的 ask 结果，但 Launcher 只**展示**问题文本（Launcher 无对话上下文可回填）。

## 输入 / 输出

```ts
// 输入
{ question: string; options?: string[] }

// 输出（新增 CommandResult 变体）
{ type: 'ask'; question: string; options?: string[] }
```

- `options` 给定时，UI 渲染为**可点按钮**（但仍允许自由输入）。

## 人工在环流程（与 confirm 同构）

1. `agentLoop` 分发工具时遇到 `r.type === 'ask'` → 调用 `cb.onAsk(question, options)`。
2. 主进程 `askQuestion(win, …)`：持有 pending resolver，向 Chat 窗口推 `tool:ask`，**超时 5 分钟**默认 resolve `（用户未回答）`。
3. Chat 渲染提问条（问题 + 可选按钮 + 输入框）；用户提交 → IPC `tool:answer`(id, text)。
4. 答案作为该工具的 `tool.result` 内容回填会话，模型继续。

- 一次只有一个待答问题（同 confirm 的 `currentConfirm` 单槽语义）。
- 用户不答而取消/超时 → 返回 `（用户未回答）`，模型据此自行决定（通常应停下或给默认方案），**不阻塞**。
- **关窗立即作废**：Chat 窗口关闭时，未决提问**立刻**按 `（用户未回答）` 结算（不等 300s 超时），
  并中止当前轮——见 `session-resume.md` C5。否则提问悬空期间 `running` 恒为 true，后续 attach 会失败。

## 边界与失败

- `question` 为空 → 返回 `text`：`用法: ask <问题>`，不进入提问流程。
- Chat 窗口不存在（异常状态）→ 立即 resolve `（用户未回答）`，不挂死。
- 用户提交空串 → 视同 `（用户未回答）`。

## 安全约束

- 只读：不触碰文件/网络。
- 答案文本进入会话事件流（审计无损），与 user.message 同等对待——**不额外注入 system，不绕过任何既有闸门**。
