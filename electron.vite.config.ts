import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      // Bundle the engine's dependencies so the packaged app needs no node_modules.
      // The parser .wasm files ship separately as resources (see "extraResources" in package.json).
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          worker: resolve(__dirname, 'electron/worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      minify: true,
      chunkSizeWarningLimit: 6000,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
