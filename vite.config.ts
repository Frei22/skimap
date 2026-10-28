import { defineConfig } from 'vite';

// `base: './'` keeps the build portable: it works from a sub-path (GitHub Pages) or a domain root.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
