import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src'),
      // main 进程模块在测试环境下用 electron 桩（safeStorage/app.getPath 等）
      electron: resolve(__dirname, 'test/stubs/electron.ts')
    }
  },
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000
  }
})
