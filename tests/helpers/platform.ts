// 平台能力探测（供测试门控）。
// `sandbox-exec` 是 macOS 专有；其它平台按其缺失处理 —— cTools 的设计是「沙箱不可用则拒绝执行」，
// 所以依赖它的用例只在该能力存在时才有意义（CI 的 Linux job 会跳过，而不是失败）。

import { execFileSync } from 'node:child_process'

/**
 * 本机是否真的能用 sandbox-exec。
 * 用**探测**而非 `process.platform === 'darwin'`：平台判断在「PATH 里没有 sandbox-exec」时
 * 会给出错误答案（既会误判本机，也让测试无法模拟该情形验证门控是否生效）。
 */
export const HAS_SANDBOX = (() => {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** 门控说明，附在 skip 的用例上，便于看日志的人理解为什么跳过。 */
export const SANDBOX_SKIP_REASON = 'sandbox-exec 仅 macOS 提供；该平台按设计拒绝执行 shell 命令'
