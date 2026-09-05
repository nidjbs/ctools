# bash 命令执行 — 行为契约

## 触发

- Launcher：`bash <shell 命令>`（alias：run / sh / shell / 执行）。`bash` 之后的内容原样作为命令。
- Agent：`bash` 是 agentTool，agent 可发起执行；**但每次执行前都要用户批准**（见下）。

## 安全（最高优先，人工在环）

- **每次执行必确认**：忽略 `writeConfirm`（never 也不放行）。未带 `ctx.confirmApproved` → 返回 `{type:'confirm'}`。
- Launcher 路径：`commands:confirm` IPC（确认按钮）放行。
- Agent 路径：分发层遇到 confirm → 调 `onConfirm(tool,message)`（Chat 内弹 批准/拒绝）；
  - 批准 → 以 `confirmApproved` 重放执行；
  - 拒绝/超时 → 工具结果为 `用户未批准：…`，不执行。
- cwd = `file_roots[0]`（未配置则用户 home）。
- 超时 30s，超时即 kill；非交互（无 tty）。
- 输出（stdout+stderr）与退出码回显，输出截断（上限约 8KB 并标注）。

## 输入 / 输出

- 空参数 → `用法: bash <命令>`。
- 成功 → `退出码 0` + stdout；非零 → 含 stderr 与退出码。
- 命令不存在/超时 → 带原因错误文本。

## 已知边界

- 不校验命令本身危险度——执行权就是本机一切权限，靠「必须人工批准 + 本地仅入口」兜底。
- 不做白名单/黑名单（可绕过，不构成安全边界）。
