import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
  build: {
    // Each lab is a lazy route → its own chunk. React gets a separate long-cached vendor chunk.
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom'] } },
    },
    reportCompressedSize: true,
  },
});
