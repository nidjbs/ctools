# Changelog

本文件记录 cTools 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
`package.json` 的 `version` 是唯一版本源；发版时在此追加对应条目。

## [Unreleased]

### 计划中
- **阶段一** 打包分发：electron-builder + 应用图标 + `.dmg`/`.zip` 产物 + 版本策略；代码签名待自备 Apple Developer 账号
- **阶段二** CI 回归门禁：typecheck / 单测 / 黄金集 / UI e2e 分 job
- **阶段三** 健壮性：gateway 重试退避、错误分类、grep 异步化、配置数据版本与迁移
- **阶段四** 产品化：首启向导、token/成本可见、用户文档
- **阶段五** 跨平台：`System` 抽象落地、沙箱按平台降级

详见 [docs/roadmap.md](docs/roadmap.md)。

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
