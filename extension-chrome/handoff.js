// Hand-off page: the redirect rule in background.js sends meeting links here
// (as handoff.html#abc-defg-hij) before the Meet page can load. We launch
// meet://, then get the tab out of the way.
//
// The first launch shows the browser's "Open MeetLoaf?" prompt. Closing the
// tab would dismiss it, so the first time we stay put and explain; once the
// user confirms, later hand-offs close/go back automatically.

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const AUTO_CLOSE_MS = 1500;

const code = decodeURIComponent(location.hash.slice(1)).toLowerCase();
const $ = (id) => document.getElementById(id);

function launch() {
  location.href = `meet://meet.google.com/${code}`;
}

// Opened just for this link (new tab / middle-click) → close it. Clicked
// from another page in the same tab → go back to that page.
async function tidyUp() {
  if (history.length > 1) {
    history.back();
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
}

$('inBrowser').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'allow-in-tab' });
  location.replace(`https://meet.google.com/${code}`);
});
$('retry').addEventListener('click', launch);
$('done').addEventListener('click', async () => {
  await chrome.storage.local.set({ handoffConfirmed: true });
  tidyUp();
});

(async () => {
  if (!CODE_RE.test(code)) {
    $('title').textContent = 'MeetLoaf Router';
    $('invalid').hidden = false;
    $('retry').hidden = true;
    $('inBrowser').hidden = true;
    return;
  }
  $('code').textContent = code;
  document.title = `Opening ${code} in MeetLoaf…`;
  launch();

  const { handoffConfirmed } = await chrome.storage.local.get('handoffConfirmed');
  if (!handoffConfirmed) {
    $('firstRun').hidden = false;
    return;
  }
  $('closing').hidden = false;
  setTimeout(tidyUp, AUTO_CLOSE_MS);
})();
