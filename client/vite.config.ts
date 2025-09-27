import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 3000,
    host: true
  },
  resolve: {
    alias: {
      '@': '/src',
      '@common': '/src/common',
      '@client': '/src/client',
      '@sim': '/src/sim',
      '@net': '/src/net'
    }
  }
})