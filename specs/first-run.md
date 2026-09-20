# 首启向导 — 行为契约

## 背景

gateway **硬要求至少一个上游**，零上游时直接退出（见 `specs/gateway-config.md`）。
所以全新安装（且没有可迁移的既有 gw 配置）时 cTools 装完不能立即用 —— 这是 LLM 应用的固有前提，
但必须让用户**一步就能配好**，而不是把他丢进一个空的 YAML 表单。

## 触发

- `<userData>/gateway.yaml` 的 `providers` 为空。
- 呈现位置：**设置窗顶部「快速开始」区**（仅此时出现；配好后自动消失）。
- Launcher 的引导条（「尚未配置模型上游，网关无法启动」）按钮直达设置，负责把人送到这里。

## 两条路径

### A. 一键使用本机 Ollama（优先展示）

1. 点「检测本机 Ollama」→ 主进程探测 `OLLAMA_BASE_URL`（缺省 `http://localhost:11434`）的 `/v1/models`，**超时 3s**。
2. 可达 → 列出发现的模型，选中一个 → 「使用它」。
3. 写入上游 `ollama`（`type: openai`、`base_url: http://localhost:11434/v1`）+ 别名 `chat`（provider=ollama，model=所选）。
4. 应用（见下）。

- 本机 Ollama **不需要 API key**，所以这条路没有任何密钥困扰 —— 这是它优先展示的原因。
- 探测不可达 → 明确告知（「未检测到本机 Ollama」）并引导走路径 B，**不报错阻塞**。

### B. 手动配置

表单：上游名 / `base_url` / `api_key_env`（环境变量名，可空）/ 模型名 / 别名（默认 `chat`）。
写入后应用。

**`api_key_env` 的已知陷阱（必须在 UI 写明）**：gateway 从**自己的环境**读该变量，而 cTools 以
GUI 方式启动时继承的是登录环境（**不加载 `~/.zshrc`**）。因此：
- 从终端 `npm run dev` 启动时，shell 里 `export` 的变量可见；
- 从 Finder/程序坞启动时**不可见**，需要 `launchctl setenv <VAR> <value>`（或从终端启动 app）。
- UI 必须把这段说明直接摆在 `api_key_env` 输入框旁，而不是只写在文档里。

## 应用语义（写配置之后）

1. 写入 `<userData>/gateway.yaml`（备份 + 校验 + 原子写，同 `gateway-config.md`）。
2. 把 `defaultAlias` 设为向导创建的别名（否则默认别名可能指向不存在的别名）。
3. **若 gateway 未在运行 → 直接拉起**；已在运行 → 按 `reload` 热更。
   - 理由：在网关因零上游而**从未启动**的情况下，`reload` 无从谈起（HTTP 都连不上）。
     保存配置时顺手把网关带起来，是这个场景下唯一合理的语义。
4. 结果反馈：成功 → 「已配置并启动」；启动失败 → 显示 `gateway.log` 的尾部（子进程输出已落盘）。

## 边界与失败

- Ollama 探测超时/不可达 → 提示 + 转手动，不阻塞。
- `base_url` 为空 → 拒绝（前端校验 + 后端 `validateGwConfig` 兜底）。
- 别名与既有别名重名 → 覆盖（用户显式选择的结果）。
- 应用后 gateway 仍未就绪 → 明确告知失败与原因，不假装成功。

## 安全约束

- 不接收、不存储、不回显任何**真实密钥**；只接收环境变量名（与 `gateway-config.md` 一致）。
- 探测仅访问**本机** Ollama 地址，不引入新的外传路径。
