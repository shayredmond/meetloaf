// MeetLoaf Router for Chromium-based browsers (Chrome, Arc, Brave, Edge,
// Vivaldi, Opera, etc.). Manifest V3 service worker.
//
// Why declarativeNetRequest + a hand-off page?
// The Meet page must never load in the browser: if it does, it grabs the
// camera and mic and you end up in the call twice (browser + MeetLoaf).
// MV3 has no blocking webRequest, and webNavigation.onBeforeNavigate is only
// a notification — the original navigation carries on regardless. DNR is the
// one MV3 mechanism that stops the request before it's sent. Its redirect
// target can't be a custom scheme like meet://, so it redirects to our own
// handoff.html, which launches meet:// and then tidies the tab up.
//
// Backstop: once Meet has been visited, its service worker can answer the
// navigation itself, and requests served that way never pass through DNR. So
// we also watch for a Meet meeting page *committing* in a tab and immediately
// navigate that tab to the hand-off page, which tears the Meet page down
// before it can hold on to the camera. onCommitted (not onBeforeNavigate) so
// it only fires when DNR didn't already catch it.

const RULE_REDIRECT = 1;
const RULE_ALLOW_COMPANION = 2;
// Per-tab "join in the browser instead" exceptions live in session rules
// (the only kind that can match on tabIds) with ids offset by this base.
const TAB_ALLOW_BASE = 100000;

const MEET_URL_RE = /^https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i;

// Companion mode joins without mic, camera or speaker, so it can't put you in
// the call twice — and it's how MeetLoaf's "Present a Browser Tab" gets
// Chrome's own tab sharing. Let these links load in the browser.
const COMPANION_RE = /^https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\?(?:[^#]*&)?companion=1(?:[&#]|$)/i;

function rules() {
  const handoff = chrome.runtime.getURL('handoff.html');
  return [
    {
      id: RULE_REDIRECT,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: `${handoff}#\\1` }
      },
      condition: {
        // Only meeting codes — the Meet home page, /landing, /lookup etc.
        // still open normally in the browser.
        regexFilter: '^https?://meet\\.google\\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$',
        resourceTypes: ['main_frame']
      }
    },
    {
      id: RULE_ALLOW_COMPANION,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        regexFilter: '^https?://meet\\.google\\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}\\?([^#]*&)?companion=1([&#].*)?$',
        resourceTypes: ['main_frame']
      }
    }
  ];
}

async function applyRules(enabled) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_REDIRECT, RULE_ALLOW_COMPANION],
    addRules: enabled ? rules() : []
  });
}

async function getEnabled() {
  const r = await chrome.storage.local.get('enabled');
  return typeof r.enabled === 'boolean' ? r.enabled : true;
}

function updateBadge(enabled) {
  chrome.action.setTitle({
    title: enabled ? 'MeetLoaf Router (enabled)' : 'MeetLoaf Router (disabled)'
  });
  chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#888' });
}

async function sync() {
  const enabled = await getEnabled();
  await applyRules(enabled);
  updateBadge(enabled);
}

// Dynamic rules persist across restarts, but re-sync on install/update (the
// extension ID in the redirect target can change for unpacked loads) and on
// every service-worker start so the badge is right.
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
sync();

chrome.action.onClicked.addListener(async () => {
  const enabled = !(await getEnabled());
  await chrome.storage.local.set({ enabled });
  await applyRules(enabled);
  updateBadge(enabled);
});

// "Join in the browser instead": let Meet load in that one tab for as long as
// it stays open. Scoped by tab rather than a URL marker because Meet bounces
// through its own redirects (sign-in, authuser, …) which would drop a marker
// and get caught by the redirect rule again.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'allow-in-tab' || !sender.tab) return;
  allowMeetInTab(sender.tab.id)
    .then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
  return true; // async sendResponse
});

function allowMeetInTab(tabId) {
  allowTab(tabId);
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TAB_ALLOW_BASE + tabId],
    addRules: [{
      id: TAB_ALLOW_BASE + tabId,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        tabIds: [tabId],
        requestDomains: ['meet.google.com'],
        resourceTypes: ['main_frame']
      }
    }]
  });
}

// A Companion tab gets the same per-tab exemption as "join in the browser":
// Meet strips ?companion=1 from the address once it loads, so a reload — or
// one of Meet's own redirects — would otherwise be caught by the redirect
// rule. onBeforeNavigate fires before the request, giving the session rule
// the best chance of being in place before any redirect.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !COMPANION_RE.test(details.url)) return;
  allowMeetInTab(details.tabId).catch(() => {});
}, { url: [{ hostEquals: 'meet.google.com' }] });

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_ALLOW_BASE + tabId] }).catch(() => {});
  disallowTab(tabId);
});

// Tabs the user chose to "join in the browser". Kept in storage.session so it
// survives the service worker being suspended, but not a browser restart.
async function allowedTabs() {
  const r = await chrome.storage.session.get('allowedTabs');
  return new Set(r.allowedTabs || []);
}
async function allowTab(tabId) {
  const set = await allowedTabs();
  set.add(tabId);
  await chrome.storage.session.set({ allowedTabs: [...set] });
}
async function disallowTab(tabId) {
  const set = await allowedTabs();
  if (set.delete(tabId)) await chrome.storage.session.set({ allowedTabs: [...set] });
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const match = details.url.match(MEET_URL_RE);
  if (!match) return;
  if (COMPANION_RE.test(details.url)) return;
  if (!(await getEnabled())) return;
  if ((await allowedTabs()).has(details.tabId)) return;
  const code = match[1].toLowerCase();
  console.log('[meetloaf] Meet page loaded despite the redirect rule (service worker?) — handing off', code);
  chrome.tabs.update(details.tabId, {
    // via=commit: the Meet page is already in this tab's history, so the
    // hand-off page has to step back over it too.
    url: chrome.runtime.getURL('handoff.html') + '?via=commit#' + code
  }).catch(() => {});
}, { url: [{ hostEquals: 'meet.google.com' }] });
