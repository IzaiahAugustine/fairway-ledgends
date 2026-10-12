import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, open: false },
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
});
