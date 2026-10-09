// Hand-off page: the redirect rule in background.js sends meeting links here
// (as handoff.html#abc-defg-hij) before the Meet page can load. We launch
// meet://, then get the tab out of the way.
//
// The tab closes itself after a short countdown. That's long enough to answer
// the browser's "Open MeetLoaf?" prompt on first use (closing the tab earlier
// would dismiss it); clicking any button cancels the countdown.

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const AUTO_CLOSE_SECONDS = 10;

const code = decodeURIComponent(location.hash.slice(1)).toLowerCase();
const $ = (id) => document.getElementById(id);

// mlext carries this extension's version, so MeetLoaf can tell when the
// loaded copy is older than the one it bundles and prompt a reload (unpacked
// extensions don't update themselves). MeetLoaf strips it before loading Meet.
const VERSION = chrome.runtime.getManifest().version;

function launch() {
  location.href = `meet://meet.google.com/${code}?mlext=${encodeURIComponent(VERSION)}`;
}

// Reached via the backstop in background.js: the Meet page loaded first and
// sits one entry behind us in history, so stepping back one would reload it.
const VIA_COMMIT = new URLSearchParams(location.search).get('via') === 'commit';

// Opened just for this link (new tab / middle-click) → close it. Clicked
// from another page in the same tab → go back to that page.
async function tidyUp() {
  const skip = VIA_COMMIT ? 2 : 1;
  if (history.length > skip) {
    history.go(-skip);
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
}

let countdown = null;
function stopCountdown() {
  clearInterval(countdown);
  countdown = null;
  $('closing').hidden = true;
}

function startCountdown() {
  let left = AUTO_CLOSE_SECONDS;
  const paint = () => { $('closing').textContent = `This tab will close in ${left}s.`; };
  $('closing').hidden = false;
  paint();
  countdown = setInterval(async () => {
    left -= 1;
    if (left > 0) return paint();
    stopCountdown();
    // It launched and nobody objected — no need for the first-run help again.
    await chrome.storage.local.set({ handoffConfirmed: true });
    tidyUp();
  }, 1000);
}

$('inBrowser').addEventListener('click', async () => {
  stopCountdown();
  await chrome.runtime.sendMessage({ type: 'allow-in-tab' });
  location.replace(`https://meet.google.com/${code}`);
});
$('retry').addEventListener('click', () => { stopCountdown(); launch(); });
$('done').addEventListener('click', async () => {
  stopCountdown();
  await chrome.storage.local.set({ handoffConfirmed: true });
  tidyUp();
});

(async () => {
  if (!CODE_RE.test(code)) {
    $('title').textContent = 'MeetLoaf Router';
    $('invalid').hidden = false;
    $('done').hidden = true;
    $('retry').hidden = true;
    $('inBrowser').hidden = true;
    return;
  }
  $('code').textContent = code;
  document.title = `Opening ${code} in MeetLoaf…`;
  launch();

  const { handoffConfirmed } = await chrome.storage.local.get('handoffConfirmed');
  $('firstRun').hidden = !!handoffConfirmed;
  $('title').textContent = 'Opened in MeetLoaf';
  startCountdown();
})();
