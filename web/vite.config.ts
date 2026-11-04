import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // 开发时前端请求转发到本地后端（npm run dev:server，默认 8090）
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:8090', changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 2500 },
});
