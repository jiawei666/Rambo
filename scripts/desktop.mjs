import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// 终端的 Node 参数不一定受 Electron 支持；只清理本次桌面进程的环境。
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [resolve('node_modules/electron-vite/bin/electron-vite.js'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
