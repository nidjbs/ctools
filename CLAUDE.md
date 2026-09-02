# cTools — Claude Code 入口

开发规范、架构不变量与安全守则在 **[AGENTS.md](AGENTS.md)**；完整设计在 **[docs/architecture.md](docs/architecture.md)**。

动手前必读。核心一句话：**一切能力 = Command 注册表；agent runtime 在 Main 进程内化（TS）；LLM 走本地 gateway；远端模型不可信 → 敏感内容只走本地模型。**
