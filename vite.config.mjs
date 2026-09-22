import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // Keep rarely-changing vendor code in separate chunks so the app chunk stays small
        // and the browser can cache vendors across Nightly builds.
        manualChunks: {
          react: ['react', 'react-dom'],
          markdown: ['react-markdown', 'remark-gfm'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
