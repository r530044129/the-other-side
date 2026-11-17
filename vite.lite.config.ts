import { defineConfig } from 'vite';

// Test build of the phone branch (mobile-lite-20261117), served at <base>/lite/.
// Same public files as the main site, plus public/m/ (the light copies the phone loads).
const base = (process.env.PAGES_BASE ?? '/') + 'lite/';

export default defineConfig({
  root: 'lite',
  base,
  publicDir: '../public',
  resolve: {
    dedupe: ['three'],
  },
  build: {
    target: 'esnext',
    outDir: '../dist/lite',
    emptyOutDir: true,
  },
});
