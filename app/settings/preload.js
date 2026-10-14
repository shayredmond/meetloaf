const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetloaf', {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (next) => ipcRenderer.invoke('config:save', next),
  listScreens: () => ipcRenderer.invoke('screens:list'),
  onScreensChanged: (fn) => ipcRenderer.on('screens:changed', (_e, displays) => fn(displays)),
  recordingStart: () => ipcRenderer.send('recording:start'),
  recordingStop: () => ipcRenderer.send('recording:stop'),
  resize: (height) => ipcRenderer.send('settings:resize', height),
  showWelcome: () => ipcRenderer.send('welcome:show'),
  getConfigPath: () => ipcRenderer.invoke('config-path:get'),
  chooseConfigPath: () => ipcRenderer.invoke('config-path:choose'),
  resetConfigPath: () => ipcRenderer.invoke('config-path:reset'),
  detectFirefox: () => ipcRenderer.invoke('firefox:detect'),
  installFirefoxExtension: () => ipcRenderer.invoke('firefox:install-extension'),
  detectChrome: () => ipcRenderer.invoke('chrome:detect'),
  showChromeFolder: () => ipcRenderer.invoke('chrome:show-folder'),
  openChromeExtensions: () => ipcRenderer.invoke('chrome:open-extensions'),
  testHomeAssistant: (which) => ipcRenderer.invoke('ha:test', which),
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  requestPermission: (id) => ipcRenderer.invoke('permissions:request', id),
  openPermissionSettings: (id) => ipcRenderer.invoke('permissions:open-settings', id),
  testLocalNetwork: () => ipcRenderer.invoke('permissions:test-local-network')
});
