# cTools 后续计划：从 MVP 到可发布

> **MVP 阶段已结束**（主流程贯通 + 长期记忆/上下文工程 + 完整工具面 + 四层测试）。
> 本文是"非 MVP"（**可分发、稳定日用、有回归门禁、面向他人**）的路线图，按依赖排序，每个阶段附**可核验的验收证据**。
>
> 规范以 `AGENTS.md` 为准；架构不变量见 `docs/architecture.md`；行为契约在 `specs/`。

---

## 0. 当前基线（已完成，可逐条核验）

| 能力 | 核验方式 |
|---|---|
| 命令注册表驱动一切（Launcher 联想 / agent 工具 / 设置启停同源） | `npm run test` 的 `registry` / `quickRun` |
| agent runtime 内化于 Main（事件溯源会话 + 工具分发 + 人工在环） | `tests/e2e.test.ts`、`tests/agent.test.ts` |
| 长期记忆（jsonl 事实源 + `MEMORY.md` 索引常驻 + 按需召回 + pinned） | `specs/memory.md`、`tests/memory.test.ts` |
| 上下文工程（token 计量、环境注入、摘要+合并、大结果外置） | `specs/context.md`、`specs/system-prompt.md` |
| 工具面（file 全套 + `file_edit` + `grep` + `find_file` + `office_read` + `bash` + `web_search` + 记忆 + `ask`） | `specs/file-*.md`、`specs/grep.md`、`specs/ask.md` |
| 安全模型（file_roots + realpath 守卫 + OS 沙箱禁网 + confirm 闸门 + 白名单兜底） | `specs/bash.md`、`specs/file-tools.md`、`tests/pathGuard.test.ts`、`tests/shellSandbox.test.ts` |
| 四层测试：单测 / 运行时 e2e / **黄金集** / UI e2e | `npm run test` 共 **293**（其中黄金集 22，可单跑 `npm run test:golden`）· `npm run test:ui` **26** |

**当前版本**：`package.json` `0.1.0`。**定位**：个人工具，尚未打包分发。

---

## 阶段一：可发布骨架（分发）—— 基本完成

**目标**：产出可安装产物，版本可追溯。

| # | 任务 | 状态 |
|---|---|---|
| 1.1 | 接入 `electron-builder` | ✅ `26.15.3`；`mac.target = zip`（`arm64` + `x64`）；`files` 只含 `out/` 与 `package.json`（依赖已被 electron-vite 打进 bundle，无需随包 `node_modules`） |
| 1.2 | 应用标识与图标 | ✅ `appId=com.ctools.app`、`productName=cTools`；`scripts/make-icon.mjs` 无依赖生成 `build/icon.{png,icns}`（`npm run icon`），已随包（`Contents/Resources/icon.icns`） |
| 1.3 | 生产构建校验 | ✅ 产物**启动验证通过**：解压 zip → 启动 `cTools.app` → 进程存活无崩溃、runtime 正常写 userData；`app.asar` 内 `out/main/index.js` 与动态 chunk `pdf-*.js` 均在 |
| 1.4 | 版本策略 | ✅ `package.json.version` 为唯一源；新增 `CHANGELOG.md`（Keep a Changelog，含 0.1.0 基线条目） |
| 1.5 | 代码签名 + 公证 | ⏸ **阻塞：需你自备 Apple Developer 账号**（`electron-builder` 已报 `0 valid identities`，产出为未签名包） |
| 1.6 | 自动更新 | ⏸ 延后（`zip` + `blockmap` 已生成，具备接 `electron-updater` 的基础） |

**产物**（`npm run dist`）：`dist/cTools-0.1.0-arm64-mac.zip`、`dist/cTools-0.1.0-mac.zip`（x64）+ 各自 `.blockmap`

**验收（已跑通）**
```sh
npm run dist                                   # 产出 zip
unzip -t dist/cTools-0.1.0-arm64-mac.zip       # 完整性 OK
ditto -x -k dist/cTools-0.1.0-arm64-mac.zip /tmp/x
CTOOLS_USER_DATA=/tmp/u /tmp/x/cTools.app/Contents/MacOS/cTools   # 启动存活、无崩溃
```

