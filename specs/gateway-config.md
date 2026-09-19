# 网关配置编辑（providers / aliases）— 行为契约

## 目标

cTools 一直只保存网关的 URL/token，**从不读写网关自己的配置**；用户要加一个上游、加一个模型别名，只能手编 YAML。
本能力把 `providers` 与 `aliases` 变成 Settings 里的**结构化表单**，改完直接热更。

## 归属：cTools 自己管 gateway

- **内嵌 gateway 二进制**：打包后位于 `Contents/Resources/gateway/<平台>-<架构>/gateway`；开发态取仓库 `resources/`；`GW_GATEWAY_BIN` 可覆盖。**不再依赖外部 `gw` CLI**（原先只用它 `up`/`down`，现在 cTools 直接 spawn）。
- **配置文件由 cTools 自持**：`<userData>/gateway.yaml`。**不再读写 gw 的 `~/.config/gw/gateway.yaml` 或 `~/gw.yaml`。**
  - **首启迁移**：该文件不存在时，按 `GW_GATEWAY_CONFIG` → `~/gw.yaml` → `~/.config/gw/gateway.yaml` 顺序找第一个可解析的，**迁移其 providers/aliases**（不丢用户已有模型）；都找不到则写空模板（**不编造上游**）。
  - 迁移/初始化时由 cTools 覆盖 `listen` / `healthz`（与客户端连接的地址保持一致）、`providers` / `aliases` 兜底为空、并**覆盖 `admin` 块**为 `{ enabled: true, token_env: CTOOLS_GATEWAY_ADMIN_TOKEN }`。
  - `admin` token 只经**环境变量**传给子进程，配置文件里只出现变量名；token 值由 cTools 生成并存在自己的 `config.json`。
  - 迁移后 `~/gw.yaml` 原文件**不动**（cTools 只是复制内容）。
- **进程**：`gateway -config <userData>/gateway.yaml`；pid 落 `<userData>/gateway.pid` 供 `down` 使用。
  - **子进程输出重定向到 `<userData>/gateway.log`**（不用 `stdio:'ignore'`）——gateway 启动失败只会打在自己的 stderr 上，丢弃后外部只剩「未就绪」这种无法自查的现象（实测踩过）。
  - **零上游不启动**：gateway 硬要求至少一个 provider（否则报 `at least one provider is required` 并退出）。
    cTools 在 spawn **之前**检查，直接给出可操作原因（「尚未配置模型上游，请在设置 → 网关配置里添加」），不去白等超时。
  - 因此**首次运行不会凭空可用**：需要用户配置一个上游（或其既有 gw 配置被迁移过来）。Launcher 此时显示「尚未配置模型上游，网关无法启动 → 去配置上游」。

### 配置结构（实测）

```yaml
listen: 127.0.0.1:8080        # 这些**不归本功能管**，原样保留
healthz: 127.0.0.1:8081
auth: { mode: none }

providers:                    # 映射：上游名 → 配置
  ds:
    type: openai
    base_url: https://api.deepseek.com
    request_timeout: 60s
    api_key_env: DEEPSEEK_API_KEY   # ← 存的是**环境变量名**，不是密钥

aliases:                      # 映射：别名 → { provider, model }
  common: { provider: ds, model: deepseek-v4-flash }
```

## 读写规则

### 读（`gateway:config`）
- 返回 `{ path, exists, providers, aliases, error? }`。
- 文件不存在或解析失败 → `exists:false` 或带 `error`，**编辑区禁用**（不让用户在坏文件上叠加改动）。
- 只暴露 `providers` / `aliases` 两块；其余键不在 UI 呈现。

### 写（`gateway:configSave`）
1. **先校验**：providers 每个条目须有 `type` 与 `base_url`；aliases 每个条目的 `provider` 必须指向已存在的上游名；否则拒绝并返回可读原因。
2. **备份**：原文件复制为 `<path>.bak-<时间戳>`（保留最近若干份，避免无限堆积）。
3. **只替换两个键**：`{ ...原文档, providers, aliases }` —— `listen`/`healthz`/`auth` 等**原样保留**（按解析后的对象合并，不丢未知键）。
4. **写前再解析一次**新内容做校验，通过才落盘；落盘用「写临时文件 + rename」避免半截文件。
5. **已知代价**：YAML 往返会**丢失原文件注释**（实测用户配置里有说明性注释）。首次保存前的备份可用于追回。

### 应用
- `保存并热更` → POST `{adminUrl}/admin/reload`（Bearer cTools 自己的 admin token）。
- `保存并重启` → 结束记录的 pid + 重新 spawn（配置不可热更或状态异常时用）。
- 应用失败 → 返回原因；**配置已落盘**这一点必须在 UI 明示（避免用户以为没生效就是没保存）。

## 安全约束

- **in-place 编辑**，可能打断用户网关上正在跑的服务；备份 + 校验 + 原子写是必需项。
- `api_key_env` 只填**环境变量名**；cTools **不存储、不回显**任何真实密钥。
- 写入目标是 cTools 之外的文件（gw CLI 也读它），因此**不做任何隐式迁移**：只动用户显式编辑的两个键。

## 边界与失败

- 文件不可写（权限）→ 返回错误，不静默。
- `providers` 为空 / 别名指向不存在的上游 → 拒绝保存（附具体位置）。
- 磁盘上配置文件在编辑期间被外部改动 → 以保存时的磁盘内容为基线合并（后写覆盖，不做冲突检测；备份可回溯）。
