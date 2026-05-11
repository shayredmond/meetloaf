// Tiny preload for the main MeetLoaf (Meet) window.
// Bridges Page Visibility API events to main process so we can show/hide
// the mini-mode window when the main window becomes occluded, minimized,
// hidden via Cmd+H, or sent to a different Space.
const { ipcRenderer } = require('electron');

function send() {
  ipcRenderer.send('main:visibility', document.visibilityState);
}

document.addEventListener('visibilitychange', send);
window.addEventListener('pageshow', send);
window.addEventListener('load', send);

// Bridge for the injected content script: it can't reach IPC directly
// (different JS world under contextIsolation), so it postMessages to us
// and we forward to main. Origin check is loose because Meet uses several
// google.com subdomains internally.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.source !== 'meetloaf-injected') return;
  if (e.data.type === 'open-settings') {
    ipcRenderer.send('main:open-settings');
  }
});
