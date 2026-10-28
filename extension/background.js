// MeetLoaf Router for Firefox. Meeting links are redirected, before the Meet
// page can load and grab the camera and mic, to our own handoff.html, which
// launches meet:// and counts down before tidying the tab away (the same
// screen as the Chrome extension's).

const MEET_URL_RE = /^https?:\/\/meet\.google\.com\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|\?|$)/i;

async function getEnabled() {
  const r = await browser.storage.local.get('enabled');
  return typeof r.enabled === 'boolean' ? r.enabled : true;
}

browser.action.onClicked.addListener(async () => {
  const enabled = !(await getEnabled());
  await browser.storage.local.set({ enabled });
  updateBadge(enabled);
});

function updateBadge(enabled) {
  const title = enabled ? 'MeetLoaf Router (enabled)' : 'MeetLoaf Router (disabled)';
  browser.action.setTitle({ title });
  browser.action.setBadgeText({ text: enabled ? '' : 'off' });
  browser.action.setBadgeBackgroundColor({ color: '#888' });
}

getEnabled().then(updateBadge);

// Tabs the user chose to "join in the browser". Kept in storage.session so it
// survives the background page being suspended, but not a browser restart.
// Scoped by tab rather than a URL marker because Meet bounces through its own
// redirects (sign-in, authuser, …) which would drop a marker.
async function allowedTabs() {
  const r = await browser.storage.session.get('allowedTabs');
  return new Set(r.allowedTabs || []);
}
async function allowTab(tabId) {
  const set = await allowedTabs();
  set.add(tabId);
  await browser.storage.session.set({ allowedTabs: [...set] });
}
async function disallowTab(tabId) {
  const set = await allowedTabs();
  if (set.delete(tabId)) await browser.storage.session.set({ allowedTabs: [...set] });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'allow-in-tab' || !sender.tab) return;
  return allowTab(sender.tab.id).then(() => ({ ok: true }));
});

browser.tabs.onRemoved.addListener((tabId) => { disallowTab(tabId); });

browser.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.type !== 'main_frame') return {};
    const match = details.url.match(MEET_URL_RE);
    if (!match) return {};
    if (!(await getEnabled())) return {};
    if ((await allowedTabs()).has(details.tabId)) return {};
    return { redirectUrl: browser.runtime.getURL('handoff.html') + '#' + match[1].toLowerCase() };
  },
  { urls: ['*://meet.google.com/*'] },
  ['blocking']
);
