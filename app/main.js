const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, session, dialog, shell, ipcMain, nativeTheme, screen, desktopCapturer } = require('electron');

const path = require('path');
const fs = require('fs');
const os = require('os');
const pkg = require('./package.json');

const MEET_URL = 'https://meet.google.com/';
const MEETING_CODE_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const BUNDLED_CONFIG = path.join(__dirname, 'config.json');
// Default config location: ~/.config/meetloaf/ (or $XDG_CONFIG_HOME) so
// dotfiles managers can pick it up. The user can override this via Settings;
// the override path is stored in a pointer file inside Electron's userData
// dir (which doesn't move). Browser session/cache always stays in userData.
const DEFAULT_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meetloaf');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json');
const POINTER_FILE = path.join(app.getPath('userData'), 'config-path.txt');
// Legacy: pre-XDG-relocation config used to live alongside Electron's
// userData. We migrate on first launch so existing settings aren't lost.
const LEGACY_CONFIG = path.join(app.getPath('userData'), 'config.json');

let USER_CONFIG;
let CONFIG_DIR;

function readPointer() {
  try {
    if (fs.existsSync(POINTER_FILE)) {
      const p = fs.readFileSync(POINTER_FILE, 'utf8').trim();
      if (p) return p;
    }
  } catch (err) {
    console.warn('Could not read config-path pointer:', err.message);
  }
  return null;
}

function writePointer(p) {
  try {
    fs.mkdirSync(path.dirname(POINTER_FILE), { recursive: true });
    fs.writeFileSync(POINTER_FILE, p, 'utf8');
  } catch (err) {
    console.error('Could not write config-path pointer:', err.message);
  }
}

function resolveConfigPath() {
  const pointed = readPointer();
  USER_CONFIG = pointed || DEFAULT_CONFIG_PATH;
  CONFIG_DIR = path.dirname(USER_CONFIG);
}
resolveConfigPath();

// Read once at startup; injected into every Meet page on dom-ready.
const MEET_INJECTION = fs.readFileSync(path.join(__dirname, 'main-inject.js'), 'utf8');

let mainWindow = null;
let settingsWindow = null;
let miniWindow = null;
let welcomeWindow = null;
let tray = null;
let mainVisibility = 'visible';
let appFocused = true;
let blurResolveTimer = null;
let inMeeting = false;
let config = { shortcuts: {}, window: { width: 1200, height: 800 } };

// Shortcuts used to be stored as bare accelerator strings; now each is
// { accelerator, global } so users can opt out of OS-global registration
// per shortcut. Older configs are upgraded transparently — pre-existing
// shortcuts default to global:true, which is the previous behavior.
function normalizeShortcuts(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value && typeof value === 'object') {
      out[key] = {
        accelerator: typeof value.accelerator === 'string' ? value.accelerator : '',
        global: value.global !== false
      };
    } else {
      out[key] = { accelerator: typeof value === 'string' ? value : '', global: true };
    }
  }
  return out;
}

