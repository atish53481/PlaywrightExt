import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only ever talks to the Vite origin; /api is proxied to the server,
// so cookies are same-origin and no CORS is involved in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
