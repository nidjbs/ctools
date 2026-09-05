# Agent 工具白名单 — 行为契约

## 规则

- agent 能调用的工具 = `registry.toolIds()` = **enabled 且 `agentTool: true`** 的命令。
- **file 全套（读/列/写/删）都声明 `agentTool`**，让 agent 能处理文件任务。
- **安全闸门在命令层而非白名单层**：
  - 只读（read/list/office_read/clipboard 不涉及）直接执行。
  - **写/删命令的破坏性操作（覆盖已存在 / 删除）恒需 `ctx.confirmApproved`**——该标记仅 `commands:confirm` IPC 设置。
  - agent 分发调用走**普通 ctx（无 confirmApproved）** → 破坏性写/删返回 `{type:'confirm'}` → 分发层 `onConfirm` **在 Chat 内弹批准**；批准 → 以 `confirmApproved` 重放执行；拒绝/超时 → 不落盘并记 `用户未批准`。
  - `writeConfirm=auto` 下新建/追加 agent 可直接执行（file_roots 内、tool 气泡可见可复制、事件可追溯）；`always` 下一切写都拦。
- **分发层兜底**：agent 每轮只执行 `allowed = toolIds()` 内工具；模型幻觉出未提供的名字 → 返回 `错误: 工具 X 不在 agent 白名单`，绝不执行。
- 越界路径（不在 file_roots）一律拒绝。

## 校验测试（编码进 registry/file 测试）

- `toolIds()` 含 `file_read` / `file_list` / `file_write` / `file_rm`。
- 破坏性写/删在普通 ctx（无 `confirmApproved`）下只返回 `{type:'confirm'}`，磁盘不变；
  仅 `confirmApproved:true` 的 ctx 才实际落盘。
