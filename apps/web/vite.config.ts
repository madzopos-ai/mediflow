import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5171,
    strictPort: true,
  },
  preview: {
    port: 5171,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
