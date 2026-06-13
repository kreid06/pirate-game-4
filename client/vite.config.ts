import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  base: '/pirate-game-4/',
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
      '@engine': path.resolve(process.cwd(), 'src/engine'),
      '@sim': path.resolve(process.cwd(), 'src/sim'),
      '@net': path.resolve(process.cwd(), 'src/net'),
      '@common': path.resolve(process.cwd(), 'src/common'),
      '@tools': path.resolve(process.cwd(), 'src/tools'),
    },
  },
  server: {
    proxy: {
      /* Forward /admin/* → local admin server so the world editor works in dev
       * without CORS issues. The admin server always binds to 127.0.0.1:8081. */
      '/admin': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/admin/, ''),
      },
    },
  },
})
