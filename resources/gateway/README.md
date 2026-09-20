# 内嵌 gateway 二进制

cTools **自带** gateway 服务端，安装后无需再单独安装任何东西（见 `specs/gateway-config.md`）。
本目录的二进制由 electron-builder `extraResources` 打进 `Contents/Resources/gateway/`。

## 为什么提交进仓库

对端用户装完即用，不依赖其机器上有 Go 工具链或源码仓库。代价是仓库体积（两个架构约 83MB），
这是明确的取舍。

## 溯源（provenance）

| 项 | 值 |
|---|---|
| 源码仓库 | 本地 gateway 源码（`cmd/gateway`） |
| 源 commit | `f875f572dd980aef00b993b68ac794cce5855010` |
| 构建命令 | `CGO_ENABLED=0 GOOS=darwin GOARCH=<arch> go build -trimpath -o <out> ./cmd/gateway` |
| Go 版本 | go1.26.6 darwin/arm64 |

两个架构**由同一 commit、同一组参数构建**，避免版本漂移（早期内嵌的 arm64 来自另一次构建，
与 x64 不同源）。

## 校验

```sh
node scripts/verify-gateway-bin.mjs      # 比对 sha256 与预期一致
```

预期摘要见 `checksums.txt`。**替换二进制后必须更新该文件**，否则 CI/校验会失败。

## 平台支持

当前仅 macOS（`darwin-arm64` / `darwin-x64`）。其它平台需要各自交叉编译后放入
`<平台>-<架构>/gateway` 目录——代码按 `process.platform`-`process.arch` 解析（见 `src/main/index.ts`）。
