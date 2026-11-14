import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    strictPort: true,
    proxy: {
      '/config.json': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080',
    },
  },
});
