import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5273, host: '127.0.0.1' },
  preview: { port: 5273, host: '127.0.0.1' },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
