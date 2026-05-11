const MEET_URL_RE = /^https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|\?|$)/i;
const BLANK_URL_RE = /^(about:blank|about:newtab|about:home)?$/;

let enabled = true;

browser.storage?.local.get('enabled').then((r) => {
  if (typeof r.enabled === 'boolean') enabled = r.enabled;
  updateBadge();
});

browser.action.onClicked.addListener(async () => {
  enabled = !enabled;
  await browser.storage.local.set({ enabled });
  updateBadge();
});

function updateBadge() {
  const title = enabled ? 'MeetLoaf Router (enabled)' : 'MeetLoaf Router (disabled)';
  browser.action.setTitle({ title });
  browser.action.setBadgeText({ text: enabled ? '' : 'off' });
  browser.action.setBadgeBackgroundColor({ color: '#888' });
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!enabled) return;
    if (details.type !== 'main_frame') return;

    const match = details.url.match(MEET_URL_RE);
    if (!match) return;

    const deepLink = `meet://meet.google.com/${match[1]}`;

    (async () => {
      try {
        const tab = await browser.tabs.get(details.tabId);
        const prev = tab.url || '';
        await browser.tabs.update(details.tabId, { url: deepLink });
        if (BLANK_URL_RE.test(prev)) {
          setTimeout(() => {
            browser.tabs.remove(details.tabId).catch(() => {});
          }, 600);
        }
      } catch {
        browser.tabs.update(details.tabId, { url: deepLink }).catch(() => {});
      }
    })();

    return { cancel: true };
  },
  { urls: ['*://meet.google.com/*'] },
  ['blocking']
);
