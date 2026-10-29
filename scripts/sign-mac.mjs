import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(process.env.RAMBO_APP_PATH ?? 'dist/mac-arm64/Rambo.app');
if (!existsSync(app)) throw new Error(`候选应用不存在：${app}`);

execFileSync('/usr/bin/codesign', [
  '--force',
  '--deep',
  '--sign',
  '-',
  '--timestamp=none',
  app
], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', [
  '--verify',
  '--deep',
  '--strict',
  app
], { stdio: 'inherit' });
console.log(`已重封候选应用：${app}`);