function loadConfig() {
  try {
    // If a custom path was set but the file's gone (deleted folder, etc.),
    // fall back to the default rather than silently failing.
    if (USER_CONFIG !== DEFAULT_CONFIG_PATH && !fs.existsSync(USER_CONFIG)) {
      console.warn(`Configured path ${USER_CONFIG} missing, reverting to default`);
      USER_CONFIG = DEFAULT_CONFIG_PATH;
      CONFIG_DIR = path.dirname(USER_CONFIG);
      writePointer(USER_CONFIG);
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // One-time migration from the old userData location. Existing users
    // already know the app, so we mark welcomeSeen=true on the migrated
    // copy so they don't see the onboarding tour.
    if (!fs.existsSync(USER_CONFIG) && fs.existsSync(LEGACY_CONFIG)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      legacy.welcomeSeen = true;
      fs.writeFileSync(USER_CONFIG, JSON.stringify(legacy, null, 2) + '\n');
      console.log(`Migrated config from ${LEGACY_CONFIG} to ${USER_CONFIG}`);
    }
    if (!fs.existsSync(USER_CONFIG)) {
      fs.copyFileSync(BUNDLED_CONFIG, USER_CONFIG);
    }
    const parsed = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
    config = { ...config, ...parsed, shortcuts: normalizeShortcuts(parsed.shortcuts) };
  } catch (err) {
    console.error('Config load failed, using defaults:', err.message);
  }
}

function saveConfig(next) {
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    config = { ...config, ...next, shortcuts: normalizeShortcuts(next.shortcuts) };
    applyWindowPrefs();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Cache the last applied AOT state so we only call the native APIs when
// it actually changes. Repeated no-op calls to setAlwaysOnTop /
// setVisibleOnAllWorkspaces have been observed to demote the app to
// accessory mode on meeting start/end transitions.
let lastAppliedAOT = null;

function applyWindowPrefs() {
  // AOT and mini-mode only kick in *during* a meeting — the lobby/landing
  // page doesn't need to stay on top or shrink to a corner. When the URL
  // leaves the meeting code pattern, both behaviors automatically deactivate.
  const aotConfigured = !!(config.window && config.window.alwaysOnTop);
  const aot = aotConfigured && inMeeting;

  if (aot !== lastAppliedAOT) {
    lastAppliedAOT = aot;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(aot, 'floating', 1);
      mainWindow.setVisibleOnAllWorkspaces(aot, { visibleOnFullScreen: true });
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setAlwaysOnTop(aot, 'floating', 2);
    }
  }

  evaluateMiniState();
}

function checkMeetingState() {
  const next = isInActiveMeeting();
  if (next !== inMeeting) {
    inMeeting = next;
    applyWindowPrefs();
  }
}

// ─── Mini window ────────────────────────────────────────────────────────────

const MINI_MARGIN = 16;
const MINI_FRAME_INTERVAL_MS = 250; // ~4 fps — capturePage isn't free
const MINI_FRAME_WIDTH = 600;       // pre-resize before sending over IPC

const MINI_SIZE_RATIOS = { small: 0.10, medium: 0.25, large: 0.40 };

function miniSizePx() {
  // Mini width is a percentage of the *display* (work area) — not the main
  // window — so sizes are predictable regardless of how big the user has
  // their MeetLoaf window. Height preserves main's aspect ratio so the
  // preview content fits without distortion.
  //   small  = display * 10%
  //   medium = display * 25%
  //   large  = display * 50%
  const ratio = MINI_SIZE_RATIOS[config.window?.miniSize] ?? 0.25;
  const main = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { width: 1200, height: 800 };
  const display = screen.getDisplayMatching(main);
  const wa = display.workArea;
  const aspect = main.width > 0 ? main.height / main.width : 0.667;
  const width = Math.round(wa.width * ratio);
  const height = Math.round(width * aspect);
  return { width, height };
}

function miniBoundsFor(corner) {
  // Use the display the main window currently lives on so the mini appears
  // in the corner of the same screen.
  const ref = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: 0, y: 0, width: 0, height: 0 };
  const display = screen.getDisplayMatching(ref);
  const wa = display.workArea;
  const { width, height } = miniSizePx();
  const right = wa.x + wa.width - width - MINI_MARGIN;
  const bottom = wa.y + wa.height - height - MINI_MARGIN;
  const left = wa.x + MINI_MARGIN;
  const top = wa.y + MINI_MARGIN;
  switch (corner) {
    case 'top-left':     return { x: left,  y: top,    width, height };
    case 'top-right':    return { x: right, y: top,    width, height };
    case 'bottom-left':  return { x: left,  y: bottom, width, height };
    case 'bottom-right':
    default:             return { x: right, y: bottom, width, height };
  }
}

function ensureMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;

  const corner = config.window?.miniCorner || 'bottom-right';
  const bounds = miniBoundsFor(corner);

  miniWindow = new BrowserWindow({
    ...bounds,
    // Regular BrowserWindow — no type:'panel', no skipTaskbar:true. Both
    // of those flags translate to "transient/auxiliary" classifications on
    // macOS that have been observed to demote the app to accessory mode
    // when the mini is the only visible window.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'mini', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  miniWindow.setAlwaysOnTop(true, 'floating', 1);
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  miniWindow.loadFile(path.join(__dirname, 'mini', 'index.html'));

  miniWindow.on('closed', () => { miniWindow = null; });

  return miniWindow;
}

// Last known mic/camera state, cached so we can include it in status pushes
// even when the poll is between intervals.
let lastMicMuted = null;
let lastCameraOff = null;

async function readMicCameraState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // Read aria-labels of Meet's mic and camera toggle buttons. The label
  // tells us the *action* the button will perform: "Turn on microphone"
  // means mic is currently OFF (button will turn it on). Inverse for camera.
  const js = `
    (() => {
      const els = document.querySelectorAll('[role="button"][aria-label], button[aria-label]');
      let muted = null, cameraOff = null;
      for (const el of els) {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (muted === null && /turn (on|off) microphone/.test(label)) {
          muted = /turn on microphone/.test(label);
        }
        if (cameraOff === null && /turn (on|off) camera/.test(label)) {
          cameraOff = /turn on camera/.test(label);
        }
        if (muted !== null && cameraOff !== null) break;
      }
      return { muted, cameraOff };
    })();
  `;
  try {
    return await mainWindow.webContents.executeJavaScript(js);
  } catch {
    return null;
  }
}

