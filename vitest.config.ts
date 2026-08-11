import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src'),
      // main 进程模块在测试环境下用 electron 桩（safeStorage/app.getPath 等）
      // 顺序要紧：更具体的 'electron-log/main' 必须排在 'electron' 前面
      'electron-log/main': resolve(__dirname, 'test/stubs/electronLog.ts'),
      electron: resolve(__dirname, 'test/stubs/electron.ts')
    }
  },
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/renderer/**/*.test.ts',
      // 组件测试：文件头用 `@vitest-environment jsdom` 按文件切环境，默认仍是 node
      'test/component/**/*.test.tsx'
    ],
    environment: 'node',
    // 对 node 环境的文件是受 typeof window 守卫的 no-op
    setupFiles: ['./test/component/setup.ts'],
    environmentOptions: {
      // rc-motion / antd message 依赖 requestAnimationFrame
      jsdom: { pretendToBeVisual: true }
    },
    testTimeout: 30000
  }
})
