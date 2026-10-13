import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths so the built game works from any folder (e.g. GitHub Pages at /fairway-ledgends/)
  base: './',
  server: { port: 5180, open: false },
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
});
