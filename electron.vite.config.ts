import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    // 沙箱化 preload 必须是单文件 CJS：不 externalize、输出 cjs
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    plugins: [react()],
    /*
     * electron-vite 的 renderer 预设把 `minify` 写死成 false（它的理由是"本地文件加载，
     * 压缩省下的只是磁盘"）。对这个项目不成立：产物躺在 asar 里、asar 进安装包，
     * 而实测这一行省 2,305,002 字节（4,560,893 → ≈2.26 MB），asar 从 5.99 MB 降到约 3.7 MB。
     *
     * ⚠️ 删掉这行会让 scripts/checkBundleBudget.mjs 立刻报红（它按"字节/行"认得出没压缩），
     * 那条护栏就是为这行写的 —— 因为单看字节数只会说"超了"，不会说"因为没压缩"。
     * 安装包那一侧的收益要小得多（NSIS 的 LZMA 对空白与长标识符本来就压得好，实测只省 23%），
     * 所以这行的正当性主要在磁盘占用与首帧解析，不在下载体积。
     */
    build: { minify: 'esbuild' },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
