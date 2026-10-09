// Toolbar popup: an explicit on/off switch. Clicking the icon used to flip
// routing silently, which was easy to do by accident — and in browsers that
// hide the toolbar (Arc), the "off" badge was never seen, so routing just
// looked broken. The background service worker applies the change via
// storage.onChanged.

const $ = (id) => document.getElementById(id);

function paint(enabled) {
  $('enabled').checked = enabled;
  $('status').textContent = enabled
    ? 'On — meeting links open in the app.'
    : 'Off — meeting links open in this browser.';
  $('status').classList.toggle('off', !enabled);
}

$('enabled').addEventListener('change', async (e) => {
  paint(e.target.checked);
  await chrome.storage.local.set({ enabled: e.target.checked });
});

(async () => {
  const r = await chrome.storage.local.get('enabled');
  paint(typeof r.enabled === 'boolean' ? r.enabled : true);
})();
