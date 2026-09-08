# cTools

> 你的个人 AI 助手 —— 一个用全局热键唤起的悬浮命令面板，把日常简单、重复的工作收敛到一个输入框里。

按一下热键，输入工具关键词或一段自然语言：cTools 会**联想/推测你要的命令**——简单的事就地给结果（译文、路径、剪贴板命中），复杂或开放的事自动唤起一个**流式 agent 对话窗**来替你完成。

- 悬浮启动器 + 对话窗 + 设置窗，全局热键唤起
- 一切能力 = 命令：翻译、找文件、读文档、剪贴板召回、执行 shell、联网搜索……
- 复杂任务可交给 agent（流式回复 + 工具调用 + 逐步执行），支持「**规划 → 批准 → 执行**」模式
- **安全默认**：文件限定可读根目录、写/删/执行 shell 都要你批准、剪贴板敏感内容只走本地模型、联网默认关闭
- 把一次满意的对话 **`/save` 沉淀成可复用模板**，下次首页一键直达

> LLM 后端是跑在本机的一个 **OpenAI 兼容本地模型网关**（默认 `http://127.0.0.1:8080`），cTools 只负责指挥它。
> 状态：**MVP**（主流程已贯通，定位个人工具，尚未打磨打包分发）。

---

## 快速开始

### 1. 准备模型网关

cTools 本身不带模型。需要先在本机运行一个 OpenAI 兼容的本地模型网关（默认地址 `http://127.0.0.1:8080`），并在其中配置好模型 provider 与别名。

- 默认模型别名 `defaultAlias = chat`：可指向远端模型（普通任务）。
- `clipboardLocalAlias`（可选）：**本地模型**别名，仅用于剪贴板语义召回（隐私优先）。不配置则退回普通模型。
- 启动时若网关可达，cTools 会把默认别名**校准**成网关上真实存在的别名。

### 2. 安装与运行

```sh
npm install
npm run dev          # 本地开发运行（Electron）
```

首次使用在**设置**里确认/编辑 gateway 地址与别名，再回到 Launcher 即可。

### 3. 唤起

- 全局热键：默认 **`⌘ / Ctrl + ⇧ + Space`**（在设置里可改），再次按下收起。
- 应用启动时 Launcher 悬浮框也会出现；悬浮框**失焦自动收起**，`Esc` 逐级收起。

---

## 怎么用

### Launcher 输入框的三种「落点」

在顶部输入框里输入，回车会去不同的地方：

| 你输入 | 会发生什么 |
|---|---|
| 命令前缀，如 `trans`、`find` | 联想命令，回车进入「参数态」继续输入，再回车执行 |
| 命令 + 参数，如 `trans hello world`、`find_file 发票` | 直接执行，inline 出结果（可一键复制） |
| 自由内容（没命中命令），如 `帮我总结一下 PDF` | 交给 agent → 打开**对话窗**（见下） |
| `settings` / `设置` | 打开设置窗 |

### 首页模板（空输入）

不输入时 Launcher 展示常用任务入口（含你 `/save` 沉淀的 ⭐ 模板）。选中一个模板会自动带出 `#模板id 参数` 参数态：

| 模板 | 做什么 |
|---|---|
| 🌐 翻译 | 翻译文本（可带目标语言） |
| 🔍 找文件 | 系统搜索文件名/内容 |
| ⚡ 运行命令/脚本 | 描述要达成的结果，需要执行 shell 时会请你批准 |
| 📄 读文档并总结 | 读取文件/文档后给要点 |
| 📝 新建笔记 | 把内容整理成 markdown 写入文件 |
| 📋 查剪贴板 | 在剪贴板历史里检索 |
| ⭐ … | 你自己 `/save` 沉淀的模板 |

### Chat 对话窗

自由内容回车后进入 Chat：流式输出，可看到 agent 正在调用哪些工具、每步做到哪。会话内支持：

- **直接 / 规划**（对话窗顶栏常驻开关，Launcher 将进 agent 时也会浮现）：
  - **直接**：边聊边做，需要动文件/执行时仍逐条请你批准。
  - **规划**：复杂任务先让 agent 用**只读工具**调研、产出 4–6 步的编号计划（计划卡，附摘要）；你「**批准并执行** / 按反馈重新规划 / 放弃」。批准后 agent 按步骤执行、逐条打勾；执行中的破坏性操作仍会单独再向你确认一次。
- **批准弹层**：agent 想执行 shell、写/删文件时，会暂停并弹「批准 / 拒绝」；批准才真正执行。
- **`/save`**：把当前会话沉淀成一条可复用模板 —— 让 LLM 提炼成一段干净指令（支持 `{param}` 占位，供每次替换输入），确认后保存，回到首页即成 ⭐ 模板。
- **停止**：可随时取消回答中的一轮；每次打开对话都是**新会话**（不自动续上次）。

### 设置窗

输入 `settings` / `设置` 打开，管理：

- **Gateway**：连接状态、可用模型列表、热更新 `reload` / 重启 `restart`、「托管 gateway」（开启后 cTools 自动拉起并管理它，默认关）。
- **命令**：列出全部命令，可单独启停，即时生效。
- **偏好**：全局热键、文件根目录 `file_roots`、写确认模式、默认模型别名、`clipboardLocalAlias`、联网搜索开关（默认关）。

