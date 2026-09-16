# 上下文工程 — 行为契约

## 目标

模型上下文有界且**不丢任务目标**：按 token 计量、超限时「摘要 + shadow」而非直接丢头；大工具结果外置、可回取。

## 计量

- token 估算为本地纯函数（`src/shared/tokens.ts`）：ASCII ≈ 4 字符/token，CJK ≈ 1 字符/token（取保守上界）。
- 单条消息 token = `content` + `reasoning_content` + `tool_calls` JSON 序列化长度。
- 默认 `capacityTokens = 24000`（≈32k 窗口留 25% 余量）；另有条数兜底 `capacityCount = 200`（防极端小参数死循环）。

## 触发

- 每次模型请求前（`agentLoop` 循环内）调用 `compactIfNeeded(session, ctx, opts)`。
- `high = capacityTokens × (1 − triggerPercent/100)`；surface token > `high` 时触发压缩。
- 压缩目标：降到 `low = capacityTokens × 0.6`。

## 规则

### 1. 大工具结果外置（不看计数，每次必做）

- surface 中 `tool.result` 的 `content` 长度 > `maxToolBytes`（默认 8000）：
  1. 全文写入 `userData/spill/<event_id>.txt`；
  2. 追加替换节点 `{type:'tool.result', role:'tool', content: 头 + '…[完整结果已存至 <path>，可用 file_read 读取]' + 尾, shadow_seqs:[原seq], source_seqs:[原seq]}`。
- **spill 写失败 → 退回纯头尾裁剪（`trimText`），不阻断主流程。**
- 原事件保留在 transcript（审计）；模型只见替换版。

### 2. 摘要压缩（仅当 surface token > high）

- 取最旧的一批**非 `system.context`** surface 消息，组成一次模型调用（无工具）产出摘要：
  覆盖「任务目标 / 已完成 / 关键结论与数据 / 待办」。
- 摘要落 `context.summary` 事件（`role:'system'`），**参与 `messages()` 投影**（不被兜底丢头 shadow）。
- 然后 shadow 原批次至 ≤ `low`。
- `summarize=false` 或摘要调用失败 → **退回直接 shadow（即现有丢头行为）**，不崩。
- 摘要调用走 `defaultAlias`；被摘要的内容本就在上下文里，**不产生新的外传**。

### 2.1 摘要合并（长会话只保留一条）

- 产生新摘要时，**已有的 `context.summary` 一并纳入本次摘要输入**（标注「已有摘要，请合并进新摘要」），
  并随本次压缩**一起退役**（`shadow_seqs` 含旧摘要 seq）。
- 结果：上下文里**始终只有一条**摘要，不会随压缩次数层层堆积；信息不丢（旧摘要内容已并入新的）。
- 兜底丢头（step 3）**不**触碰摘要（`KEEP_TYPES`）——摘要的退役只由本机制显式处理。
- 本次无新消息可压（batch 为空）→ 不产生新摘要，旧摘要原样保留。

### 3. 原子性

- shadow `assistant.message`（含 `tool_calls`）时，**连同其 `tool.result` 一起 shadow**（按 `tool_call_id` 匹配），避免留下孤立 tool 消息触发上游 400/502。

### 4. 极端参数

- `capacityTokens <= 0` → 禁用压缩（只做外置）。
- `high < low` → 跳过计数压缩，只做外置。

## 事件溯源

- 原事件永不修改/删除；投影（`messages()` / `surfaceEvents()`）据 `shadow_seqs` 隐藏。
- `context.summary` 为新增事件类型；压缩/摘要事件**不入 UI 气泡**。

## 安全约束

- spill 目录不落在用户文件区：`userData/spill/`。
- `file_*` 的**读根集合 = `fileRoots ∪ spillDir`**；**写仍限 `fileRoots`**（不因 spill 放宽写入边界）。
- 摘要不引入新的模型出口。

## 边界与失败

- 会话只有 system 消息 → 压缩不动 system。
- gateway 不可达 → 摘要失败 → 退回直接 shadow。
- spill 目录不存在 → 按需 `mkdir -p`；失败则降级裁剪。
