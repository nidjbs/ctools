# cTools

> 你的个人 AI 助手 —— 一个 uTools 式的悬浮命令面板，把日常简单、重复的工作收敛到一个热键输入框里。

cTools 是一个 **Electron + React/TypeScript** 桌面应用：

- **悬浮启动器**（uTools/Raycast 式）：热键唤起，输入工具关键词或正常内容，自动联想/推测要用的命令；简单命令 inline 快结果，repl/agent 对话唤起独立窗口。
- **内化的 agent runtime**：会话（事件溯源）、上下文压缩、工具与命令注册表、gateway 客户端——全部在应用进程内（TS），无 HTTP 桥、无子进程。
- **命令即插件**：开发者注册一个 TS 模块即可扩展能力。
- **gateway 生命周期管理**：启动时自动拉起本地 gateway；配置界面编辑 gateway 配置后一键 reload / 重启。

LLM 后端是 [go-ai-gateway](https://github.com/nidjbs/go-ai-gateway)（独立仓库，HTTP 调用，纯本地）。

## 仓库结构（规划）

```
ctools/
  docs/architecture.md    # 架构设计（命令注册表 / agent runtime / 双窗口 / 配置 / gateway 管理）
  src/
    main/                 # Electron Main: agent runtime + CommandRegistry + gateway client + config
    preload/              # contextBridge 类型化 RPC
    renderer/             # React: launcher 悬浮框 / chat 窗口 / settings 配置 UI
  commands/               # 内置命令模块（迁移自 gw CLI 的能力）
```

> 状态：架构设计阶段（详见 docs/architecture.md）。能力从 go-ai-gateway 的 `cli/` 迁移而来（只做功能迁移，不删原 CLI）。