function pushMiniStatus() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  const inMeeting = isInActiveMeeting();
  miniWindow.webContents.send('mini:status', {
    text: inMeeting ? 'In a meeting' : 'Click to restore',
    inMeeting,
    muted: lastMicMuted,
    cameraOff: lastCameraOff
  });
}

function showMini() {
  ensureMiniWindow();
  // Reposition before show in case the corner setting changed or the user
  // moved the main window to a different display.
  const corner = config.window?.miniCorner || 'bottom-right';
  miniWindow.setBounds(miniBoundsFor(corner));
  miniWindow.showInactive(); // show without stealing focus
  pushMiniStatus();
  startFrameStream();
  scheduleDockAssertion();
}

function hideMini() {
  stopFrameStream();
  if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()) {
    miniWindow.hide();
  }
}

// ─── Live preview stream + mic/camera state poll ───────────────────────────

let frameTimer = null;
let capturing = false;
let stateTimer = null;

async function pollMicCamera() {
  const next = await readMicCameraState();
  if (!next) return;
  const changed = next.muted !== lastMicMuted || next.cameraOff !== lastCameraOff;
  lastMicMuted = next.muted;
  lastCameraOff = next.cameraOff;
  if (changed) pushMiniStatus();
}

async function captureAndSend() {
  if (capturing) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!miniWindow || miniWindow.isDestroyed() || !miniWindow.isVisible()) return;
  capturing = true;
  try {
    const image = await mainWindow.webContents.capturePage();
    if (!miniWindow || miniWindow.isDestroyed() || !miniWindow.isVisible()) return;
    if (image.isEmpty()) return;
    const small = image.resize({ width: MINI_FRAME_WIDTH, quality: 'good' });
    miniWindow.webContents.send('mini:frame', small.toDataURL());
  } catch {
    // capturePage rejects during teardown / before web contents are ready
  } finally {
    capturing = false;
  }
}

function startFrameStream() {
  if (frameTimer) return;
  // Snapshot immediately so the preview isn't blank for a beat.
  captureAndSend();
  frameTimer = setInterval(captureAndSend, MINI_FRAME_INTERVAL_MS);
  // Mic/camera state polls more slowly — toggling state ~1Hz is plenty.
  pollMicCamera();
  stateTimer = setInterval(pollMicCamera, 1000);
}

function stopFrameStream() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = null;
  }
  // Reset cached state so the next session starts unknown rather than stale.
  lastMicMuted = null;
  lastCameraOff = null;
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:clear');
  }
}

function evaluateMiniState() {
  const enabled = !!(config.window && config.window.miniMode) && inMeeting;
  if (!enabled || config.window?.alwaysOnTop) {
    hideMini();
    return;
  }

  const trigger = config.window?.miniTrigger || 'covered';
  const shouldShow = trigger === 'unfocused'
    ? !appFocused
    : mainVisibility === 'hidden';

  if (shouldShow) showMini();
  else hideMini();
}

// No-op kept so existing call sites don't need editing. The mini is now a
// child window of main (parent: mainWindow on the BrowserWindow opts), so
// macOS sees the mini as part of main's window hierarchy. Main is regular,
// so the app stays regular regardless of mini's panel-ness.
function scheduleDockAssertion() {}

// Debounced visibility handling. capturePage() (used by the mini preview)
// causes Chromium to briefly flip document.visibilityState 'hidden' -> 'visible'
// -> 'hidden' on each capture. Without debouncing, the mini window flickers
// at the capture rate. We apply 'hidden' immediately (snappy mini-on) but
// defer 'visible' to filter out the transient capture-induced blips.
let visibilityVisibleTimer = null;

ipcMain.on('main:visibility', (_e, state) => {
  if (state === 'hidden') {
    if (visibilityVisibleTimer) {
      clearTimeout(visibilityVisibleTimer);
      visibilityVisibleTimer = null;
    }
    if (mainVisibility !== 'hidden') {
      mainVisibility = 'hidden';
      evaluateMiniState();
    }
    return;
  }
  if (visibilityVisibleTimer) clearTimeout(visibilityVisibleTimer);
  visibilityVisibleTimer = setTimeout(() => {
    visibilityVisibleTimer = null;
    if (mainVisibility !== 'visible') {
      mainVisibility = 'visible';
      evaluateMiniState();
    }
  }, 500);
});

