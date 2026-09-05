// Vitest（单元 + 运行时 e2e）。UI e2e 归 Playwright（tests/ui），互不干扰。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/ui/**', 'node_modules/**', 'out/**'],
  },
})
