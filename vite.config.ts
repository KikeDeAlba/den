import { defineConfig } from 'vite'

const host = process.env['TAURI_DEV_HOST']

export default defineConfig({
  clearScreen: false,
  build: {
    target: ['es2022', 'safari16', 'chrome111', 'firefox115'],
    rollupOptions: {
      input: { index: 'index.html', notas: 'notas.html', live: 'live.html', 'live-wide': 'live-wide.html', reportes: 'reportes.html' },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    ...(host === undefined ? {} : { hmr: { protocol: 'ws', host, port: 1421 } }),
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
