# cTools 架构设计

状态：设计定稿（2026-09）。技术栈已拍板：**Electron + React + TypeScript（方向 A：全 TS）**。
能力从 go-ai-gateway `cli/` 迁移而来（功能迁移，不删原 CLI）。

## 1. 进程模型

```
┌─ Electron Main (Node/TS) ──────────────────────────────────────┐
│  Agent Runtime（内化 gw 能力）                                   │
│   ├ CommandRegistry + 内置命令                                   │
│   ├ agent loop / session(事件溯源) / context(压缩)               │
│   ├ tools (file / clipboard / find_file / office_read …)        │
│   ├ gateway client（HTTP → 本地 go-ai-gateway, 唯一 LLM 后端）   │
│   ├ gateway manager（自动拉起 / reload / 重启, 见 §6）           │
│   ├ config 存储 + 系统集成(pbcopy / mdfind / 全局热键 / 剪贴板watch)│
│  preload (contextBridge → 类型化 RPC + 事件流)                   │
└──────────┬─────────────────────────────────────────────────────┘
      IPC push(流式/会话事件/工具卡片)      IPC invoke(命令/会话/配置)
┌──────────▼─────────────────────────────────────────────────────┐
│  Renderer (React/TS)                                            │
│   ├ ① Launcher 悬浮框（热键唤起, 无边框置顶）                    │
│   ├ ② Chat 窗口（repl/agent 独立窗, 流式 + 工具卡片 + 确认）     │
│   └ ③ Settings 窗口（命令启停 / gateway / 偏好）                 │
└─────────────────────────────────────────────────────────────────┘
```

- **命令 / agent runtime 全在 Main 进程内化**；Renderer 只是视图，通过类型化 IPC 交互。
- 全局热键（如 ⌘Space）→ 唤起 Launcher；Esc 收起。

## 2. Command Registry（扩展骨架）

一切能力都是一个 `Command`。悬浮框匹配、agent 工具、设置页启停都读注册表。

```ts
interface Command {
  id: string;              // "trans"
  title: string;           // "翻译"
  aliases: string[];       // ["translate","翻译",…] 悬浮框前缀联想
  kind: "quick" | "chat" | "confirm";
  schema?: JSONSchema;     // 参数（悬浮框 + agent 都按此校验）
  agentTool?: boolean;     // 可被 agent 作为工具调用（如 find_file/clipboard）
  run(input: unknown, ctx: Ctx): Promise<Result>;
  enabled?: boolean;       // Settings 可启停
}

type Result =
  | { type: "text"; text: string }                  // inline 快结果, 可复制
  | { type: "list"; items: { title; subtitle; copy? }[] }
  | { type: "chat"; sessionId: string }             // 唤起独立 Chat 窗口
  | { type: "confirm"; message; resolve(cmd) };      // 高风险写操作等确认
```

**输入 → 意图消歧**（悬浮框内）：
- 输入 `tran` / `cl` / `/run wee` → `matchCommands()` 模糊匹配 id/aliases/title → 顶部推荐，Enter 执行。
- 未命中已知命令 → 视为自由内容 → agent 推测（§4）→ 命中某命令的 agentTool 或直接答；需多轮 → `type:"chat"` 开窗。

**开发扩展**：`npm run command:new` 生成 `commands/xxx.ts`，实现 `run` + 声明 aliases/agentTool 即注册，热更新。

## 3. Agent Runtime（自 go-ai-gateway cli 迁移）

| gw (Go) | cTools (TS) | 职责 |
|---|---|---|
| `sessionlog.go` | `runtime/session.ts` | 事件溯源：seq/role/tool_calls/arguments/source/shadow；surface 投影；compaction；resume |
| `context.go` | `runtime/context.ts` | 滑动窗口压缩（head+tail 裁剪 + forceCompact/近满触发） |
| `agent.go` | `runtime/agent.ts` | agent loop：模型→解析 tool_calls→分发→回填→流式 |
| `tools.go` | `runtime/tools/file.ts` | 文件 CRUD + file_roots 权限 + write_confirm |
| `clipboard.go` | `runtime/clipboard.ts` | 剪贴板 watcher + 本地模型召回 |
| `cmd_*.go` | `commands/*.ts` | trans/ask/run/schedule/… 内置命令 |
| `client.go` | `runtime/gateway.ts` | OpenAI 兼容流式客户端 + usage + X-Request-Id |
| `config.go` | `runtime/config.ts` | 应用配置 |

