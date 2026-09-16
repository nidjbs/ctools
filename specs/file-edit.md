# file_edit（精确替换）— 行为契约

## 目标

让 agent **改一行不用重写整份文件**。整文件 `file_write` 在改大文件时既贵（token）又危险（容易丢内容）。

## 触发

- Agent：`agentTool`，按 schema 调用。
- Launcher：`edit <路径> …`（alias：edit / replace / 改 / 编辑）。Launcher 走同一 `run`。

## 输入

```ts
{
  path: string          // file_roots 内的绝对或相对路径
  old_string: string    // 要被替换的原文（**精确匹配**，非正则）
  new_string: string    // 替换成什么（可为空串 = 删除该片段）
  replace_all?: boolean // 默认 false：要求 old_string 在文件中唯一
}
```

## 输出与匹配语义

| 情况 | 行为 |
|---|---|
| `old_string` 在文件中出现 **恰好 1 次** | 替换，返回 `已修改 <p>（替换 1 处）` |
| 出现 **0 次** | 返回错误文本：`未找到该片段；请先用 file_read 确认原文（文件共 N 行）`，**不写盘** |
| 出现 **>1 次且 `replace_all` 未设** | 返回错误文本：`匹配到 N 处；请给出更长、唯一的上下文，或设置 replace_all`，**不写盘** |
| 出现 >1 次且 `replace_all: true` | 全部替换，返回 `已修改 <p>（替换 N 处）` |
| `old_string` 为空 | 错误：`old_string 不能为空` |
| `old_string === new_string` | 错误：`old_string 与 new_string 相同，无需修改` |

- 匹配为**逐字符精确匹配**（含空白与换行），不做正则、不做模糊。
- 成功后返回**改动上下文摘要**（替换处前若干字符），便于模型确认改动落点。

## 权限与确认（与 file_write 同级）

- **写路径**：只走 `file_roots`（**不含** spill 目录）→ `realInside` realpath 守卫。
- 过 `writeConfirm` 闸门，语义为 `overwrite`（目标已存在）：
  - `auto`（默认）→ 已存在文件需要确认；`always` → 一律确认；`never` → 不确认。
- agent 触发时走 Chat 内人工批准（`onConfirm`）；拒绝则不写盘。
- 越界路径一律拒绝（`拒绝：路径不在 file_roots 内…`）。

## 边界与失败

- 目标是目录 → `读取失败: EISDIR…`。
- 文件不存在 → 错误文本（提示用 `file_write` 创建），不写盘。
- 文件过大（> 1 MB）→ 拒绝编辑并提示改用更小的文件（避免整份读入内存）。
- 读/写失败 → `读取失败/写入失败: <原因>`，不抛。

## 安全约束

- 绝不越过 `file_roots`；绝不绕过 confirm 闸门（`never` 模式由用户显式配置承担）。
- 不提供"整份覆盖"语义（那是 `file_write`）；本命令必须给出确切的原文片段。
