import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'wechat-worker': 'src/main/wechat-worker.ts'
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
});
