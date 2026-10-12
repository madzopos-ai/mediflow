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
    // Temporary diagnostic: ship sourcemaps so the next console stack maps
    // to real files. Revert to false once the whatsapp null crash is found.
    sourcemap: true,
    target: 'es2022',
  },
});
