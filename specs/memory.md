# 长期记忆（memory）— 行为契约

## 目标

跨会话记住用户的事实与偏好，让助手越用越顺手。**写入显式、可审可删、默认不自动进入上下文。**
形态学习 Claude Code：**索引常驻 + 正文按需召回 + pinned 正文常驻**。

## 触发

| 命令 | 输入 | agentTool | planSafe | 说明 |
|---|---|---|---|---|
| `remember` | `{ text, title?, kind?, tags? }` | ✓ | ✗ | 写有副作用 |
| `forget` | `{ id }` | ✓ | ✗ | 同上 |
| `recall` | `{ query }` | ✓ | ✓ | 只读，可入 plan 工具集 |

- Launcher：输入 `memory` / `记忆列表` → inline 列出全部记忆（点击**复制** `gist`）。
  - 该命令 `agentTool: false`（agent 用 `recall`，不暴露浏览入口）。
- **Settings「记忆」section 是人在环审阅面**：列表（⭐ + 标题 + kind 标签 + `gist`）+ 「✕ 删除」+ 「常驻」勾选。
  - pin 勾选旁必须有提示：常驻会把正文每轮发给当前模型（可能远端），只对不敏感内容开启。

## 存储

### 事实源 `userData/memory.jsonl`（append-only + tombstone）

```ts
export type MemoryOp = 'add' | 'update' | 'forget'
export interface MemoryRecord {
  id: string          // 8 位短 id
  op: MemoryOp
  ts: string          // ISO
  title?: string      // 索引行标题；缺省取 text 前 20 字
  gist?: string       // 一行钩子；缺省取 text 前 60 字
  text?: string       // 正文全文
  kind?: 'fact' | 'preference' | 'procedure'
  tags?: string[]
  pinned?: boolean    // 正文常驻注入
  source?: string     // 来源会话 id（审计）
}
```

- 投影 `live()`：按 `id` 折叠（`add` 建 / `update` 改 / `forget` 删）。
- `forget` 为**软删**：原记录仍在 jsonl（审计），投影时隐藏。
- 坏行跳过（同 `listSessions` 容错），不因单行损坏丢整库。
- **jsonl 是唯一事实源**；索引页是它的投影，可随时重建。

### 生成式索引页 `userData/MEMORY.md`

- 每次 `add`/`update`/`forget` 后由 `live()` **整份重写**。
- 格式（每条一行，供人阅读 + 供常驻注入）：

```md
# 记忆索引

- [文档一律写中文](a1b2c3d4) — 用户偏好中文文档
- [⭐ 部署流程](e5f6g7h8) — pinned，正文常驻
```

- `pinned` 条目标题前加 `⭐` 标记。
- 索引页**可被用户直接阅读**，但手改不回写 jsonl（下次写入即被覆盖）—— 这点在文件头注释说明。

## 召回

- **本地关键词打分**，不引入 embedding（网关无 `/v1/embeddings`，且向量服务可能远端，与「远端模型不可信」冲突）。
- 流程：**先在索引（title + gist + tags）里打分**，命中后再取命中条目的**正文全文**返回。
- 切词：ASCII 按词、CJK 按 bigram。
- **`tags` 权重 > `title`/`gist` 权重**；返回 top-K（默认 5）。
- 无命中 → 返回「（无匹配记忆）」。
- 正文过长（>2000 字）→ 返回时截断并标注。

## 注入（常驻部分）

每轮请求注入两块，均为 **turn 级快照**（见 `system-prompt.md` R2）：

1. **索引**：`MEMORY.md` 全文（无记忆则整段省略）。
2. **pinned 正文**：`pinned` 条目的 `text` 全文，上限 20 条，超出按 `ts` 新近取。

- 非 pinned 记忆的**正文不注入**，靠 agent 主动 `recall`。
- 注入位置遵守 `system-prompt.md` R3（稳定 → 易变）。

## 隐私边界（决策 2026-09-17）

- **首版不做 `sensitive` 标记。** 边界靠两点控制：
  1. 正文默认**不自动注入**（索引常驻，但索引只是标题+钩子；正文需 `recall` 才进模型）；
  2. Settings 可**审、可删** —— agent 把敏感内容记下来时，用户能看见并删除。
- 注意：`pinned` 正文与索引都会进入 `defaultAlias`（可能为远端模型）。**用户主动 pin 即视为同意**；Settings 中 pin 开关旁须有该提示文案。

## 安全约束

- `memory.jsonl` / `MEMORY.md` 只由 `MemoryStore` 在 `userData` 下读写，**不进入 `file_roots` 作用域**（避免被 `file_*` 工具或 agent 批量改写）。
- 工具不提供「清空全部」；删除必须逐条（防误操作与 prompt 注入式批量抹除）。

## 边界与失败

- `text` 为空 → 报错「记忆内容不能为空」。
- `text` 超过 500 字 → 截断至 500 字后存储。
- `forget` 不存在的 id → 幂等，不报错。
- 记忆库为空 → 索引段省略；`recall` 返回「（无匹配记忆）」。
- 索引页重写失败 → 不影响 jsonl 写入（索引可重建），下次写入重试。
