import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  resolve: {
    alias: {
      // The UI shares the server's types and a few pure helpers. Now that apps
      // live several directories deep, importing them relatively would mean
      // five levels of `../` in files that are otherwise easy to read.
      '@core': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:ui` talks to a workspace started separately with `curlapi`.
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/ws': { target: 'ws://127.0.0.1:7317', ws: true },
    },
  },
});