**安全模型（远端模型不可信）继承**：file_roots 作用域；写操作经 `confirm`；剪贴板内容只走本地模型 alias（远端 agent 不接触）；无网络工具；会话事件无损、`/save` 沉淀可复用命令。

## 4. Launcher ↔ Chat 双形态

- **Launcher（quick）**：单轮确定性命令 → inline 结果（译文、路径列表、clipboard find），⌘C / 点击复制。
- **Chat（agent）**：自由内容或开放任务 → 独立窗口。流式输出 + 工具调用卡片（"正在读取 xxx"）+ 写操作确认按钮；会话落盘（事件溯源），可续聊、可 `/save` 沉淀。

## 5. Settings 配置 UI

- **命令**：列出注册表所有命令 → 启停、改 aliases、设快捷键。
- **Gateway**：见 §6。
- **偏好**：默认本地模型 alias（clipboard 召回用）、file_roots、write_confirm 模式。
- 存储：Electron `userData/config.json`（`~/Library/Application Support/cTools/`）。

## 6. Gateway 生命周期管理

cTools 负责本地 go-ai-gateway 的起停与配置热更（对应原 gw `up/down/reload` 的能力）。

- **启动时自动拉起**：`ensureGateway()` —— 探测配置的 healthz/readyz；未就绪则：
  1. 定位 gateway 二进制（cTools 管理的副本 / GW_GATEWAY_BIN / 从 gateway 仓库源码构建）。
  2. 用**托管配置**启动，pid + 日志写 cTools state（`~/Library/Application Support/cTools/gateway/`）。
  3. 轮询 readyz 直到就绪；状态反映到 Settings 与托盘。
- **配置更新 → reload / 重启**：Settings 里可直接编辑 gateway 的 YAML（providers / aliases / 本地模型 alias…），应用时二选一：
  - `reload`：POST `/admin/reload`（热更，无需重启）——适用于别名/路由等可热更项。
  - `restart`：停旧进程 + 按新配置启动 —— 用于不可热更项或状态异常。
  - 界面给出"哪些项适合 reload、哪些需 restart"的提示。
- **生命周期**：cTools 退出时可选择"保留 gateway 常驻"或"随 cTools 关闭"（可配置）。

## 7. 迁移顺序（建议 v1）

1. 仓库骨架：Electron + React/TS + CommandRegistry + gateway client + gateway manager。
2. 首批命令：trans / ask / clipboard（watcher+本地召回）/ find_file（mdfind）/ file 工具。
3. Chat 窗口 + agent runtime（session / context / agent loop）。
4. Settings 全量 + schedule（后台）收编。

## 8. 明确不做（v1）

- 不引入网络工具（保持"无外传"安全边界）。
- 不迁移原 CLI 的 `up/down/reload` 运维形态——由 gateway manager 在 UI 内替代。
- 不做多用户 / 云同步。

## 9. 可执行契约（供构建与迁移参考）

### 9.1 目录布局

```
ctools/
  AGENTS.md / CLAUDE.md / docs/architecture.md
  src/
    main/                     # Electron Main —— 唯一"有逻辑"的地方
      index.ts                # app 生命周期: 单实例/热键/窗口
      registry.ts             # CommandRegistry + registerBuiltins
      agent.ts                # agent loop（流式 + tool_calls）
      session.ts              # 事件溯源会话（surface/compact/resume）
      gatewayClient.ts        # OpenAI 兼容流式客户端
      gatewayManager.ts       # 拉起 / reload / restart（§6）
      config.ts               # 读写 userData/config.json
      ipc.ts                  # preload 暴露的类型化 api
      system.ts               # pbcopy / mdfind / 剪贴板 watcher
    preload/                  # contextBridge
      index.ts
      api.d.ts                # 共享的 IPC 契约类型
    shared/                   # main/renderer 共享类型
      types.ts                # Command / Result / Session / Config …
    renderer/                 # React
      launcher/               # ① 悬浮框
      chat/                   # ② Chat 窗
      settings/               # ③ 配置
  commands/                   # 内置命令（每个文件一个）
    trans.ts / ask.ts / clipboard.ts / find_file.ts / files.ts …
  tests/
```

