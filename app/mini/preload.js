const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  restore: () => ipcRenderer.send('mini:restore'),
  toggleMute: () => ipcRenderer.send('mini:toggle-mute'),
  toggleCamera: () => ipcRenderer.send('mini:toggle-camera'),
  onStatus: (cb) => ipcRenderer.on('mini:status', (_e, payload) => cb(payload)),
  onFrame: (cb) => ipcRenderer.on('mini:frame', (_e, dataUrl) => cb(dataUrl)),
  onClear: (cb) => ipcRenderer.on('mini:clear', () => cb())
});