**未做 .dmg 的原因（环境约束）**：dmg 目标需下载 `dmg-builder` 辅助二进制，它**只在 GitHub Releases 分发**；本机到 GitHub 的连接不稳定（实测 `getaddrinfo ENOTFOUND github.com`，且 release 对象 25s 收 0 字节），npmmirror 无该路径。
**取舍**：`zip`（含 `.app`）本身即完整交付物，且是未来自动更新所需格式 → 默认目标收敛为 `zip`；`npm run dist:dmg` 保留 dmg 目标，待网络可用时使用。

**Electron 二进制镜像**：已在 `build.electronDownload.mirror` 指向 `https://npmmirror.com/mirrors/electron/`（否则同样卡在 GitHub）。如需换源，改这一处即可。

**风险（仍待观察）**：`pdfjs-dist` 是动态 `import`（构建产物为独立 chunk）——asar 内该 chunk 存在已确认，但**实际解析 PDF** 需真实文档验证（当前未做）。

---

## 阶段二：回归门禁（CI）

**目标**：改动即回归，防止已修行为回退。

| # | 任务 | 说明 |
|---|---|---|
| 2.1 | GitHub Actions 工作流 | `on: [push, pull_request]`；job 分 `typecheck` / `unit+golden` / `build` / `ui-e2e` |
| 2.2 | 依赖缓存 | 缓存 `~/.npm`；`npm ci` 保证锁文件生效 |
| 2.3 | 分支保护 | `master` 要求 CI 通过才可合并；禁止直推（**与当前"直推 master"习惯不同，需你确认**） |
| 2.4 | 失败可诊断 | UI e2e 失败时上传 trace/截图 artifact |

**验收**：一个故意引入失败的 PR 被 CI 拦住；全绿 PR 的正常合并路径跑通。

**约束（重要）**：UI e2e 驱动**真实 Electron**，且应用依赖 macOS 专有能力（`pbcopy` / `mdfind` / `sandbox-exec`）→ **只能在 `macos-latest` runner 上跑**（成本约为 Linux runner 的 10 倍）。建议：`typecheck + unit + golden` 在 Linux runner 跑（快、便宜），`ui-e2e` 仅在 `macos-latest` 且只在 PR 到 `master` 时触发。

---

## 阶段三：稳定日用（健壮性 / 性能）

**目标**：连续日用不掉链子。

| # | 任务 | 说明 |
|---|---|---|
| 3.1 | gateway 重试与退避 | **只对幂等请求**（`models`、非流式 `chat`）重试（指数退避 + 抖动）；4xx 不重试。**流式请求不盲目重试**——首个 SSE chunk 到达后可能已产生副作用或计费 |
| 3.2 | 错误分类与呈现 | 区分「网络不可达 / 认证失败 / 模型不存在 / 上游 5xx」，给出可操作提示（而非统一 `执行失败: <原始错误>`） |
| 3.3 | grep 异步化 | `readdirSync`/`readFileSync` 改 `fs/promises`，分批 `await` 让出事件循环 + 支持 `AbortSignal`。**当前实现同步遍历会阻塞主进程**（5000 文件上限只是兜底） |
| 3.4 | 数据版本与迁移 | `config.json` 加 `schemaVersion` + 迁移函数；`sessions/`（事件溯源）天然向后兼容，无需迁移 |
| 3.5 | 会话文件完整性 | 启动/加载时校验 JSONL 末行完整性（崩溃可能留下半行）；坏行跳过策略已有（`listSessions`），补齐 `fromJSONL` |
| 3.6 | 长会话可用性 | 验证多轮长会话下压缩/摘要的实际表现（现有单测+黄金集覆盖语义，缺**真实长会话**观测） |

**验收**
```sh
npm run test && npm run test:golden
# 新增：重试/退避、错误分类、grep 异步（含 AbortSignal）、config 迁移 各自的单测
# 手工：断开 gateway 后连续操作，确认提示可操作且不挂死；大目录 grep 期间 UI 不卡
```

---

## 阶段四：产品化（首启 / 成本可见 / 文档）

**目标**：他人拿到也能装起来用。

