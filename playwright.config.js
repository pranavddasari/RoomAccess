import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests', workers: 1, use: { baseURL: 'http://localhost:5178', viewport: { width: 390, height: 844 }, browserName: 'chromium', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } },
 webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://localhost:5178', reuseExistingServer: false, env: { VITE_SUPABASE_URL: 'https://membership.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only' } },
});
