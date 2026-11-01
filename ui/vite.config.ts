import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Served from 127.0.0.1, so one bundle of React and CodeMirror is fine.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    // `npm run dev:ui` needs `n8nt ui` running on its default port for the API.
    // changeOrigin sends the Host that server accepts.
    proxy: { '/api': { target: 'http://127.0.0.1:4567', changeOrigin: true } },
  },
});