### 9.2 核心类型（`shared/types.ts`）

```ts
export type CommandKind = "quick" | "chat" | "confirm";

export interface Command {
  id: string;
  title: string;
  aliases: string[];
  kind: CommandKind;
  schema?: JSONSchema;
  agentTool?: boolean;
  enabled?: boolean;
  run(input: unknown, ctx: Ctx): Promise<Result>;
}

export type Result =
  | { type: "text"; text: string }
  | { type: "list"; items: { title: string; subtitle?: string; copy?: string }[] }
  | { type: "chat"; sessionId: string }
  | { type: "confirm"; message: string; resolve(value: boolean): void };

export interface Ctx {
  config: AppConfig;
  gateway: GatewayClient;
  session: Session;
  fs: FilePolicy;        // file_roots 作用域 + write_confirm
  system: System;        // pbcopy / mdfind / clipboard
}

export interface AppConfig {
  gatewayUrl: string;
  adminUrl: string;
  adminToken?: string;
  defaultAlias: string;
  clipboardLocalAlias?: string;   // 剪贴板本地召回专用
  fileRoots: string[];
  writeConfirm: "auto" | "always" | "never";
  hotkey: string;
  commands: Record<string, boolean>;   // 启停
}

// 会话事件（事件溯源, 与 gw sessionlog schema 对齐）
export type SessionEventType =
  | "session.started" | "system.context" | "user.message"
  | "model.request" | "assistant.message" | "tool.call" | "tool.result"
  | "agent.error" | "context.compact" | "session.ended";

export interface SessionEvent {
  event_id: string; session_id: string; seq: number; type: SessionEventType;
  occurred_at: string; role?: string; turn?: number; request_id?: string;
  model?: string; tool_name?: string; tool_call_id?: string; arguments?: string;
  content?: string; tool_calls?: unknown[]; source_seqs?: number[]; shadow_seqs?: number[];
}
```

### 9.3 IPC 契约（preload `api`）

```ts
window.api = {
  commands: {
    list(): CommandMeta[];                       // Launcher 联想
    run(id: string, input: unknown): Promise<Result>;
  },
  suggest(text: string): Promise<CommandMeta | "chat">;  // 自由内容→agent 推测
  session: {
    open(kind: "chat" | "resume", sessionId?: string): string;
    send(msg: string): Promise<void>;
    onEvent(cb: (e: SessionEvent) => void): () => void;  // 流式/工具卡片
    transcript(): SessionEvent[];
  },
  gateway: { status(): Promise<"running"|"stopped">; restart(): void; },
  config: { get(): AppConfig; update(patch): Promise<void>; },
};
```

### 9.4 示例命令：`find_file`（开发者扩展范式）

```ts
import { Command } from "../src/shared/types";

export const findFile: Command = {
  id: "find_file",
  title: "查找文件",
  aliases: ["find", "文件", "搜索", "locate"],
  kind: "quick",
  schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  agentTool: true,                       // agent 也可调用
  async run({ query }, { config, system }) {
    const paths = await system.mdfind(query, config.fileRoots);   // -onlyin roots
    return { type: "list", items: paths.map((p) => ({ title: p, copy: p })) };
  },
};
```

### 9.5 Gateway Manager 接口

```ts
class GatewayManager {
  status(): Promise<"running" | "stopped">;      // 探测 readyz
  ensureStarted(): Promise<void>;                 // 未就绪则拉起（托管配置+pid/日志）
  applyConfig(yaml: string, mode: "reload" | "restart"): Promise<void>;
  // reload = POST /admin/reload; restart = 停旧 + 按新配置起新
  stop(): Promise<void>;
}
```

### 9.6 agent loop（伪码，内化 gw `agent.go`）

```
turn(messages):
  loop (≤8 轮):
    res = gateway.chatStream(messages, tools=agentTool 命令)   // 流式→UI
    session.append(assistant, res)                              // 事件溯源
    if !res.tool_calls: return final
    for call in res.tool_calls:
      cmd = registry.getTool(call.name)
      ok? session.append(tool.call)
      out = await cmd.run(call.args)                            // FilePolicy/系统工具
      session.append(tool.result, out)                          // 完整结果落日志
    maybeCompact(session, config)                               // 近满触发压缩
```

