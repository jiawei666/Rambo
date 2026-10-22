import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'test-results/playwright-report', open: 'never' }]],
  outputDir: 'test-results/playwright-artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
