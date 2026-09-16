# grep（内容搜索）— 行为契约

## 目标

`find_file` 走 Spotlight（索引依赖、只搜文件名+内容），缺一个**确定性的「在文件内容里按模式搜」**能力：agent 要定位代码/文本位置时，需要 `path:line` 级结果。

## 触发

- Agent：`agentTool`（`planSafe: true`，可入规划工具集）。
- Launcher：`grep <模式> [路径]`（alias：grep / 搜索内容 / 内容搜索）。

## 输入

```ts
{
  pattern: string     // 子串；非法正则时按字面量处理
  path?: string       // 搜索起点（须在 file_roots 或 spill 内）；缺省 = 全部读根
  glob?: string       // 文件名过滤，如 "*.ts"；缺省不过滤
  ignoreCase?: boolean // 默认 false
  maxResults?: number  // 默认 100，硬上限 500
}
```

## 输出

`list` 结果，每条：

| 字段 | 值 |
|---|---|
| `title` | `<相对或绝对路径>:<行号>` |
| `subtitle` | 命中行内容（去首尾空白、截 200 字） |
| `copy` | `<路径>:<行号>: <命中行>` |
| `path` | 该文件绝对路径（供 Finder/打开） |

- 无命中 → `text`：`未找到匹配 "<pattern>"（已扫描 N 个文件）`。
- 结果按「文件路径升序、行号升序」稳定排序。

## 扫描规则（自己走目录，不用 mdfind）

- 起点：`path` 指定 → 该目录（或该文件）；缺省 → **读根集合**（`file_roots ∪ spill`）。
- **跳过目录**：`.git`、`node_modules`、`dist`、`out`、`build`、`.next`、`coverage`、`__pycache__`。
- **跳过文件**：`.DS_Store`；单文件 **> 1 MB**；读出的前 8KB 含 `\0`（二进制）。
- **扫描上限**：最多 5000 个文件；超出即停止并在结果文本里标注「已截断」。
- 逐行匹配；命中数达 `maxResults` 即停止收集（仍返回已收集结果）。
- `glob` 支持 `*` 通配（转成正则匹配**文件名**，非全路径）。

## 边界与失败

- `pattern` 为空 → `用法: grep <模式> [路径]`。
- `path` 越界（不在读根内）→ `拒绝：路径不在 file_roots 内…`。
- 目录不可读 / 符号链接 loop → 跳过该项，不中断整体搜索。
- 结果超上限 → 文本尾部标注 `（已达上限 N 条，可能还有更多）`。

## 安全约束

- 只读：**不改动任何文件**，可安全进入 agent 与 plan 工具集。
- 搜索范围严格限定读根；`spill` 目录可被搜到（它是外置的工具结果，属会话产物）。