---

## 命令速查

| 命令 | 触发词（id / 别名） | 作用 |
|---|---|---|
| `trans` | 翻译 · translate · fy | 翻译文本 |
| `find_file` | 找文件 · find · 搜索 · locate | 在文件根目录内用系统索引搜索，返回路径列表（回车复制） |
| `file_read` | 读文件 · read · cat | 读取文本文件内容 |
| `file_list` | 列目录 · ls · dir | 列目录 |
| `file_write` | 写文件 · write | 写入/覆盖文件（覆盖已存在需批准） |
| `file_rm` | 删文件 · rm · del | 删除文件（**恒需批准**） |
| `office_read` | 读文档 · read_doc · office | 提取 docx / xlsx / pdf / txt 等文本 |
| `clipboard` | 剪贴板 · clip · cb | 最近历史列表；`clipboard <内容>` 语义召回（见隐私） |
| `bash` | 执行 · run · sh · shell | 在 shell 执行命令（**每次需批准**，30 秒超时，在文件根目录下执行） |
| `web_search` | 联网搜索 · search · ddg | DuckDuckGo 网页搜索（**默认关闭，开启后每次仍要批准**） |

部分命令同时是 **agent 可调用的工具**（`file_read/list/write/rm`、`find_file`、`office_read`、`bash`、`web_search`）；`trans`、`clipboard` 刻意**不给 agent 调用**（见隐私）。agent 白名单外的工具一律拒绝，防「幻觉调用」。

---

## 安全与隐私

面向一个「远端模型不可信」的前提设计，你只需知道：

- **剪贴板不进远端模型**：`clipboard` 的语义召回默认只走 `clipboardLocalAlias`（本地模型）；且它不是 agent 工具，agent 碰不到你的剪贴板历史。
- **文件有界 + 写要批准**：文件工具只作用于设置的 `file_roots` 内；写覆盖/删除、`bash` 一律弹批准。agent 触发的写/删/执行同样过批准闸门（它没有「免批」通道）。
- **联网默认关**：`web_search` 默认关闭；即使开启，每次调用仍会弹批准。
- **全量留痕**：每次对话以事件流完整落盘（谁说的、模型回了什么、调了哪些工具、参数与结果、你的批准/拒绝），可随时回看，压缩只降展示、不删审计原文。

---

## 配置与数据

配置存在 Electron 的 userData 目录（默认 `~/Library/Application Support/cTools/`）：

| 文件 | 内容 |
|---|---|
| `config.json` | 应用配置（gateway、别名、file_roots、热键、命令启停、开关） |
| `sessions/` | 会话事件流（JSONL，事件溯源） |
| `clipboard.jsonl` | 剪贴板历史（追加式） |
| `saves.json` | `/save` 沉淀的模板 |
| `gateway/` | 托管 gateway 的进程与日志（仅开启托管时） |

---

## 常见问题

**命令提示「gateway 不可达 / 别名无效」？**
确保本地模型网关正在运行、地址与 `defaultAlias` 正确。可在设置窗里查看连接状态、reload，或开启「托管 gateway」让它自动拉起。

**我想让 agent 能改文件 / 执行命令。**
写、删、bash 本就开放给 agent，但它们只能在你批准后真正落盘/执行——这是设计不是 bug。

**如何让剪贴板召回更私密？**
在设置里配置 `clipboardLocalAlias` 指向一个本地模型；这样语义召回完全不经过远端。

---

## 给开发者（简述）

> 详细规范见 **[AGENTS.md](AGENTS.md)**（架构不变量 / 开发守则）与 **[docs/architecture.md](docs/architecture.md)**（进程模型 / 契约）。

**一句话架构**：一切能力 = 一个 `Command`（注册表驱动悬浮联想 / agent 工具 / 设置启停）；agent runtime 与命令逻辑**全部内化在 Electron Main（TS）**，UI（React）只是视图，经 preload 的类型化 IPC 交互；LLM 唯一出口是本地模型网关（OpenAI 兼容）。

```
src/main/        命令注册表 + agent runtime + gateway 客户端/管理 + 会话/剪贴板/配置
src/preload/     contextBridge 类型化 IPC
src/renderer/    React：Launcher 悬浮框 / Chat / Settings
src/shared/      main·renderer 共享类型
commands/        内置命令（一个文件一个 Command）
specs/           功能行为契约（spec → 测试 → 实现）
tests/           单测 + 运行时 e2e（vitest）；tests/ui/ 为 Playwright UI e2e
```

常用脚本：

```sh
npm run dev            # 本地运行
npm run test           # 单测 + 运行时 e2e
npm run test:ui        # UI e2e（真实 Electron + mock gateway）
npm run test:all       # 全量回归
npm run typecheck      # TS 双配置检查
npm run command:new    # 生成新命令骨架 commands/<name>.ts
npm run build          # 打包
```

新增能力 = 注册一个 `Command`（`{ id, title, aliases, kind, schema, agentTool, run }`），悬浮联想、agent 工具、设置启停自动可用。开发请遵循 SDD：先 `specs/<feature>.md` 立行为契约，再写测试，后实现（见 `specs/README.md`）。
