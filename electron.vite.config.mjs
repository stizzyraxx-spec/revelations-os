import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The main process is CommonJS, so Rollup leaves `require('./platform-win')`
        // as-is rather than inlining it. Emit it as its own entry so the file
        // actually exists next to index.js in the packaged app.
        input: {
          index: 'src/main/index.js',
          'platform-win': 'src/main/platform-win.js',
        },
      },
    },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    assetsInclude: ['**/*.glb'],
  }
})
