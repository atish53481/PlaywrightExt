import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever talks to the Vite origin; /api is proxied to the server,
// so cookies are same-origin and no CORS is involved in development.
export default defineConfig(({ mode }) => {
  // APP_PORT is read from the one .env beside the workspace root, so the proxy
  // follows the server when its port is changed there.
  const { APP_PORT = '3000' } = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'APP_');
  return {
    plugins: [react()],
    server: {
      // 5173 is Vite's default, so any other Vite project takes it first. strictPort
      // makes a taken port an error instead of a silent move to the next one.
      port: 5180,
      strictPort: true,
      proxy: { '/api': process.env.VITE_API_TARGET ?? `http://127.0.0.1:${APP_PORT}` },
    },
  };
});
