# bash 命令执行 — 行为契约

## 触发

- Launcher：`bash <shell 命令>`（alias：run / sh / shell / 执行）。`bash` 之后的内容原样作为命令。
- Agent：`bash` 是 agentTool，agent 可发起执行；**但每次执行前都要用户批准**（见下）。

## 安全（最高优先，人工在环 + OS 禁网）

- **每次执行必确认**：忽略 `writeConfirm`（never 也不放行）。未带 `ctx.confirmApproved` → 返回 `{type:'confirm'}`。
- Launcher 路径：`commands:confirm` IPC（确认按钮）放行。
- Agent 路径：分发层遇到 confirm → 调 `onConfirm(tool,message)`（Chat 内弹 批准/拒绝）；
  - 批准 → 以 `confirmApproved` 重放执行；
  - 拒绝/超时 → 工具结果为 `用户未批准：…`，不执行。
- cwd = `file_roots[0]`（未配置则用户 home）。
- **网络沙箱（2026-09 起）**：默认 `bashNetwork=false` → 命令经 `sandbox-exec` 套 Seatbelt `(deny network*)` 执行，**OS 级禁网**（`src/main/shellSandbox.ts`）。`bashNetwork=true`（Settings 开关）→ 放行联网（普通 `/bin/sh -c`）。
- 禁网但 `sandbox-exec` 不可用/应用失败 → **拒绝执行**并给明确错误（提示开启「bash 联网」），绝不静默降级成无沙箱执行。
- 超时 30s，超时即 kill；非交互（无 tty）。
- 输出（stdout+stderr）与退出码回显，输出截断（上限约 8KB 并标注）。

## 输入 / 输出

- 空参数 → `用法: bash <命令>`。
- 成功 → `退出码 0` + stdout；非零 → 含 stderr 与退出码。
- 命令不存在/超时 → 带原因错误文本。

## 已知边界

- 不校验命令本身危险度——文件系统读写权等于本机（仍受 file_roots 词法约束之外的用户权限），靠「必须人工批准」兜底。
- 禁网是唯一 OS 层约束；DNS/出网在 `bashNetwork=true` 时放开。文件写不额外限制（bash 本就人工确认）。