| # | 任务 | 说明 |
|---|---|---|
| 4.1 | 首启向导 | 三步：填 gateway 地址 → **测连通**（调 `models` 并展示别名）→ 选 `file_roots`；现有首启引导条（Launcher 顶部）作为轻量兜底 |
| 4.2 | token / 成本可见 | 从网关响应的 `usage` 字段累计；`UsageStore` 目前只记命令 MRU，扩展为「按会话/按天」统计，Settings 展示 |
| 4.3 | 用户文档 | 新增 `docs/guide.md`：安装、首次配置、命令参考、隐私与安全边界、常见问题（README 保持概览定位） |
| 4.4 | 更新与回滚说明 | 版本升级、配置备份（`userData` 目录说明）、数据清理 |

**验收**：在一台**干净机器**（无 node_modules、无既有 config）上走通：安装 → 向导 → 首个命令 → agent 对话。

---

## 阶段五：跨平台

**目标**：脱离 macOS 独占（**当前所有系统集成都是 macOS 专有**）。

| # | 任务 | 说明 |
|---|---|---|
| 5.1 | `System` 抽象落地 | `src/main/system.ts` 已有接口，但只有 `MacSystem`；补 `LinuxSystem` / `WindowsSystem`（`pbcopy` → `xclip`/`clip`；`mdfind` → 复用 `grep` 的遍历或 `fd`/`rg`） |
| 5.2 | 沙箱策略按平台降级 | `sandbox-exec` 是 macOS 独有。沿用现有先例——**`shellSandbox.ts` 在沙箱不可用时拒绝执行而非静默降级**；Linux 可接 `bwrap`，Windows 无等价 → bash 工具在无沙箱平台**默认禁用**并明示原因 |
| 5.3 | 平台探测与能力声明 | 启动时探测可用能力（沙箱/剪贴板/搜索），Settings 展示"本机可用能力"，未支持项**显式置灰**而非运行时报错 |

**验收**：Linux（至少一种发行版）上：Launcher / quick 命令 / agent 对话 / file 工具可用；`bash` 在无可用沙箱时**拒绝执行并说明**。

---

## 已知约束与风险（汇总）

| 约束 | 影响 | 应对 |
|---|---|---|
| **GitHub 通道不稳定**（DNS 解析失败 / release 对象 0 字节） | Electron 二进制与 `dmg-builder` 等辅助二进制默认从 GitHub 拉取 → 构建卡死 | 已用 `electronDownload.mirror` 指向 npmmirror；`dmg-builder` 无镜像 → dmg 暂缓（见阶段一） |
| Apple 签名/公证需付费开发者账号 | 未签名分发的用户会遇 Gatekeeper 拦截 | 阶段 1.5 前置确认；未签名则在用户文档明确说明 |
| UI e2e 只能在 macOS runner | CI 成本高 | 拆分 job，ui-e2e 仅在必要时触发（阶段二） |
| 沙箱为 macOS 独有 | 跨平台安全边界不等价 | 能力探测 + 显式拒绝（阶段五） |
| 流式请求不可盲目重试 | 重试可能重放副作用/重复计费 | 只重试幂等请求（阶段三 3.1） |
| `pdfjs` 动态 chunk + asar | 打包后可能加载失败 | 打包后专项验证（阶段一 1.3） |

---

## 版本与发布节奏（建议）

| 版本 | 里程碑 | 判定 |
|---|---|---|
| `0.1.0` | 当前（MVP 结束） | — |
| `0.5.0` | 阶段一 + 二完成 | 能给自己装、有 CI 门禁（**阶段一主体已完成**，待签名 + CI） |
| `0.9.0` | 阶段三完成 | 可连续日用、数据可迁移 |
| `1.0.0` | 阶段四完成 | 他人可独立安装使用（仍限 macOS） |
| `1.x` | 阶段五完成 | 跨平台 |

---

## 已废弃的旧计划（本节保留仅为对照）

早期 roadmap 中的以下条目**均已完成**，不再列为待办：全局热键与窗口管理、Settings UI、gateway 管理落地、上下文压缩、会话持久化/续聊、agent 工具白名单、命令迁移（clipboard/file/office）。

其中两处**旧表述已被实现推翻**，以现行 spec 为准：
- 「默认每次打开即新会话（不自动续上次）」→ 现已支持**显式续聊**（Launcher 最近会话 + Chat「＋新会话」，见 `specs/session-resume.md`）。
- 「file 写/删**非 agentTool**」→ 现已**开放给 agent**，但破坏性操作**恒过 confirm 闸门**（见 `specs/file-tools.md`）。