// Track whether *any* MeetLoaf window has focus (main, settings, or mini).
// Using app-level events rather than mainWindow.on('blur') so opening Settings
// doesn't count as "unfocused", and clicking the mini doesn't either.
app.on('browser-window-focus', (_e, win) => {
  // Mini focusing (if it ever sneaks past focusable:false) doesn't count.
  if (win === miniWindow) return;
  if (blurResolveTimer) { clearTimeout(blurResolveTimer); blurResolveTimer = null; }
  appFocused = true;
  evaluateMiniState();
});

app.on('browser-window-blur', (_e, win) => {
  if (win === miniWindow) return;
  // Defer the decision a tick — focus may transfer to another MeetLoaf window
  // (Settings, the mini itself), and we don't want to flicker the mini on
  // intra-app focus changes.
  if (blurResolveTimer) clearTimeout(blurResolveTimer);
  blurResolveTimer = setTimeout(() => {
    blurResolveTimer = null;
    if (BrowserWindow.getFocusedWindow()) return; // some MeetLoaf window still focused
    appFocused = false;
    evaluateMiniState();
  }, 80);
});

// Toggle main's mic/cam from the mini buttons. We briefly drop main's
// focusable flag so even if macOS tries to activate MeetLoaf as a side
// effect of the panel click, main can't become the key window and won't
// jump to the foreground.
function toggleViaMini(pattern) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    clickByAriaLabel(pattern);
    return;
  }
  const wasFocusable = mainWindow.isFocusable();
  mainWindow.setFocusable(false);
  clickByAriaLabel(pattern);
  // Restore focusable shortly after so it doesn't interfere with later
  // restore actions. 200ms is enough for macOS to settle.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFocusable(wasFocusable);
    }
  }, 200);
}

ipcMain.on('mini:toggle-mute', () => toggleViaMini('turn (on|off) microphone'));
ipcMain.on('mini:toggle-camera', () => toggleViaMini('turn (on|off) camera'));

// Triggered by the injected "MeetLoaf Settings" link in Meet's own modal.
ipcMain.on('main:open-settings', () => openSettingsWindow());

// ─── Firefox extension routing helpers ─────────────────────────────────────

// Firefox-family browsers — all share Mozilla's WebExtensions runtime and
// accept signed XPIs. Order matters: more-canonical builds first so we
// pick a "real" Firefox if both are installed.
const FIREFOX_CANDIDATES = [
  { name: 'Firefox', path: '/Applications/Firefox.app' },
  { name: 'Firefox Developer Edition', path: '/Applications/Firefox Developer Edition.app' },
  { name: 'Firefox Nightly', path: '/Applications/Firefox Nightly.app' },
  { name: 'Firefox ESR', path: '/Applications/Firefox ESR.app' },
  { name: 'Zen Browser', path: '/Applications/Zen Browser.app' },
  { name: 'Zen', path: '/Applications/Zen.app' },
  { name: 'LibreWolf', path: '/Applications/LibreWolf.app' },
  { name: 'Waterfox', path: '/Applications/Waterfox.app' },
  { name: 'Floorp', path: '/Applications/Floorp.app' }
];

// Chromium-family detection is in place for future use — we don't ship
// a Chrome extension yet, so the Routing tab won't act on these. Listed
// here so adding the action later is a one-liner.
const CHROMIUM_CANDIDATES = [
  { name: 'Google Chrome', path: '/Applications/Google Chrome.app' },
  { name: 'Google Chrome Canary', path: '/Applications/Google Chrome Canary.app' },
  { name: 'Chromium', path: '/Applications/Chromium.app' },
  { name: 'Brave Browser', path: '/Applications/Brave Browser.app' },
  { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app' },
  { name: 'Arc', path: '/Applications/Arc.app' },
  { name: 'Vivaldi', path: '/Applications/Vivaldi.app' },
  { name: 'Opera', path: '/Applications/Opera.app' },
  { name: 'Thorium', path: '/Applications/Thorium.app' }
];

function findInList(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c.path)) return c;
  }
  return null;
}

function findFirefox() { return findInList(FIREFOX_CANDIDATES); }
function findChromium() { return findInList(CHROMIUM_CANDIDATES); }

ipcMain.handle('firefox:detect', () => {
  const ff = findFirefox();
  const chromium = findChromium();
  const xpi = path.join(__dirname, 'firefox-extension.xpi');
  return {
    firefox: ff,                    // { name, path } or null
    chromium,                       // { name, path } or null — informational
    extensionBundled: fs.existsSync(xpi),
    xpiPath: xpi
  };
});

