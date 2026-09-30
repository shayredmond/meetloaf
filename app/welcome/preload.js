const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('welcome', {
  platform: process.platform,
  dismiss: () => ipcRenderer.send('welcome:dismiss')
});
