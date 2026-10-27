import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireElectronFixtureLease } from './tests/e2e/fixtures/electron-app.mjs';

const acceptanceRuns = join(import.meta.dirname, 'acceptance-runs');
if (!process.env.RAMBO_ELECTRON_FIXTURE_LEASE) {
  mkdirSync(acceptanceRuns, { recursive: true });
  const releaseElectronLease = acquireElectronFixtureLease(acceptanceRuns);
  process.env.RAMBO_ELECTRON_FIXTURE_LEASE = String(process.pid);
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseElectronLease();
  };
  process.once('exit', releaseOnce);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      releaseOnce();
      process.kill(process.pid, signal);
    });
  }
}

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
