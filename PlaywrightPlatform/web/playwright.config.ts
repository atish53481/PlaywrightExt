import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run e2e:serve -w server',
      cwd: '..',
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w web -- --port 5174 --strictPort',
      cwd: '..',
      url: 'http://localhost:5174',
      env: { VITE_API_TARGET: 'http://127.0.0.1:3100' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
