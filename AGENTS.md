# cTools — AI-Native 开发守则

> 本文件是 AI 长期维护 cTools 的**目标与规范**（也可作为 CLAUDE.md/AGENTS.md 互认）。任何改动前先读本文 + `docs/architecture.md`。

## 项目目标

- **cTools**：你的个人 AI 助手，一个 uTools 式悬浮命令面板，把简单、重复的工作收敛到热键输入框。
- **一切能力 = Command**：命令注册表驱动（悬浮联想 / agent 工具 / 设置页启停都读它）。
- **AI-native**：代码由 AI 与开发者长期共同维护——结构清晰、可解释、小而频繁地演进。

## 核心架构不变量（不可破坏）

1. **命令即插件**：能力必须是 `Command` 模块进注册表；逻辑不得塞进 React 组件。
2. **单进程内化**：agent runtime 在 Electron Main（TS），UI 只是视图；不挂 HTTP 桥、不 exec CLI。
3. **LLM 后端 = 本地 gateway**（独立仓库 go-ai-gateway，HTTP），唯一模型出口。
4. **安全（远端模型不可信）**：
   - 敏感内容（剪贴板）只走**本地模型 alias**，远端 agent 不接触。
   - 默认**无网络工具**；新增网络能力须显式开关 + 二次确认。
   - 文件工具限定 `file_roots`；写操作必须经 `confirm`。
   - 会话事件**无损**（事件溯源），一切可见即已记录。
5. **gateway 生命周期归 cTools 管**：启动自拉起、配置改后 reload/restart（见 architecture §6）。

## 开发规范

- **语言/栈**：Electron + React + TS。Main=runtime，preload=类型化 IPC 契约，Renderer=React 视图。
- **类型优先**：TS strict；IPC 用共享类型，禁止裸字符串协议。
- **文案**：UI 中文；代码注释极简英文；commit 信息英文。
- **提交**：小步、一个逻辑一个 commit、先跑测试。默认不自动 commit（等确认）。
- **测试**：改动涉及逻辑就补单测；核心路径（注册表/gateway client/session）必须有测试。
- **迁移原则**：能力从 go-ai-gateway `cli/` 迁移（Go→TS），**只迁移不删除**原 CLI。
- **依赖**：少而精；新增依赖需说明理由。

## 工作流

```sh
npm run dev                 # 本地跑 Electron
npm run test                # 单测
npm run command:new <name>  # 生成新命令骨架(commands/<name>.ts)
npm run build               # 打包
```

**新增一个命令**：注册 `{ id, title, aliases, kind, schema, agentTool, run }` —— 悬浮联想、agent 工具、设置页即自动可用。

## 禁忌

- 不在代码/提交里写 API key、token、密钥。
- 不让敏感内容进入远端模型上下文（clipboard 走本地 alias）。
- 不绕过 `confirm` 做写/删除。
- 不引入默认外传/网络路径。
- 不把命令逻辑写进组件、不过度抽象。
