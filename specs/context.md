# 上下文压缩（TS 移植 cli/context.go）— 行为契约

## 目标

模型上下文有界：surface（模型可见消息）计数接近高水位时压缩；大工具结果（如 file_read 256KB）先裁剪。

## 规则

- 默认：`capacity=20`、`triggerPercent=20`、`maxToolBytes=8000`。
- 高水位 `high = floor(capacity×(1−triggerPercent/100))`；低水位 `low = floor(capacity×0.6)`（至少 1）。
- **裁剪（不看计数，每次必做）**：surface 里 `content>maxToolBytes` 的 `tool.result` → 追加裁剪节点
  `{type:'tool.result', role:'tool', content: head+省略标记+tail, shadow_seqs:[原seq], source_seqs:[原seq]}`。
  原事件保留在 transcript（审计）；模型只见裁剪版。
- **压缩（仅当 surface 计数 > high）**：依次 shadow 最旧的**非 `system.context`** surface 事件，
  直至计数 ≤ `low`。shadow 通过追加 `context.compact {shadow_seqs:[seq]}` 实现，原事件保留。
- `capacity<=0` → 禁用；`triggerPercent` clamp 到 [0,100]。

## 事件溯源

- 原事件永不修改/删除；投影（messages/surfaceEvents）据 `shadow_seqs` 隐藏旧事件。
- 压缩事件不入 UI 气泡（无 role 或非气泡类型）。

## 失败与边界

- 会话里只有 system 时：压缩不动 system；极端小 capacity 且 high<low 时跳过计数压缩（只裁剪）。
