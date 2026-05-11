const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('welcome', {
  dismiss: () => ipcRenderer.send('welcome:dismiss')
});