// Path to the bundled Chrome/Chromium extension folder. In dev (`npm start`)
// it lives next to the app source; in a packaged build it's copied to
// Resources/ via electron-builder's extraResources.
function chromeExtensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension-chrome')
    : path.join(__dirname, '..', 'extension-chrome');
}

ipcMain.handle('chrome:detect', () => {
  const browser = findChromium();
  const dir = chromeExtensionDir();
  return {
    chromium: browser,                  // { name, path } or null
    extensionBundled: fs.existsSync(path.join(dir, 'manifest.json')),
    extensionPath: dir
  };
});

ipcMain.handle('chrome:show-folder', () => {
  const dir = chromeExtensionDir();
  if (!fs.existsSync(dir)) return { ok: false, error: 'Extension folder missing' };
  // Reveal the folder itself, selected, in a Finder window.
  shell.showItemInFolder(dir);
  return { ok: true };
});

ipcMain.handle('chrome:open-extensions', async () => {
  const browser = findChromium();
  if (!browser) return { ok: false, error: 'No Chromium-based browser found in /Applications' };
  // `open -a <browser> chrome://extensions` works for Chrome, Arc, Brave,
  // Edge, and Vivaldi — they all interpret chrome:// URLs internally even
  // when launched from the shell.
  return new Promise((resolve) => {
    require('child_process').execFile('open', ['-a', browser.path, 'chrome://extensions'], (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

ipcMain.handle('firefox:install-extension', async () => {
  const ff = findFirefox();
  if (!ff) return { ok: false, error: 'No Firefox-family browser found in /Applications' };

  const xpi = path.join(__dirname, 'firefox-extension.xpi');
  if (!fs.existsSync(xpi)) {
    return { ok: false, error: 'Extension XPI not bundled. Run extension/build.sh.' };
  }

  // `open -a <full path>` is unambiguous for variant browsers (Zen, LibreWolf,
  // etc.) whose canonical app name might not match what `open` expects when
  // given just the human name. The browser sees the .xpi extension and shows
  // its install confirmation dialog.
  return new Promise((resolve) => {
    require('child_process').execFile('open', ['-a', ff.path, xpi], (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

ipcMain.on('mini:restore', () => {
  // Optimistically mark visibility so the focus events that fire from show()
  // / focus() below don't see mainVisibility==='hidden' and immediately
  // re-trigger the mini. The renderer's real visibility event will arrive
  // shortly and confirm.
  mainVisibility = 'visible';
  if (visibilityVisibleTimer) {
    clearTimeout(visibilityVisibleTimer);
    visibilityVisibleTimer = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();

    // Bring main to the user's current Space. Without this, if the user
    // switched Spaces (which is one of the things that fires 'hidden'),
    // show() lands the window on its original Space and the user sees
    // nothing on their current Space.
    const wasAOT = !!config.window?.alwaysOnTop;
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    mainWindow.show();
    mainWindow.focus();
    app.focus({ steal: true });

    // Restore the workspace setting unless always-on-top wants it sticky.
    if (!wasAOT) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setVisibleOnAllWorkspaces(false);
        }
      }, 250);
    }
  }
  hideMini();
});

function normalizeMeetUrl(raw) {
  const stripped = raw.replace(/^meet:\/\//, '').replace(/^\/+/, '');
  if (stripped.startsWith('http://') || stripped.startsWith('https://')) return stripped;
  if (stripped.startsWith('meet.google.com')) return 'https://' + stripped;
  return 'https://meet.google.com/' + stripped;
}

function isInActiveMeeting() {
  if (!mainWindow) return false;
  try {
    const u = new URL(mainWindow.webContents.getURL());
    return u.hostname === 'meet.google.com' && MEETING_CODE_RE.test(u.pathname);
  } catch {
    return false;
  }
}

async function handleDeepLink(rawUrl) {
  const target = normalizeMeetUrl(rawUrl);
  if (!mainWindow) return;

  if (isInActiveMeeting()) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Join new meeting', 'Stay in current', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      message: "You're already in a meeting.",
      detail: `Open ${target}?`
    });
    if (response !== 0) return;
  }

  mainWindow.loadURL(target);
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: config.window?.width || 1200,
    height: config.window?.height || 800,
    titleBarStyle: 'hiddenInset',
    // Push traffic lights down so they sit vertically inside Meet's header
    // bar (where the hamburger / Meet logo live) instead of floating above
    // it. y=22 lines them up with the natural center of Meet's top bar.
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#ffffff',
    alwaysOnTop: !!config.window?.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'main-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setUserAgent(USER_AGENT);
  mainWindow.loadURL(MEET_URL);

  // Track whether the user is in a meeting (URL matches xxx-yyyy-zzz pattern).
  // AOT and Mini-mode are gated on this so they only activate during calls,
  // not on the lobby. Both `did-navigate` (full page loads) and
  // `did-navigate-in-page` (Meet's SPA route changes) are needed.
  mainWindow.webContents.on('did-navigate', checkMeetingState);
  mainWindow.webContents.on('did-navigate-in-page', checkMeetingState);

  // Inject a thin draggable strip across the top of every Meet page so the
  // user can grab the window. Without this, Meet's content extends edge-to-edge
  // under our traffic lights and captures pointer events that would otherwise
  // hit the OS-reserved drag region. The strip is transparent and sized to
  // match the traffic-light row, so it overlaps with very little Meet UI.
  const DRAG_REGION_CSS = `
    /* Thin draggable strip across the very top of the window. */
    html::before {
      content: '';
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 28px;
      -webkit-app-region: drag;
      z-index: 2147483647;
    }
    /* Push Meet's top header right so the hamburger / logo don't sit
       under the traffic lights. 76px clears the close/min/max trio
       plus a small gap. */
    header[role="banner"],
    body > header,
    body header[class],
    [role="banner"] {
      padding-left: 76px !important;
      box-sizing: border-box !important;
    }
  `;
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.insertCSS(DRAG_REGION_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(MEET_INJECTION).catch(() => {});
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://accounts.google.com')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function clickByAriaLabel(patternSource) {
  if (!mainWindow) return;
  const js = `
    (() => {
      const re = new RegExp(${JSON.stringify(patternSource)}, 'i');
      const els = document.querySelectorAll('[role="button"][aria-label], button[aria-label]');
      for (const el of els) {
        if (re.test(el.getAttribute('aria-label') || '')) {
          el.click();
          return true;
        }
      }
      return false;
    })();
  `;
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

function parseRepoSlug() {
  const url = pkg.repository?.url || '';
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) return null;
  const slug = `${m[1]}/${m[2]}`;
  if (/\bOWNER\b/i.test(slug) || /\bREPO\b/i.test(slug)) return null;
  return slug;
}

function versionIsNewer(latest, current) {
  const pa = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] || 0;
    const b = pb[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

let lastUpdateCheckAt = 0;
const UPDATE_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function checkForUpdates({ manual = false } = {}) {
  if (!manual && Date.now() - lastUpdateCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS) return;
  lastUpdateCheckAt = Date.now();

  const slug = parseRepoSlug();
  if (!slug) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Update checks are not configured.',
        detail: 'Set "repository.url" in package.json to a real GitHub repo.'
      });
    }
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MeetLoaf' }
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();

    if (latest && versionIsNewer(latest, current)) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `MeetLoaf ${latest} is available.`,
        detail: `You have ${current}. Open the release page to download?`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) shell.openExternal(release.html_url);
    } else if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `You're on the latest version (${current}).`
      });
    }
  } catch (err) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Could not check for updates.',
        detail: err.message
      });
    }
  }
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show / Hide MeetLoaf', click: () => toggleMainWindow() },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettingsWindow() },
    { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
    { type: 'separator' },
    { label: 'Quit MeetLoaf', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}


function createTray() {
  const iconPath = path.join(__dirname, 'trayTemplate.png');
  if (!fs.existsSync(iconPath)) {
    console.warn('Tray icon missing — run npm run icon to build it');
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true); // macOS auto-tints for menu bar appearance
  tray = new Tray(image);
  tray.setToolTip('MeetLoaf');
  // Left-click toggles the window; right-click (and ctrl-click) opens the menu.
  tray.on('click', () => toggleMainWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function openWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show();
    welcomeWindow.focus();
    return;
  }
  welcomeWindow = new BrowserWindow({
    width: 640,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    title: 'Welcome to MeetLoaf',
    webPreferences: {
      preload: path.join(__dirname, 'welcome', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  welcomeWindow.setMenuBarVisibility(false);
  welcomeWindow.webContents.session.clearCache();
  welcomeWindow.loadFile(path.join(__dirname, 'welcome', 'index.html'));
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

ipcMain.on('welcome:show', () => openWelcomeWindow());

// Config-location management
ipcMain.handle('config-path:get', () => ({
  current: USER_CONFIG,
  default: DEFAULT_CONFIG_PATH,
  isDefault: USER_CONFIG === DEFAULT_CONFIG_PATH
}));

function removeOldConfig(oldPath) {
  if (!oldPath || oldPath === USER_CONFIG) return;
  try {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  } catch (err) {
    console.warn('Could not delete old config at', oldPath, '-', err.message);
  }
}

ipcMain.handle('config-path:choose', async () => {
  const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow;
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose where to store MeetLoaf config',
    buttonLabel: 'Use this folder',
    defaultPath: path.dirname(USER_CONFIG)
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

  const dir = result.filePaths[0];
  const target = path.join(dir, 'config.json');
  // Refuse a no-op (picking the folder you're already in).
  if (target === USER_CONFIG) return { ok: true, path: target };

  const oldPath = USER_CONFIG;

  if (fs.existsSync(target)) {
    const choice = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: ['Use existing', 'Replace with current', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'A config.json already exists in that folder.',
      detail: 'Load the existing settings, or overwrite that file with your current settings?'
    });
    if (choice.response === 2) return { ok: false, canceled: true };
    if (choice.response === 1) {
      fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }
    // response === 0: keep existing as-is
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  USER_CONFIG = target;
  CONFIG_DIR = dir;
  writePointer(target);
  // Move semantics: drop the old file once the new one is safely in place.
  removeOldConfig(oldPath);
  loadConfig();
  applyWindowPrefs();
  registerShortcuts();

  return { ok: true, path: target };
});

ipcMain.handle('config-path:reset', async () => {
  if (USER_CONFIG === DEFAULT_CONFIG_PATH) return { ok: true, path: USER_CONFIG };
  const oldPath = USER_CONFIG;
  fs.mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
  if (fs.existsSync(oldPath)) {
    fs.copyFileSync(oldPath, DEFAULT_CONFIG_PATH);
  }
  USER_CONFIG = DEFAULT_CONFIG_PATH;
  CONFIG_DIR = DEFAULT_CONFIG_DIR;
  writePointer(USER_CONFIG);
  removeOldConfig(oldPath);
  loadConfig();
  return { ok: true, path: USER_CONFIG };
});
ipcMain.on('welcome:dismiss', () => {
  // Persist that the user has seen the tour. Direct write rather than
  // saveConfig() to avoid re-firing applyWindowPrefs / registerShortcuts
  // for an unrelated change.
  config.welcomeSeen = true;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to save welcomeSeen:', err.message);
  }
  if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
});

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 540, // fixed; panel scrolls internally if a tab overflows
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'MeetLoaf Settings',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  // Hide the default menu bar visual noise on the settings window
  settingsWindow.setMenuBarVisibility(false);
  // Clear any cached CSS/JS so iterations during dev are picked up.
  settingsWindow.webContents.session.clearCache();
  // If main is currently floating, make sure settings floats higher.
  if (config.window?.alwaysOnTop) {
    settingsWindow.setAlwaysOnTop(true, 'floating', 2);
  }
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'index.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // Always re-register shortcuts when settings closes — covers the case
    // where the user closed mid-recording without saving.
    recordingShortcut = false;
    registerShortcuts();
  });
}

// IPC: settings window <-> main process
ipcMain.handle('config:get', () => {
  return JSON.parse(JSON.stringify(config));
});

ipcMain.handle('config:save', (_e, next) => {
  if (!next || typeof next !== 'object') return { ok: false, error: 'Invalid config' };
  const result = saveConfig(next);
  if (result.ok) registerShortcuts();
  return result;
});

// While the recorder input is focused, unregister all shortcuts so
// the user can re-bind keys that are currently in use without those keys
// being swallowed by the existing binding. The `recordingShortcut` flag
// also short-circuits the local before-input-event handler so local
// shortcuts don't fire while the user is typing one in the recorder.
ipcMain.on('recording:start', () => {
  recordingShortcut = true;
  globalShortcut.unregisterAll();
});

ipcMain.on('recording:stop', () => {
  recordingShortcut = false;
  registerShortcuts();
});

// Auto-resize the settings window to fit its content. Renderer measures
// document scroll height after layout (and on every layout change) and sends
// it here. We clamp to a sane range to avoid runaway sizes.
ipcMain.on('settings:resize', (_e, height) => {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const h = Math.max(200, Math.min(1200, Math.ceil(Number(height) || 0)));
  if (h <= 0) return;
  const [w] = settingsWindow.getContentSize();
  settingsWindow.setContentSize(w, h);
});

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates\u2026', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        { label: 'Settings\u2026', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Local (app-focused) shortcuts: accelerator -> handler. Populated by
// registerShortcuts() and consumed by the before-input-event listener
// attached to every MeetLoaf webContents.
const localShortcutMap = new Map();
let recordingShortcut = false;

// Map e.code (DOM physical key) to the same accelerator key tokens the
// settings recorder produces, so the strings match exactly.
const INPUT_CODE_TO_KEY = (() => {
  const m = {};
  for (let c = 65; c <= 90; c++) m[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c);
  for (let d = 0; d <= 9; d++) m[`Digit${d}`] = String(d);
  for (let f = 1; f <= 24; f++) m[`F${f}`] = `F${f}`;
  Object.assign(m, {
    Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal',
    BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
    Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote',
    Comma: 'Comma', Period: 'Period', Slash: 'Slash',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete'
  });
  return m;
})();

function accelFromInput(input) {
  const mods = input.modifiers || [];
  const parts = [];
  if (mods.includes('meta')) parts.push('Cmd');
  if (mods.includes('control')) parts.push('Ctrl');
  if (mods.includes('alt')) parts.push('Alt');
  if (mods.includes('shift')) parts.push('Shift');
  const key = INPUT_CODE_TO_KEY[input.code];
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

function attachLocalShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (recordingShortcut) return;
    if (input.type !== 'keyDown') return;
    const accel = accelFromInput(input);
    if (!accel) return;
    const action = localShortcutMap.get(accel);
    if (!action) return;
    event.preventDefault();
    action();
  });
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  localShortcutMap.clear();
  const s = config.shortcuts || {};

  const bind = (entry, fn) => {
    if (!entry || !entry.accelerator) return;
    if (entry.global) {
      try {
        const ok = globalShortcut.register(entry.accelerator, fn);
        if (!ok) console.warn(`Shortcut unavailable: ${entry.accelerator}`);
      } catch (err) {
        console.warn(`Failed to register ${entry.accelerator}: ${err.message}`);
      }
    } else {
      // Last write wins if two local shortcuts share an accelerator —
      // same constraint applies to global ones via the OS.
      localShortcutMap.set(entry.accelerator, fn);
    }
  };

  bind(s.mute, () => clickByAriaLabel('turn (on|off) microphone'));
  bind(s.camera, () => clickByAriaLabel('turn (on|off) camera'));
  bind(s.hand, () => clickByAriaLabel('(raise|lower) hand'));
  bind(s.toggleWindow, () => toggleMainWindow());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const deepLink = argv.find((a) => a.startsWith('meet://'));
    if (deepLink) handleDeepLink(deepLink);
  });

  app.setAsDefaultProtocolClient('meet');

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) handleDeepLink(url);
    else app.once('ready', () => handleDeepLink(url));
  });

  // Local shortcuts are routed through each window's webContents. Attaching
  // before any window is created ensures we catch all of them — main, mini,
  // settings, welcome, and any auth popups Google opens.
  app.on('web-contents-created', (_e, wc) => attachLocalShortcuts(wc));

  app.whenReady().then(() => {
    loadConfig();

    // setActivationPolicy alone doesn't surface the dock icon — dock.show()
    // is what physically does it. Single call at startup. The mini being a
    // child of main should keep macOS from demoting us afterwards, so no
    // re-assertion needed during the session.
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular');
      if (app.dock && typeof app.dock.show === 'function') app.dock.show();
    }

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['media', 'mediaKeySystem', 'notifications', 'display-capture'];
      callback(allowed.includes(permission));
    });

    // Screen sharing: Meet calls getDisplayMedia(); without a registered
    // handler Electron returns no sources and Meet shows "Something went
    // wrong". On macOS 14+ the `useSystemPicker: true` flag delegates
    // source selection to ScreenCaptureKit's native picker. The function
    // arg is the fallback for older macOS where we provide our own choice.
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (sources.length) callback({ video: sources[0] });
        else callback({});
      } catch (err) {
        console.error('display-media handler error:', err.message);
        callback({});
      }
    }, { useSystemPicker: true });

    buildMenu();
    createWindow();
    applyWindowPrefs();
    createTray();
    registerShortcuts();

    // First-launch onboarding tour. Migrated configs are flagged
    // welcomeSeen=true in loadConfig() so existing users don't see it.
    if (!config.welcomeSeen) {
      // Small delay so main window is settled visually before the tour pops.
      setTimeout(openWelcomeWindow, 600);
    }

    const deepLink = process.argv.find((a) => a.startsWith('meet://'));
    if (deepLink) handleDeepLink(deepLink);

    setTimeout(() => checkForUpdates(), 5000);
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else if (app.isReady()) createWindow();
  });

  app.on('window-all-closed', () => {
    // Keep running in background on macOS
  });
}
