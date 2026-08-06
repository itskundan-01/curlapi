import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:ui` talks to a capture started separately with `curlapi start`.
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/ws': { target: 'ws://127.0.0.1:7317', ws: true },
    },
  },
});
