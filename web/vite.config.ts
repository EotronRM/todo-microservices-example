import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The gateway sends no CORS headers, so the browser calls /api on this origin
  // and Vite forwards it. In Docker, nginx does the same (see nginx.conf.template).
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});
