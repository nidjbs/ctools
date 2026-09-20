> 本文件是 Release 正文模板（由 `.github/workflows/release.yml` 引用）。发版前按当次版本更新，
> 并确保与 `CHANGELOG.md` 的对应条目一致。

## 下载

| 你的 Mac | 文件 |
|---|---|
| Apple 芯片（M 系列） | `cTools-*-arm64-mac.zip` |
| Intel | `cTools-*-mac.zip` |

解压后把 `cTools.app` 拖进「应用程序」。

## ⚠️ 未签名，首次打开需手动放行

本版本**未做代码签名与公证**（需要 Apple Developer 账号，尚未配置）。macOS 会以「无法验证开发者」为由拦截，两种放行方式：

1. 右键点 `cTools.app` → **打开** → 在弹窗里再点「打开」（只需一次）
2. 或执行：`xattr -d com.apple.quarantine /Applications/cTools.app`

**只从本页面下载**——放行未签名应用有风险，不要对来源不明的副本这么做。

## 首次使用

cTools 自带模型网关，但**需要一个模型上游**才能真正干活。首次打开设置（Launcher 空态列表末尾的「⚙️ 设置」行，或菜单栏 `cTools → 设置…`）会看到「快速开始」：

- **推荐**：一键检测本机 [Ollama](https://ollama.com)，选一个模型即可——不需要任何 API key
- 或者手填一个上游（`base_url` + 模型名）

> `api_key_env` 填的是**环境变量名**，不是密钥本身；且 gateway 读的是**它自己进程**的环境——从访达启动的 app 不加载 `~/.zshrc`，需要用 `launchctl setenv`。设置页里写明了这一点。用本机 Ollama 则完全绕开这个问题。

接着回到 Launcher，空态会引导你**选择一个可访问目录**（`file_roots`）——文件工具与 `bash` 都以它为界，未配置时这些能力不可用（这是有意的：不默认放行整个文件系统）。

## 安全边界（请知悉）

- 文件操作限定在你自己选定的目录内；写/删/执行 shell **每次都要你批准**
- 剪贴板敏感内容只走你指定的本地模型别名
- 联网搜索默认关闭；`bash` 默认经 OS 沙箱禁网
- 所有对话以事件流完整落盘，可回看（`~/Library/Application Support/cTools/sessions/`）

## 已知限制

- 仅支持 macOS
- 未签名（见上）
- gateway 调用暂无重试；`grep` 为同步遍历，超大目录会短暂占用主进程

详见 [CHANGELOG](CHANGELOG.md) 与 [docs/guide.md](docs/guide.md)。
