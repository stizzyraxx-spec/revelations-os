import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser build of the Revelations OS renderer, served from the RaxxWare box at
// https://code.raxxware.com/os/ . electron-vite is desktop-only, so the renderer
// gets a plain Vite config here; the main and preload processes are not built.
//
// Same-origin with the shell gateway on purpose. The gateway sends
// `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so RaxxWare can
// only be framed from its own origin — and its session cookie stays first-party,
// which third-party cookie blocking would otherwise break.
//
// Apps that still need Electron in this target degrade rather than crash:
// RAXXAppViewer falls back to an iframe, while Ephesians (the browser) and the
// Music player are <webview>-only and will render empty. They are desktop
// features; nothing here throws.
export default defineConfig({
  root: 'src/renderer',
  base: '/os/',
  plugins: [react()],
  assetsInclude: ['**/*.glb'],
  build: {
    outDir: '../../out/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // three, pdfjs and xlsx are large and change rarely — splitting them out
        // keeps the app chunk small enough to re-download cheaply on each deploy.
        manualChunks: {
          three: ['three'],
          docs: ['pdfjs-dist', 'xlsx', 'mammoth', 'jspdf'],
        },
      },
    },
  },
})
