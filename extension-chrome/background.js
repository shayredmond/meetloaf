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

const RULE_REDIRECT = 1;
// Per-tab "join in the browser instead" exceptions live in session rules
// (the only kind that can match on tabIds) with ids offset by this base.
const TAB_ALLOW_BASE = 100000;

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
    }
  ];
}

async function applyRules(enabled) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_REDIRECT],
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
  const tabId = sender.tab.id;
  chrome.declarativeNetRequest.updateSessionRules({
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
  }).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
  return true; // async sendResponse
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_ALLOW_BASE + tabId] }).catch(() => {});
});
