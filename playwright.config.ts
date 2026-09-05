import { defineConfig } from '@playwright/test'

// UI e2e：真实 Electron（out/ 构建产物）↔ mock gateway。大改动后跑 `npm run test:all` 回归。
export default defineConfig({
  testDir: './tests/ui',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // Electron app 串行启动，避免热键/userData 互相干扰
  reporter: [['list']],
})
