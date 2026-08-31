import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxies every API route to the Express server so `npm run dev` gives
// real HMR against a live backend — the old setup only worked via
// `vite build && node server.js`, meaning every CSS or component tweak
// cost a full rebuild and restart.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      '/chat': 'http://localhost:3000',
      '/approve-tool': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/ready': 'http://localhost:3000',
    },
  },
});
