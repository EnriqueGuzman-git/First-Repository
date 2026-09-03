import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],

  root: 'src/client',

  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },

  resolve: {
    alias: {
      '@ttt/shared/protocol': fileURLToPath(
        new URL('./src/shared/protocol/index.ts', import.meta.url),
      ),
    },
  },

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
