import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base: './',
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  server: {
    host: host || '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebView2 is Chromium-based on Windows; safari14 only for macOS builds.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    cssCodeSplit: true,
    modulePreload: {
      polyfill: false
    },
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return;
          }
          if (id.includes('@milkdown') || id.includes('prosemirror') || id.includes('/katex')) {
            return 'milkdown';
          }
          if (
            id.includes('@codemirror') ||
            id.includes('codemirror') ||
            id.includes('@lezer') ||
            id.includes('/crelt') ||
            id.includes('/style-mod') ||
            id.includes('/w3c-keyname')
          ) {
            return 'codemirror';
          }
          if (id.includes('highlight.js')) {
            return 'hljs';
          }
          if (id.includes('@tauri-apps')) {
            return 'tauri';
          }
        }
      }
    }
  },
  test: {
    environment: 'jsdom'
  }
});
