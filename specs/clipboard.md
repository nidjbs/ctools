# clipboard — 行为契约

## 触发

- Launcher：`clipboard`（alias clip / 剪贴板 / cb）回车 → 最近历史列表（可点复制）。
- `clipboard <query>` → **语义召回**：在候选中经**本地模型 alias** 选最贴合的一条，inline 返回。
- 主进程常驻 watcher：轮询系统剪贴板，变化即追加到 append-only `userData/clipboard.jsonl`。

## 存储（ClipboardStore）

- 条目 `{ text, ts }`；空/去重（与上一条相同）不写。
- `recent(n)`：最近 n 条，新→旧。
- `candidates(query, n)`：取较近历史中与 query 有 token 交集者，按相关度+新近排序取 n；无交集返回空（命令报 `无匹配`）。

## 语义召回（`clipboard <query>`）

1. 需 `config.clipboardLocalAlias` 已配（否则返回提示）。
2. 取 candidates → 组编号列表 → 调 `gateway.chat({ model: alias })` 请模型回最匹配编号。
3. 解析失败回退第 1 条。返回该条文本。

## 安全约束（远端模型不可信）

- `clipboard` 命令 **agentTool=false** → 不进 agent 白名单；agent/远端模型永远接触不到剪贴板内容。
- 语义召回只经 `clipboardLocalAlias`（指向本地模型）；若该 alias 配错成远端，属配置责任（Settings 需引导为本地）。

## 失败与边界

- 无历史 → `剪贴板历史为空`；无匹配 → `无匹配`；本地 alias 未配置的 find → 提示配置。
- 系统剪贴板读取失败静默（不打断 watcher）。
