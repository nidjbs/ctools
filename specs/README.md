# cTools Specs（SDD）

新功能按 SDD 推进：**spec → 测试 → 实现**。

## 流程

1. `specs/<feature>.md`：写清行为契约——触发、输入/输出、边界、失败语义、安全约束（远端模型不可信、file_roots、无外传等）。
2. 写测试编码该 spec：先单测（模块级），需要跨模块/跨网络时用运行时 e2e（`tests/e2e.test.ts`，mock gateway HTTP）。
3. 实现到全绿。行为变化必须先改 spec。

## 模板要点

```md
# <feature> — 行为契约

## 触发
（用户在哪个入口触发：命令 / agent 工具 / 会话内）

## 输入 / 输出
（参数、返回类型；失败时如何表现）

## 边界与失败
（空输入、未配置、gateway 不可达、取消…）

## 安全约束
（涉及文件/剪贴板/网络时的要求）
```

## e2e 定位

`tests/e2e.test.ts` 覆盖**运行时主流程**（quick 命令 + agent 对话），跑在 node（vitest），不依赖 Electron GUI——用真实 `GatewayClient` 对 mock gateway HTTP 服务，贯通 registry / agent / session / 工具分发。GUI 层 e2e（窗口/交互）留待后续 + 真机验证。
