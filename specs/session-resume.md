# 会话回看与续聊（session resume）

状态：定稿（2026-09）。范围：P0「会话回看/续聊」——把「关窗即丢、只能开新」改为可显式回到任意历史会话。

## 目标 / 用户视角

- Launcher 空输入首页顶部展示**最近会话**横排，点击某条 → 打开 Chat 并载入该会话（可继续对话）。
- Chat 顶栏提供「＋ 新会话」，随时另起干净会话。
- 不改变「应用冷启动首次自由输入 = 新会话」的既有取舍；不自动续上次。
- 会话事件流本就按 JSONL 无损落盘，回看即重放。

## 行为契约

### C1 列出最近会话

- `session:recent` 返回 `SessionSummary[]`（`{ id, title, updatedAt }`），按 `updatedAt` **降序**，最多 5 条。
- `title` = 会话首条 `user.message` 去空白后截 **28** 字（不足取全文；空则 `（空会话）`）。
- `updatedAt` = 会话 JSONL 文件 mtime（ISO）。
- 空目录 / 无 user.message 的历史 → 不崩，正常返回。

### C2 续聊一个历史会话

- Launcher 最近会话 chip 点击 → `session:attach(id)`：
  - running 守卫：若当前有轮在跑则拒绝（错误上抛，前端提示）。
  - 从 `sessions/{id}.jsonl` `Session.fromJSONL` 重放 → 替换活动会话 → 打开/聚焦 Chat 窗口。
  - **不**自动发消息（只载入，等用户输入）。
- 重放后 Chat 完整重同步：清空流式草稿 / 批准态 / 待批准计划，重拉 transcript。
- 后续 `session:send` 追加到该会话（seq 续接，写回同一 JSONL）。

### C3 新建会话

- Chat「＋ 新会话」→ `session:new()`：running 守卫后换全新空 `Session`（旧会话 JSONL 已逐事件落盘，无丢失），并同样触发 Chat 重同步。
- `session:open(first)`（自由输入回车）语义**不变**：仍有活动会话则继续该会话，无则新建。

### C4 会话切换信号

- 单活动会话在 Main；Chat 窗口常驻、React 不重挂。attach/new 真正换了会话时，主进程向已存在的 Chat 窗口推 `session:reset`；Chat 收到即清态 + 重拉。
- 若 Chat 窗口此刻未开（attach 由 Launcher 触发的首次），则新窗口挂载自然读全量，无需 reset。

## 安全 / 边界

- attach 的 id 只按 `^[0-9a-z-]{1,64}$` 收（来自 `latestSessionId` 的随机短 id），禁止路径穿越（`../` 等一律进不了文件名拼接——Session 以 `id + '.jsonl'` join 目录，id 非法即找不到文件上抛）。
- 运行中禁止切会话；切会话不重置 mode（全局偏好）。
- 事件无损不变量不因换会话破坏：换走的会话文件早已 append 完整。

## 失败语义

- id 不存在 / 文件不可读 → 抛错；UI 提示「会话不存在或已损坏」。
- running 中 attach/new → 抛错；UI 提示等待或停止。

## 可测性

- 单测：`listSessions`（排序 / title 截断 / 首条 user 判定 / 空目录）；attach 重放后 transcript 与续写一致（已有 resume 范式）。
- UI e2e：跑两段会话后首页出现两条最近会话；点旧会话 → Chat 回显历史气泡；「＋新会话」→ 清空到空会话。
