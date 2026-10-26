const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveTest', {
  startCapture: () => ipcRenderer.invoke('wechat-live:start-capture'),
  stopCapture: () => ipcRenderer.invoke('wechat-live:stop-capture'),
  close: () => ipcRenderer.invoke('wechat-live:close')
});
