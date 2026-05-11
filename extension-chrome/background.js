// MeetLoaf Router for Chromium-based browsers (Chrome, Arc, Brave, Edge,
// Vivaldi, Opera, etc.). Manifest V3 service worker.
//
// Why webNavigation + tabs.update instead of declarativeNetRequest?
// declarativeNetRequest's redirect target only accepts http/https URLs.
// Custom schemes like meet:// aren't allowed there. webNavigation lets
// us catch the navigation early and switch the tab to a meet:// URL,
// which the OS routes to MeetLoaf.app.

const MEET_URL_RE = /^https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|\?|$)/i;
// "Blank-ish" URLs that mean the tab was just opened (middle-click, etc.)
// and should be cleaned up after the redirect lands in MeetLoaf.
const BLANK_URL_RE = /^(chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|about:blank|edge:\/\/newtab\/?|brave:\/\/newtab\/?|opera:\/\/startpage\/?|)?$/;

let enabled = true;

chrome.storage.local.get('enabled').then((r) => {
  if (typeof r.enabled === 'boolean') enabled = r.enabled;
  updateBadge();
});

chrome.action.onClicked.addListener(async () => {
  enabled = !enabled;
  await chrome.storage.local.set({ enabled });
  updateBadge();
});

function updateBadge() {
  chrome.action.setTitle({
    title: enabled ? 'MeetLoaf Router (enabled)' : 'MeetLoaf Router (disabled)'
  });
  chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#888' });
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (!enabled) return;
  if (details.frameId !== 0) return; // top-level only

  const match = details.url.match(MEET_URL_RE);
  if (!match) return;

  const deepLink = `meet://meet.google.com/${match[1]}`;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    const prev = tab.url || '';
    await chrome.tabs.update(details.tabId, { url: deepLink });
    if (BLANK_URL_RE.test(prev)) {
      setTimeout(() => {
        chrome.tabs.remove(details.tabId).catch(() => {});
      }, 600);
    }
  } catch {
    chrome.tabs.update(details.tabId, { url: deepLink }).catch(() => {});
  }
}, { url: [{ hostEquals: 'meet.google.com' }] });
