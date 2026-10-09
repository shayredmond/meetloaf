// Tiny preload for the main MeetLoaf (Meet) window.
const { ipcRenderer } = require('electron');

// Bridge for the injected content script: it can't reach IPC directly
// (different JS world under contextIsolation), so it postMessages to us
// and we forward to main. Origin check is loose because Meet uses several
// google.com subdomains internally.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.source !== 'meetloaf-injected') return;
  if (e.data.type === 'open-settings') {
    ipcRenderer.send('main:open-settings');
  }
  if (e.data.type === 'present-tab') {
    ipcRenderer.send('main:present-tab');
  }
  // Call-phase transitions from the DOM watcher — main turns these into the
  // Home Assistant join/leave events (and gates always-on-top).
  if (e.data.type === 'meeting-phase') {
    ipcRenderer.send('main:meeting-phase', String(e.data.phase || 'unknown'));
  }
});
