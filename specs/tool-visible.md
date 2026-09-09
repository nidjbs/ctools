# agent 工具过程可见（tool visibility）

状态：定稿（2026-09）。范围：P0「agent 调工具过程可见」——把 transcript 里已有的 `tool.call / tool.result` 从黑盒变成紧凑工具行。

## 目标 / 用户视角

agent 干活时，对话流里能看到「正在调用哪些工具、调得怎样、结果多长可一键复制」——不再只等一句总结。

## 数据来源

`src/main/agent.ts` 已在事件流推送全部 `tool.call` / `tool.result`，渲染层此前丢弃（Chat.tsx `toBubble` 对 tool.call 返回 null）。**主进程零改动**。

## 行为契约

### T1 工具过程组块（默认收起）

- **相邻的 `tool.call` / `tool.result` 事件折叠成一个可展开的组块**（遇非工具事件分隔，即 user.message / assistant.message / plan.* / agent.error）。
- 组块未展开显示一行：`▸ 🔧 <工具名…> · N 次调用`（工具名去重，`·` 空格分隔；N = 组内 call 计数）。点击可展开。
- 展开后逐条显示：
  - `tool.call` → `🔧 <tool_name>`，参数 JSON 非空时附参数首行（截 120 字）。
  - `tool.result` → `✓ <tool_name> · <摘要>`；摘要 = `toolResultSummary(content)`（≤200 字原文，>200 → 首行 + `…(共 N 字)`）；行尾拖「复制全文」＝复制**全文**。
- 默认收起，运行与回放统一（避免恢复历史会话时整段执行过程刷屏）。运行中的调用会累进该组块（N 递增），用户可随时点开看细节。

### T2 展示与文本分层

- 超大 tool.result（如整文件 read）**绝不整段铺屏**——展开态每条仍只显示摘要行 + 复制全文，全文不默认铺开。
- 工具组块不承载"模型可见消息"语义：不进 ChatManager 对话轮次，纯 UI 展示。

### T3 纯函数集中

- `src/shared/chatModel.ts` 导出 `toolRowOf(ev)` 与 `toolResultSummary(content)`，renderer 与单测共用；摘要/截断/参数预览逻辑不进组件。

## 安全 / 边界

- 参数 JSON 可能含敏感内容：只做**首行预览**，完整参数只经复制，不强制落库之外再显示长内容。
- tool.result 可能巨大：摘要截断是硬上限，不因长文卡渲染。

## 失败语义

- result 内容非字符串 / 空 → 摘要显示 `(空)`。
- tool.call 无配套 result（中断/失败）→ 该调用行保持「进行中」样式。

## 可测性

- 单测：`toolResultSummary` 长短截断 / 空值；`toolRowOf` 参数预览截断。
- UI e2e：mock agent 首轮调 `file_rm`（现成 behavior）→ 断言出现 `🔧 file_rm` 工具行与 `✓ file_rm` 摘要行。
