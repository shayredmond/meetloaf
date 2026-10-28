// Hand-off page: background.js redirects meeting links here (as
// handoff.html#abc-defg-hij) before the Meet page can load. We launch
// meet://, then get the tab out of the way.
//
// The tab closes itself after a short countdown. That's long enough to answer
// Firefox's "Open MeetLoaf?" prompt on first use (closing the tab earlier
// would dismiss it); clicking any button cancels the countdown.
//
// Mirrors extension-chrome/handoff.js, minus the ?mlext= version stamp:
// MeetLoaf compares that against the bundled *Chrome* extension's version, so
// a Firefox stamp would trigger a bogus "reload the extension" prompt.

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const AUTO_CLOSE_SECONDS = 10;

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
  const tab = await browser.tabs.getCurrent();
  if (tab) browser.tabs.remove(tab.id);
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
    await browser.storage.local.set({ handoffConfirmed: true });
    tidyUp();
  }, 1000);
}

$('inBrowser').addEventListener('click', async () => {
  stopCountdown();
  await browser.runtime.sendMessage({ type: 'allow-in-tab' });
  location.replace(`https://meet.google.com/${code}`);
});
$('retry').addEventListener('click', () => { stopCountdown(); launch(); });
$('done').addEventListener('click', async () => {
  stopCountdown();
  await browser.storage.local.set({ handoffConfirmed: true });
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

  const { handoffConfirmed } = await browser.storage.local.get('handoffConfirmed');
  $('firstRun').hidden = !!handoffConfirmed;
  $('title').textContent = 'Opened in MeetLoaf';
  startCountdown();
})();
