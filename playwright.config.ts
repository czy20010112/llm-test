import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: true,
    channel: 'chromium',
    locale: 'zh-CN', // UI 跟随浏览器语言，测试固定中文断言
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3000/api/tasks',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
