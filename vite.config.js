import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build runs from any path — including the
  // /NeedForTokens/ subdirectory GitHub Pages serves a project site from.
  base: './',
  server: { port: 5273, host: '127.0.0.1' },
  preview: { port: 5273, host: '127.0.0.1' },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
