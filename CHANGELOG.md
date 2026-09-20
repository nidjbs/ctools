# Changelog

本文件记录 cTools 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
`package.json` 的 `version` 是唯一版本源；发版时在此追加对应条目。

## [Unreleased]

### 计划中
- **阶段三** 健壮性：gateway 重试退避、错误分类、grep 异步化、配置数据版本与迁移
- **阶段四** 产品化：token/成本可见、用户文档（`docs/guide.md`）
- **阶段五** 跨平台：`System` 抽象落地、沙箱按平台降级
- 代码签名与公证（待自备 Apple Developer 账号）

详见 [docs/roadmap.md](docs/roadmap.md)。

## [0.5.0] - 2026-09-20

**首个可分发版本**：cTools 自带 gateway，装完即可用；arm64 与 x64 均有可用产物。

### 新增
- **自包含**：内嵌 gateway 服务端二进制（`Contents/Resources/gateway/`），cTools 直接拉起，不再需要用户预装任何东西；配置由 cTools 自持于 `<userData>/gateway.yaml`，首启自动从既有 gw 配置迁移
- **打包分发**：`.dmg` 与 `.zip`（arm64 + x64）、应用图标、`CHANGELOG`；`.dmg` 用系统自带 `hdiutil` 制作，不依赖需从 GitHub 下载的 dmg 辅助包
- **首启向导**：零上游时一键检测本机 Ollama（无需密钥）或手填上游，一步配好并启动
- **网关配置编辑**：设置里直接改 `providers` / `aliases`（备份 + 校验 + 原子写），改完热更或重启
- **模型分配**：默认模型之外，固定场景（如翻译）可各用各的别名
- **设置入口**：Launcher 空态「⚙️ 设置」行 + 菜单栏 `cTools → 设置…`（⌘,）
- **首启目录引导**：`file_roots` 未配置时引导选择目录，不再默认放行整个文件系统
- **CI 回归门禁**：typecheck / 单测 / 黄金集 / 构建（Linux）+ UI e2e（macOS）
- **二进制溯源**：内嵌二进制的源 commit、构建命令与 sha256 入库，`npm run verify:gateway` 可校验

### 修复
- **x64 产物此前不可用**：只内嵌了 arm64 的 gateway，Intel Mac 装上后网关起不来
- **关窗后无法续聊**：未决的批准/提问未释放，`running` 恒为 true 使 attach 静默失败，表现为「点了没反应」
- **gateway 启动失败无迹可查**：子进程输出被丢弃，现落 `<userData>/gateway.log`
- 连接设置（`gatewayUrl` 等）此前是设置页最显眼字段，易被误改导致全面不可用；现收进「高级」折叠

### 变更
- `grep` 结果、`ask` 澄清通道、工具描述等使 agent 的工具选择更准；只读工具并行执行
- 上下文超限时改为「摘要 + 合并」而非直接丢弃旧消息

### 已知限制
- **仅 macOS**（系统集成依赖 `pbcopy` / `mdfind` / `sandbox-exec`）
- **无签名**：首次打开需右键「打开」，或 `xattr -d com.apple.quarantine`（详见 `docs/guide.md`）
- gateway 调用无重试；`grep` 为同步遍历（大目录会阻塞主进程）
- `api_key_env` 指向的环境变量需在 **app 自己的环境** 中可见（GUI 启动不加载 `~/.zshrc`）

## [0.1.0] - 2026-09-19

MVP 收尾：主流程贯通 + 长期记忆 + 上下文工程 + 完整工具面。**仅支持 macOS，尚无签名安装包。**

### 新增
- **命令注册表**：一切能力 = `Command`，Launcher 联想 / agent 工具 / 设置启停同源
- **Launcher**：全局热键唤起、前缀联想、模板（含 `/save` 沉淀的 ⭐ 模板）、最近会话、复制反馈、结果可 Finder 定位/打开
- **Chat**：流式输出、工具过程折叠展示、多行输入、会话续聊与「＋新会话」、`/save` 蒸馏模板
- **规划模式**：只读调研 → 计划卡 → 批准执行 / 反馈重规划 / 放弃
- **长期记忆**：`memory.jsonl` 事实源 + 生成的 `MEMORY.md` 索引常驻 + 按需召回 + pinned；`remember`/`forget`/`recall`/`memory`
- **上下文工程**：token 计量（条数兜底）、每轮环境注入（工作目录/可写范围/日期）、模型摘要 + 摘要合并、大工具结果外置可回取
- **工具面**：`file_read`（含行区间）/`file_list`/`file_write`/`file_edit`/`file_rm`、`find_file`、`grep`、`office_read`、`clipboard`、`bash`、`web_search`、`trans`、`ask`
- **agent 循环**：只读工具并行、同参数循环检测提示、工具描述（何时用/不用）
- **安全**：`file_roots` + realpath 守卫（含 symlink 逃逸）、`bash` 经 OS 沙箱默认禁网、写/删/bash 恒过 confirm 闸门、agent 工具白名单兜底、剪贴板只走本地模型
- **测试**：单测 + 运行时 e2e + **黄金集**（断言模型实际收到的请求）+ UI e2e

### 已知限制
- 仅 macOS（系统集成依赖 `pbcopy`/`mdfind`/`sandbox-exec`）
- 无签名安装包，需从源码 `npm run dev` 运行
- gateway 调用无重试；`grep` 为同步遍历（大目录会阻塞主进程）
