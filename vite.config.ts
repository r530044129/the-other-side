import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  resolve: {
    dedupe: ['three'],
  },
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: false,
  },
  build: {
    target: 'esnext',
  },
});
