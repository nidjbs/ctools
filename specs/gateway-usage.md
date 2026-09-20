# 用量与成本可见（token / cost）— 行为契约

## 目标

让用户看到「花了多少」：请求数、输入/输出 token、成本。

## 数据源：网关自己，不自己算账

- 端点：`GET {adminUrl}/admin/usage/summary?from=<RFC3339>&to=<RFC3339>[&alias=]`，Bearer admin token。
- 响应（snake_case 扁平）：`{requests, successes, failures, streaming, input_tokens, output_tokens, total_tokens, cost_micros, duration_ms}`。
- **不自己解析 SSE 累加**：网关已按 alias/时间聚合，并掌握重试、路由、定价等 cTools 看不到的细节；自己算必然与网关对不上。

## 呈现（设置 → 用量）

- 区间：**今天 / 近 7 天 / 近 30 天**（默认今天），可手动刷新。
- 总量：请求数、失败数、输入/输出/合计 token、成本。
- 明细：按别名（`/v1/models` 返回的别名逐个查，仅列 `requests > 0` 的），按 token 降序。
- 成本为 `—` 表示网关未配置该模型的定价（`cost_micros` 为 0）。**不猜测价格**。

## 关键边界：默认网关查不了用量

网关的默认 usage sink 是 **audit（不可查询）**，此时接口返回 **501 `usage_query_unsupported`**。
这是最常见的情形，因此：

- cTools 必须把它识别为 `unsupported` 而不是笼统报错，并给**可执行的下一步**。
- 提供「**启用用量统计（sqlite）并重启网关**」：在**托管配置**里写入
  `usage: {driver: sqlite, options: {path: <userData>/usage.db}}`（备份 + 校验 + 原子写，不影响其它键），
  然后**重启**网关。
  - 为什么是重启而非热更：usage sink 在启动期装配，`/admin/reload` 改不动它。
  - 重启后若网关未就绪，如实报错（不假装成功）。
- 启用后**新产生**的用量才有记录；历史请求不会补记（网关侧行为，cTools 不做补偿）。

## 失败语义

| 情况 | 表现 |
|---|---|
| 501 | 「网关未启用可查询的用量存储」+ 启用按钮 |
| 401/403 | 「用量查询需要有效的 admin token」并指向设置 → 连接（高级） |
| 连不上网关 | 「连不上网关：<原因>」 |
| 响应无法解析 | 如实报错，不显示假数据 |

## 安全约束

- 只读查询 + 一次显式的本地配置写入；不引入新的外传路径。
- admin token 沿用既有存储（`config.json`），不额外落盘、不回显。
