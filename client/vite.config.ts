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
})
