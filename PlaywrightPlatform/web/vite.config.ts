import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever talks to the Vite origin; /api is proxied to the server,
// so cookies are same-origin and no CORS is involved in development.
export default defineConfig(({ mode }) => {
  // APP_PORT and WEB_PORT are read from the one .env beside the workspace root, so
  // the proxy follows the server, and start.ps1 checks the same web port.
  const { APP_PORT = '3000', WEB_PORT = '5180' } = loadEnv(
    mode,
    fileURLToPath(new URL('..', import.meta.url)),
    ['APP_', 'WEB_'],
  );
  return {
    plugins: [react()],
    server: {
      // 5173 is Vite's default, so any other Vite project takes it first. strictPort
      // makes a taken port an error instead of a silent move to the next one.
      port: Number(WEB_PORT),
      strictPort: true,
      proxy: { '/api': process.env.VITE_API_TARGET ?? `http://127.0.0.1:${APP_PORT}` },
    },
  };
});
