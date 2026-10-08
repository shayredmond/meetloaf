const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, session, dialog, shell, ipcMain, nativeTheme, desktopCapturer, clipboard, Notification, net, systemPreferences, screen } = require('electron');

const path = require('path');
const fs = require('fs');
const os = require('os');
const pkg = require('./package.json');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const MEET_URL = 'https://meet.google.com/';
const MEETING_CODE_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/;
// Report the real OS so Meet shows the right shortcut hints (⌘ vs Ctrl).
const UA_PLATFORM = IS_MAC
  ? 'Macintosh; Intel Mac OS X 10_15_7'
  : IS_WIN ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
const USER_AGENT =
  `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 ` +
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
let welcomeWindow = null;
// The popped-out presentation viewer. Created by the Meet page itself via
// window.open() (see the pop-out section of main-inject.js) rather than by us,
// because only a window opened that way is same-origin with Meet and can be
// handed a live MediaStream by reference. We adopt it here to give it window
// chrome, position and lifetime.
let presentationWindow = null;
let tray = null;
let inMeeting = false;
// A meet:// deep link can arrive before the main window exists (cold start,
// where the OS launches us with the URL) or after the app was relaunched.
// We stash the resolved target here so createWindow() opens it as the initial
// page instead of the Meet home page.
let pendingDeepLink = null;
let config = { shortcuts: {}, window: { width: 1200, height: 800 }, homeAssistant: {} };

// Built-in shortcut defaults. Seeded into every loaded config so that keys
// absent from an existing config.json (e.g. after an upgrade) still get their
// intended binding. `leave` defaults to Cmd+W (Ctrl+W on Windows/Linux) and is intentionally NOT global:
// a global Cmd+W would hijack window-close in every app. Local-only means it
// only leaves the meeting while MeetLoaf is focused — matching the muscle
// memory of "Cmd+W closes the thing in front of me".
const DEFAULT_SHORTCUTS = {
  mute: { accelerator: '', global: true },
  camera: { accelerator: '', global: true },
  hand: { accelerator: '', global: true },
  toggleWindow: { accelerator: '', global: true },
  newMeeting: { accelerator: '', global: true },
  leave: { accelerator: 'CmdOrCtrl+W', global: false }
};

// Accelerators are stored as typed (and configs written on a Mac say "Cmd"),
// but Electron ignores Cmd outside macOS. Canonicalise to the modifiers this
// platform actually has, in the same fixed order accelFromInput() produces,
// so "Cmd+W" from a synced dotfile still means Ctrl+W on Windows/Linux.
const MODIFIER_ORDER = ['Cmd', 'Super', 'Ctrl', 'Alt', 'Shift'];
const MODIFIER_ALIASES = {
  Cmd: IS_MAC ? 'Cmd' : 'Ctrl', Command: IS_MAC ? 'Cmd' : 'Ctrl',
  CmdOrCtrl: IS_MAC ? 'Cmd' : 'Ctrl', CommandOrControl: IS_MAC ? 'Cmd' : 'Ctrl',
  Super: IS_MAC ? 'Cmd' : 'Super', Meta: IS_MAC ? 'Cmd' : 'Super',
  Ctrl: 'Ctrl', Control: 'Ctrl',
  Alt: 'Alt', Option: 'Alt', AltGr: 'Alt',
  Shift: 'Shift'
};

// Punctuation keys saved by earlier versions, which wrote DOM event.code names
// that Electron rejects. Translated on the way in so an existing binding starts
// working on upgrade rather than staying silently dead.
const LEGACY_KEY_TOKENS = {
  Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/'
};

function normalizeAccelerator(accel) {
  if (!accel) return '';
  const mods = new Set();
  let key = null;
  for (const part of accel.split('+')) {
    const mod = MODIFIER_ALIASES[part];
    if (mod) mods.add(mod);
    else key = part;
  }
  if (!key) return '';
  key = LEGACY_KEY_TOKENS[key] || key;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

// Window preferences. `popOutPresentation` defaults on — only an explicit
// false disables it — so the behavior appears for existing configs too.
const WINDOW_DEFAULTS = {
  width: 1200,
  height: 800,
  alwaysOnTop: false,
  popOutPresentation: true
};

function normalizeWindow(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...WINDOW_DEFAULTS };
  if (Number.isFinite(src.width) && src.width > 0) out.width = Math.round(src.width);
  if (Number.isFinite(src.height) && src.height > 0) out.height = Math.round(src.height);
  out.alwaysOnTop = src.alwaysOnTop === true;
  out.popOutPresentation = src.popOutPresentation !== false;
  // Where the presentation window was last left. Remembered because the whole
  // point of the feature is putting the shared screen on a second display, and
  // having to drag it there every meeting would defeat it.
  const b = src.presentationBounds;
  if (b && typeof b === 'object' && Number.isFinite(b.width) && Number.isFinite(b.height)) {
    out.presentationBounds = {
      x: Number.isFinite(b.x) ? Math.round(b.x) : undefined,
      y: Number.isFinite(b.y) ? Math.round(b.y) : undefined,
      width: Math.max(320, Math.round(b.width)),
      height: Math.max(200, Math.round(b.height))
    };
  }
  return out;
}

// Shortcuts used to be stored as bare accelerator strings; now each is
// { accelerator, global } so users can opt out of OS-global registration
// per shortcut. Older configs are upgraded transparently — pre-existing
// shortcuts default to global:true, which is the previous behavior. Missing
// keys fall back to DEFAULT_SHORTCUTS so new bindings appear on upgrade.
function normalizeShortcuts(raw) {
  const out = {};
  for (const [key, value] of Object.entries(DEFAULT_SHORTCUTS)) {
    out[key] = { ...value };
  }
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

// Home Assistant integration defaults. Disabled until the user fills in a
// target, so an upgraded config never starts firing requests on its own.
//
// `mode: 'webhook'` is the default because it needs no credential: the
// webhook ID is the whole secret, it only grants "trigger this one
// automation", and it's revocable from HA. That matters here because
// config.json is deliberately stored under ~/.config/meetloaf so dotfile
// managers can track it — a long-lived access token in a file people commit
// is a much worse trade. `mode: 'service'` exists for people who'd rather
// call automation.trigger on an existing entity; it needs the token.
const HA_DEFAULTS = {
  enabled: false,
  mode: 'webhook',
  // 'lobby'     fire "join" as soon as the pre-join screen appears. Default,
  //             because these automations are preparation — camera, lights,
  //             mic — and they have to have run before you configure devices.
  // 'connected' fire only once actually admitted and connected.
  joinOn: 'lobby',
  baseUrl: '',
  token: '',
  join: '',
  leave: ''
};

function normalizeHomeAssistant(raw) {
  const out = { ...HA_DEFAULTS };
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['baseUrl', 'token', 'join', 'leave']) {
    if (typeof src[key] === 'string') out[key] = src[key].trim();
  }
  out.mode = src.mode === 'service' ? 'service' : 'webhook';
  out.joinOn = src.joinOn === 'connected' ? 'connected' : 'lobby';
  out.enabled = src.enabled === true;
  // Trailing slashes would produce //api/webhook/... which HA rejects.
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
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
    config = {
      ...config,
      ...parsed,
      window: normalizeWindow(parsed.window),
      shortcuts: normalizeShortcuts(parsed.shortcuts),
      homeAssistant: normalizeHomeAssistant(parsed.homeAssistant)
    };
  } catch (err) {
    console.error('Config load failed, using defaults:', err.message);
  }
}

function saveConfig(next) {
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    config = {
      ...config,
      ...next,
      window: normalizeWindow(next.window),
      shortcuts: normalizeShortcuts(next.shortcuts),
      homeAssistant: normalizeHomeAssistant(next.homeAssistant)
    };
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
  // Always-on-top only kicks in *during* a meeting — the lobby/landing page
  // doesn't need to stay on top. When the URL leaves the meeting code
  // pattern, the behavior automatically deactivates.
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
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.setAlwaysOnTop(aot, 'floating', 1);
    }
  }
}

// ─── Presentation pop-out window ───────────────────────────────────────────
//
// The Meet page opens this window itself, via window.open() from the injected
// script. That's not incidental: only a window opened that way is same-origin
// with Meet and shares its renderer, which is what lets a <video> inside it be
// handed Meet's own MediaStream by reference. Nothing is re-captured or
// mirrored. Everything below is about adopting that window afterwards and
// giving it a sensible life — chrome, remembered bounds, always-on-top to
// match the main window, and a clean shutdown when the call ends.
const PRESENTATION_FRAME = 'meetloaf-presentation';

function popOutEnabled() {
  return config.window?.popOutPresentation !== false;
}

// A remembered position is only worth restoring if the display it was on is
// still attached — unplugging the second monitor would otherwise strand the
// window somewhere the user can't reach it.
function boundsOnSomeDisplay(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x &&
           b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

function presentationWindowOptions() {
  const saved = config.window?.presentationBounds;
  const opts = {
    width: saved?.width || 1024,
    height: saved?.height || 640,
    minWidth: 320,
    minHeight: 200,
    title: 'Presentation',
    backgroundColor: '#000000',
    ...(IS_MAC ? {} : { autoHideMenuBar: true })
    // webPreferences is deliberately not overridden: the window has to stay in
    // the opener's process and origin or the stream hand-off breaks.
  };
  if (boundsOnSomeDisplay(saved)) {
    opts.x = saved.x;
    opts.y = saved.y;
  }
  return opts;
}

function rememberPresentationBounds() {
  if (!presentationWindow || presentationWindow.isDestroyed()) return;
  const b = presentationWindow.getBounds();
  const prev = config.window?.presentationBounds;
  if (prev && prev.x === b.x && prev.y === b.y &&
      prev.width === b.width && prev.height === b.height) return;
  saveConfig({ ...config, window: { ...config.window, presentationBounds: b } });
}

function adoptPresentationWindow(win) {
  presentationWindow = win;
  const aot = !!(config.window && config.window.alwaysOnTop) && inMeeting;
  win.setAlwaysOnTop(aot, 'floating', 1);
  win.on('close', rememberPresentationBounds);
  win.on('closed', () => { presentationWindow = null; });
  console.log('[meetloaf] presentation popped out');
}

// Closing from this side (the call ended, the renderer was replaced) instead
// of from the page. The page runs its own state machine, so it has to be told
// to drop the handle — otherwise it reads the vanished window as "the user
// dismissed this" and won't reopen for the next presenter.
function closePresentationWindow(reason) {
  if (!presentationWindow || presentationWindow.isDestroyed()) return;
  console.log(`[meetloaf] closing presentation window (${reason})`);
  rememberPresentationBounds();
  presentationWindow.destroy();
  presentationWindow = null;
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (wc && !wc.isCrashed()) {
    wc.executeJavaScript('window.__meetloafPopout && window.__meetloafPopout.reset()')
      .catch(() => {});
  }
}

// Menu command. Deliberately independent of auto-detection: this is the
// escape hatch for when Meet's markup moved and detection didn't fire.
function togglePresentationWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      const api = window.__meetloafPopout;
      if (!api) return null;
      if (api.isOpen()) { api.close(); return true; }
      return api.open();
    })()
  `).then((ok) => {
    if (ok === false) console.log('[meetloaf] no remote video to pop out');
  }).catch(() => {});
}

// Confirmation windows for a phase change. Moving *towards* being present
// should feel instant — the whole point of firing at the lobby is that the
// automation has already run by the time you're setting up camera and mic.
// Moving away gets a longer settle window because Meet's DOM churns hard during
// reconnects and layout changes, and a spurious leave/join pair would run the
// user's automations twice.
const ENTER_CONFIRM_MS = 400;
const EXIT_CONFIRM_MS = 2000;
// How often main re-reads the phase itself. This is the safety net for a hidden
// window, where the renderer's observer and timers are throttled.
const PHASE_POLL_MS = 2000;

// Ordering, not just identity: a change that moves up this scale is confirmed
// fast, a change that moves down is confirmed slowly. `away` is our own phase
// for "the URL isn't a meeting at all".
const PHASE_RANK = { away: 0, unknown: 0, post_call: 0, lobby: 1, in_call: 2 };

let phase = 'away';          // confirmed phase
let phaseObserved = 'away';  // latest raw observation
let phaseTimer = null;
let phasePollTimer = null;
// Whether the Home Assistant side currently considers us "in a meeting". Kept
// separate from `inMeeting` (which means *connected*, and drives always-on-top)
// so that choosing to fire automations at the lobby can't quietly change window
// behaviour as a side effect.
let haPresent = false;

function clearPhaseConfirm() {
  if (phaseTimer) {
    clearTimeout(phaseTimer);
    phaseTimer = null;
  }
}

// The URL is authoritative for "not in a meeting at all" — the home page, the
// landing page, an auth redirect. Within a meeting URL, the DOM decides.
function effectivePhase(raw) {
  if (!isInActiveMeeting()) return 'away';
  return PHASE_RANK[raw] === undefined ? 'unknown' : raw;
}

// Does this phase count as "in a meeting" for the Home Assistant events?
function phaseIsPresent(p) {
  if (p === 'in_call') return true;
  // The waiting room counts unless the user asked for connected-only. It's the
  // default: automations here are preparation (camera, lights, mic), and they
  // need to have run before you start configuring devices.
  if (p === 'lobby') return haConfig().joinOn !== 'connected';
  return false;
}

// Every raw observation — from the DOM watcher or from our own poll — lands
// here. A change only commits once it has held for its confirmation window, so
// a momentary DOM blip cancels itself instead of firing automations.
function observePhase(raw, source) {
  const next = effectivePhase(raw);
  phaseObserved = next;
  if (next === phase) {
    clearPhaseConfirm();
    return;
  }
  if (phaseTimer) return; // a change is already pending; the latest raw wins
  const entering = PHASE_RANK[next] > PHASE_RANK[phase];
  phaseTimer = setTimeout(() => {
    phaseTimer = null;
    if (phaseObserved !== phase) commitPhase(phaseObserved, source);
  }, entering ? ENTER_CONFIRM_MS : EXIT_CONFIRM_MS);
}

// Single funnel for every phase transition. Everything that can change the
// state (DOM watcher, poll, navigation, renderer crash, quit) routes through
// here, so the Home Assistant events fire exactly once per real transition.
function commitPhase(next, reason) {
  clearPhaseConfirm();
  phase = next;
  phaseObserved = next;

  // Always-on-top tracks being *connected* — the lobby doesn't need to float,
  // regardless of when the user wants automations to fire.
  const connected = next === 'in_call';
  if (connected !== inMeeting) {
    inMeeting = connected;
    applyWindowPrefs();
  }
  if (!connected) closePresentationWindow(`phase ${next}`);

  const present = phaseIsPresent(next);
  if (present !== haPresent) {
    haPresent = present;
    console.log(`[meetloaf] meeting ${present ? 'joined' : 'left'} (${next}, ${reason})`);
    fireHomeAssistant(present ? 'join' : 'leave', { reason, phase: next });
  }
}

async function pollPhase() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Cheap negative check first — no need to touch the renderer on the home
  // page, and this is also what catches "navigated away while hidden".
  if (!isInActiveMeeting()) {
    observePhase('away', 'poll');
    return;
  }
  try {
    // The pop-out rides on this poll rather than a timer of its own: it's the
    // only clock that keeps full rate while MeetLoaf is hidden in the tray,
    // which is exactly when a presentation starting matters most.
    const state = await mainWindow.webContents.executeJavaScript(`
      (() => ({
        phase: typeof window.__meetloafCallPhase === 'function'
          ? window.__meetloafCallPhase() : null,
        presenting: typeof window.__meetloafPresentationTick === 'function'
          ? window.__meetloafPresentationTick(${popOutEnabled() && phase === 'in_call'}) : false
      }))()
    `);
    if (state && typeof state.phase === 'string') observePhase(state.phase, 'poll');
  } catch {
    // Page mid-navigation or renderer gone — the next tick will catch up.
  }
}

// Leaving the meeting URL ends things immediately rather than on a confirmation
// window: there's no ambiguity to settle, and a device left on is the failure
// we most want to avoid.
function checkMeetingState() {
  if (!isInActiveMeeting()) {
    if (phase !== 'away') commitPhase('away', 'navigation');
    return;
  }
  // Nothing behind a meeting is worth going back to, and a stray back action —
  // a mouse side button, a remapped shortcut, a swipe — would hang up the call.
  // Emptying the history makes every one of them a no-op, whatever sent it.
  mainWindow.webContents.navigationHistory.clear();
  // We're on a meeting URL — if a link was asked for, this is it. Runs before
  // the phase work because the link is worth having at the green room, before
  // you've joined.
  copyMeetingLinkIfPending();
  // Arriving at a meeting URL: re-evaluate with whatever the DOM last said.
  // On an in-page navigation the phase string may not change at all, so the
  // renderer's own change-detection wouldn't report anything.
  observePhase(phaseObserved, 'navigation');
}

// ─── Instant meeting ───────────────────────────────────────────────────────
//
// meet.google.com/new creates a meeting and redirects to its real URL, so the
// link can be read straight off the address bar once we land. That's the whole
// reason this doesn't touch the DOM: Meet's "Copy joining info" button would
// mean finding a control by its label, clicking it, and reading back whatever
// it put on the clipboard — three fragile steps to obtain something the URL
// already tells us, and it would yield a multi-line block with a dial-in
// number rather than a link you'd paste into a chat.
const INSTANT_MEETING_URL = 'https://meet.google.com/new';
// How long to keep waiting for the redirect. /new resolves in a second or two;
// longer than this means we were bounced to a sign-in page or refused by a
// Workspace policy, and there is nothing worth copying.
const INSTANT_MEETING_TIMEOUT_MS = 20000;

let instantCopyTimer = null;

function cancelInstantCopy(reason) {
  if (!instantCopyTimer) return;
  clearTimeout(instantCopyTimer);
  instantCopyTimer = null;
  if (reason) console.log(`[meetloaf] instant meeting: ${reason}`);
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    // Silent: a global shortcut is usually pressed while you're mid-sentence
    // in another app, and this is a confirmation, not an alert.
    new Notification({ title, body, silent: true }).show();
  } catch (err) {
    console.warn(`Notification failed: ${err.message}`);
  }
}

function startInstantMeeting() {
  // The shortcut is global by default, so it can arrive from another app —
  // possibly from someone who has forgotten they're already in a call.
  // Navigating away would hang up on them without asking.
  if (inMeeting) {
    console.log('[meetloaf] instant meeting ignored — already in a call');
    notify('Already in a meeting', 'Leave the current call first.');
    return;
  }
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();

  cancelInstantCopy();
  instantCopyTimer = setTimeout(
    () => cancelInstantCopy('gave up waiting for the meeting URL'),
    INSTANT_MEETING_TIMEOUT_MS
  );
  mainWindow.loadURL(INSTANT_MEETING_URL);
}

// Called from checkMeetingState, which already runs on every navigation.
//
// Deliberately *not* cancelled when a navigation lands somewhere that isn't a
// meeting: /new redirects, and whether that redirect arrives as one navigation
// or two (server-side vs. from the page) isn't ours to rely on. Cancelling on
// the first non-meeting URL would abandon the copy one step early. The timeout
// is the only thing that gives up, so the worst case is copying a meeting link
// the user reached another way within the window — still a correct link.
function copyMeetingLinkIfPending() {
  if (!instantCopyTimer || !mainWindow || mainWindow.isDestroyed()) return;
  let link;
  try {
    const u = new URL(mainWindow.webContents.getURL());
    // Canonical form only. Meet appends ?authuser=… and friends, which nobody
    // wants pasted into a chat.
    link = `https://meet.google.com${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return;
  }
  cancelInstantCopy();
  clipboard.writeText(link);
  console.log(`[meetloaf] instant meeting link copied: ${link}`);
  notify('Meeting link copied', link);
}

function startPhasePoll() {
  if (phasePollTimer) clearInterval(phasePollTimer);
  phasePollTimer = setInterval(() => { pollPhase(); }, PHASE_POLL_MS);
}

// ─── Home Assistant integration ────────────────────────────────────────────

// Requests are fire-and-forget from the caller's perspective, but we keep the
// promise around so the quit path can wait for an in-flight "leave" instead of
// killing the process mid-request.
let haPending = Promise.resolve();

function haConfig() {
  return normalizeHomeAssistant(config.homeAssistant);
}

function currentMeetingCode() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const u = new URL(mainWindow.webContents.getURL());
    const m = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Which service to call in `service` mode, derived from the entity's domain so
// the user only has to type one thing. Stateful toggles map join/leave onto
// on/off, which is what you want for a single "in a meeting" helper entity;
// automations and scripts just get triggered on both events.
const HA_TOGGLE_DOMAINS = ['input_boolean', 'switch', 'light', 'fan', 'siren'];

function haServiceFor(entityId, event) {
  const domain = String(entityId).split('.')[0];
  if (domain === 'automation') return { domain: 'automation', service: 'trigger' };
  if (domain === 'script') return { domain: 'script', service: 'turn_on' };
  if (domain === 'scene') return { domain: 'scene', service: 'turn_on' };
  if (HA_TOGGLE_DOMAINS.includes(domain)) {
    return { domain, service: event === 'leave' ? 'turn_off' : 'turn_on' };
  }
  return { domain: 'homeassistant', service: event === 'leave' ? 'turn_off' : 'turn_on' };
}

// Turn (config, event) into a concrete request, or an { error } describing what
// the user still needs to fill in. Kept separate from the sending so the
// Settings "Test" button can surface configuration problems verbatim.
function haBuildRequest(ha, event, payload) {
  const target = event === 'leave' ? ha.leave : ha.join;
  if (!target) return { error: `No Home Assistant ${event} target configured` };

  if (ha.mode === 'webhook') {
    let url;
    if (/^https?:\/\//i.test(target)) {
      url = target;
    } else if (!ha.baseUrl) {
      return { error: 'Set the Home Assistant base URL, or paste a full webhook URL' };
    } else {
      url = `${ha.baseUrl}/api/webhook/${encodeURIComponent(target)}`;
    }
    return { url, headers: { 'Content-Type': 'application/json' }, body: payload };
  }

  // service mode
  if (!ha.baseUrl) return { error: 'Set the Home Assistant base URL' };
  if (!ha.token) return { error: 'Set a long-lived access token' };
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(target)) {
    return { error: `"${target}" isn't an entity ID (expected e.g. automation.meeting_started)` };
  }
  const { domain, service } = haServiceFor(target, event);
  return {
    url: `${ha.baseUrl}/api/services/${domain}/${service}`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ha.token}`
    },
    // The REST API takes service data, not our envelope — the context we send
    // to webhooks has nowhere to go here, so only entity_id travels.
    body: { entity_id: target }
  };
}

// Log/report-safe description of where a request went: strips the webhook ID
// (it's a bearer secret) and any query string.
function haRedact(url) {
  return String(url).replace(/(\/api\/webhook\/)[^/?#]+/, '$1\u2026').split('?')[0];
}

// fetch() reports every transport failure as the bare string "fetch failed" and
// puts the actual reason in err.cause. Dropping that cost six days of silent
// failures once: the app said "fetch failed", which is true of a refused
// connection, a DNS miss, an expired certificate and a blocked local network
// alike, and nothing distinguished them.
const CONNECT_FAILURES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTDOWN', 'EACCES'
]);

function describeFetchError(err, timeoutMs) {
  if (err.name === 'AbortError') return `timed out after ${timeoutMs}ms`;
  const code = err.cause && (err.cause.code || err.cause.message);
  const base = code ? `${err.message}: ${code}` : err.message;
  // A connection-level failure on macOS is very often the Local Network
  // permission rather than anything about Home Assistant — and the OS denies
  // it silently, so nothing else will ever say so.
  if (process.platform === 'darwin' && (!code || CONNECT_FAILURES.has(code))) {
    return `${base} — if Home Assistant is on your LAN, check System Settings → Privacy & Security → Local Network, and any per-app firewall (LuLu, Little Snitch) for a rule covering MeetLoaf`;
  }
  return base;
}

async function haSend(url, headers, body, { timeoutMs = 5000, attempts = 2 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // net.fetch, not the global fetch. They are not interchangeable here:
      // net.fetch goes through Chromium's network stack, the global one through
      // Node's sockets. On macOS the local-network permission is only granted
      // to the Chromium path, so a Home Assistant on the LAN answers net.fetch
      // and refuses Node with EHOSTUNREACH — but *only* when the app is
      // launched normally. Launched from a terminal it inherits the terminal's
      // own grant and both work, which is what made this take six days to find.
      const res = await net.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        // 4xx is a configuration problem — a retry will fail identically.
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, status: res.status, error: `HTTP ${res.status} from ${haRedact(url)}` };
        }
        lastErr = `HTTP ${res.status}`;
      } else {
        return { ok: true, status: res.status };
      }
    } catch (err) {
      lastErr = describeFetchError(err, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, error: `${lastErr} (${haRedact(url)})` };
}

// `event` is 'join' | 'leave'. Failures are logged, never surfaced as dialogs —
// a smart-home hook going quiet must not interrupt a meeting.
function fireHomeAssistant(event, extra = {}) {
  const ha = haConfig();
  if (!ha.enabled) return Promise.resolve({ ok: false, skipped: true });

  const payload = {
    event,
    app: 'meetloaf',
    version: pkg.version,
    meeting_code: currentMeetingCode(),
    url: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : null,
    timestamp: new Date().toISOString(),
    ...extra
  };

  const req = haBuildRequest(ha, event, payload);
  if (req.error) {
    console.warn(`[meetloaf] Home Assistant ${event} not sent: ${req.error}`);
    return Promise.resolve({ ok: false, error: req.error });
  }

  const run = haSend(req.url, req.headers, req.body).then((result) => {
    if (result.ok) console.log(`[meetloaf] Home Assistant ${event} sent -> ${haRedact(req.url)}`);
    else console.warn(`[meetloaf] Home Assistant ${event} failed: ${result.error}`);
    return result;
  });

  // Chain rather than replace, so a quit-time flush waits for everything.
  haPending = haPending.then(() => run).catch(() => {});
  return run;
}

// Settings "Test" button: same path as a real event, but always sends (even
// when the integration is disabled) and reports the outcome to the renderer.
ipcMain.handle('ha:test', async (_e, which) => {
  const event = which === 'leave' ? 'leave' : 'join';
  const ha = haConfig();
  const payload = {
    event,
    app: 'meetloaf',
    version: pkg.version,
    meeting_code: currentMeetingCode(),
    url: null,
    phase: event === 'leave' ? 'away' : (ha.joinOn === 'connected' ? 'in_call' : 'lobby'),
    test: true,
    timestamp: new Date().toISOString()
  };
  const req = haBuildRequest(ha, event, payload);
  if (req.error) return { ok: false, error: req.error };
  const result = await haSend(req.url, req.headers, req.body, { attempts: 1 });
  return result.ok ? { ok: true, status: result.status } : { ok: false, error: result.error };
});

// Reported by the DOM watcher in main-inject.js (via main-preload.js), which
// keys off the presence of Meet's "Leave call" control.
ipcMain.on('main:meeting-phase', (e, raw) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Only the Meet window speaks for meeting state — not auth popups or the
  // transient windows Meet opens.
  if (e.sender !== mainWindow.webContents) return;
  observePhase(typeof raw === 'string' ? raw : 'unknown', 'dom');
});

// Triggered by the injected "MeetLoaf Settings" link in Meet's own modal.
ipcMain.on('main:open-settings', () => openSettingsWindow());

// ─── Firefox extension routing helpers ─────────────────────────────────────

// Firefox-family browsers — all share Mozilla's WebExtensions runtime and
// accept signed XPIs. Order matters: more-canonical builds first so we
// pick a "real" Firefox if both are installed.
//
// On macOS each entry is an .app bundle; on Windows it's a list of likely
// .exe locations (per-machine installs under Program Files, per-user ones
// under %LOCALAPPDATA%). The first path that exists wins.
const WIN_DIRS = {
  pf: process.env.ProgramFiles || 'C:\\Program Files',
  pf86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  local: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
};

function winPaths(rel) {
  return [WIN_DIRS.pf, WIN_DIRS.pf86, WIN_DIRS.local, path.join(WIN_DIRS.local, 'Programs')]
    .map((base) => path.join(base, rel));
}

const FIREFOX_CANDIDATES = IS_WIN ? [
  { name: 'Firefox', paths: winPaths('Mozilla Firefox\\firefox.exe') },
  { name: 'Firefox Developer Edition', paths: winPaths('Firefox Developer Edition\\firefox.exe') },
  { name: 'Firefox Nightly', paths: winPaths('Firefox Nightly\\firefox.exe') },
  { name: 'Zen Browser', paths: winPaths('Zen Browser\\zen.exe') },
  { name: 'LibreWolf', paths: winPaths('LibreWolf\\librewolf.exe') },
  { name: 'Waterfox', paths: winPaths('Waterfox\\waterfox.exe') },
  { name: 'Floorp', paths: winPaths('Ablaze Floorp\\floorp.exe') }
] : [
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
const CHROMIUM_CANDIDATES = IS_WIN ? [
  { name: 'Google Chrome', paths: winPaths('Google\\Chrome\\Application\\chrome.exe') },
  { name: 'Google Chrome Canary', paths: winPaths('Google\\Chrome SxS\\Application\\chrome.exe') },
  { name: 'Chromium', paths: winPaths('Chromium\\Application\\chrome.exe') },
  { name: 'Brave Browser', paths: winPaths('BraveSoftware\\Brave-Browser\\Application\\brave.exe') },
  { name: 'Vivaldi', paths: winPaths('Vivaldi\\Application\\vivaldi.exe') },
  { name: 'Opera', paths: winPaths('Opera\\opera.exe') },
  { name: 'Thorium', paths: winPaths('Thorium\\Application\\thorium.exe') },
  // Last: Edge ships with Windows, so it's nearly always present and would
  // otherwise shadow the browser people actually use.
  { name: 'Microsoft Edge', paths: winPaths('Microsoft\\Edge\\Application\\msedge.exe') }
] : [
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
    for (const p of c.paths || [c.path]) {
      if (fs.existsSync(p)) return { name: c.name, path: p };
    }
  }
  return null;
}

function findFirefox() { return findInList(FIREFOX_CANDIDATES); }
function findChromium() { return findInList(CHROMIUM_CANDIDATES); }

// Open `arg` (a URL or file) in a specific browser.
// macOS: `open -a <full path>` is unambiguous for variant browsers (Zen,
// LibreWolf, etc.) whose canonical app name might not match what `open`
// expects when given just the human name.
// Windows/Linux: run the executable directly. Spawned detached rather than
// via execFile, because a cold-started browser doesn't exit until it's
// closed and we'd otherwise wait on it for the whole session.
function openInBrowser(browser, arg) {
  const { execFile, spawn } = require('child_process');
  return new Promise((resolve) => {
    if (IS_MAC) {
      execFile('open', ['-a', browser.path, arg], (err) => {
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true });
      });
      return;
    }
    try {
      const child = spawn(browser.path, [arg], { detached: true, stdio: 'ignore' });
      child.once('error', (err) => resolve({ ok: false, error: err.message }));
      child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

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
  // Reveal the folder itself, selected, in Finder / Explorer.
  shell.showItemInFolder(dir);
  return { ok: true };
});

ipcMain.handle('chrome:open-extensions', async () => {
  const browser = findChromium();
  if (!browser) return { ok: false, error: 'No Chromium-based browser found' };
  // chrome://extensions works for Chrome, Arc, Brave, Edge, and Vivaldi —
  // they all interpret chrome:// URLs internally even when launched from
  // the shell.
  return openInBrowser(browser, 'chrome://extensions');
});

ipcMain.handle('firefox:install-extension', async () => {
  const ff = findFirefox();
  if (!ff) return { ok: false, error: 'No Firefox-family browser found' };

  const xpi = path.join(__dirname, 'firefox-extension.xpi');
  if (!fs.existsSync(xpi)) {
    return { ok: false, error: 'Extension XPI not bundled. Run extension/build.sh.' };
  }

  // The browser sees the .xpi extension and shows its install confirmation
  // dialog.
  return openInBrowser(ff, xpi);
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

  // No live window yet — cold start (the meet:// launch reaches us before
  // whenReady builds the window) or a relaunch after quit. Stash the target
  // and make sure a window gets built; createWindow() consumes pendingDeepLink
  // as its initial page. Previously this returned early and the link was
  // silently dropped, so the app opened on the Meet home page.
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLink = target;
    if (app.isReady()) createWindow();
    return;
  }

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
  // Idempotent: if a window already exists (e.g. a deep link arrives while
  // we're running), surface it and honor any pending deep link rather than
  // spawning a second window.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (pendingDeepLink) {
      mainWindow.loadURL(pendingDeepLink);
      pendingDeepLink = null;
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: config.window?.width || 1200,
    height: config.window?.height || 800,
    // The inset traffic-light look is macOS-only. Elsewhere, hiding the
    // title bar removes the close/minimise/maximise buttons entirely, so
    // keep the native frame and tuck the menu bar behind Alt.
    ...(IS_MAC
      ? {
          titleBarStyle: 'hiddenInset',
          // Push traffic lights down so they sit vertically inside Meet's header
          // bar (where the hamburger / Meet logo live) instead of floating above
          // it. y=22 lines them up with the natural center of Meet's top bar.
          trafficLightPosition: { x: 18, y: 22 }
        }
      : { autoHideMenuBar: true }),
    icon: IS_MAC ? undefined : path.join(__dirname, 'icon.png'),
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
  // Open straight to a deep-linked meeting if one was queued before the
  // window existed; otherwise the Meet home page.
  mainWindow.loadURL(pendingDeepLink || MEET_URL);
  pendingDeepLink = null;

  // Track whether the user is in a meeting (URL matches xxx-yyyy-zzz pattern).
  // Always-on-top is gated on this so it only activates during calls,
  // not on the lobby. Both `did-navigate` (full page loads) and
  // `did-navigate-in-page` (Meet's SPA route changes) are needed.
  mainWindow.webContents.on('did-navigate', checkMeetingState);
  mainWindow.webContents.on('did-navigate-in-page', checkMeetingState);
  // A full page load replaces the renderer that owns the pop-out, leaving a
  // window with a dead stream behind. Worse, the freshly injected script has
  // no handle on it and would open a second one — so close it here. Reloading
  // straight back into the same meeting isn't a phase change, so the phase
  // machinery never sees this case.
  mainWindow.webContents.on('did-navigate', () => closePresentationWindow('page load'));
  // A crashed/killed renderer means the call is over even though no navigation
  // happened — without this the "leave" event would never fire.
  mainWindow.webContents.on('render-process-gone', () => {
    cancelInstantCopy('renderer gone');
    commitPhase('away', 'renderer-gone');
  });
  startPhasePoll();

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
    // Only needed under the hidden macOS title bar; with a native frame the
    // strip would just eat clicks on Meet's header.
    if (IS_MAC) mainWindow.webContents.insertCSS(DRAG_REGION_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(MEET_INJECTION).catch(() => {});
  });

  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    // Hiding is only safe when something can bring the window back: the Dock
    // on macOS, the tray icon elsewhere. Without a tray on Windows/Linux a
    // hidden window is unreachable, so treat close as quit instead.
    if (!IS_MAC && !tray) {
      app.isQuitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Nothing is feeding the viewer any more; an orphaned black window would
    // just be confusing.
    closePresentationWindow('main window closed');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Our own presentation viewer, opened by the injected script. Named so we
    // can tell it apart from Meet's own transient about:blank popups below.
    if (frameName === PRESENTATION_FRAME) {
      return { action: 'allow', overrideBrowserWindowOptions: presentationWindowOptions() };
    }
    // Google auth popups stay in-app.
    if (url.startsWith('https://accounts.google.com')) {
      return { action: 'allow' };
    }
    // Windows Meet opens programmatically (e.g. Picture-in-Picture, transient
    // popups) arrive with about:blank / blob: / data: URLs. Let them open
    // in-app — handing these to shell.openExternal throws "No application
    // found to open URL" (macOS has no handler for about:blank).
    if (!/^https?:\/\//i.test(url)) {
      return { action: 'allow' };
    }
    // Real external links go to the user's browser.
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (win, { frameName }) => {
    if (frameName === PRESENTATION_FRAME) adoptPresentationWindow(win);
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

// ─── Auto-update (Windows only) ────────────────────────────────────────────
//
// electron-updater downloads the new installer and runs it. Windows only, and
// that isn't an oversight: on macOS electron-updater drives Squirrel.Mac, which
// verifies the downloaded app's code signature before applying it. MeetLoaf is
// ad-hoc signed (no Apple Developer ID), so that check fails and there is no
// flag to skip it — the verification is precisely what stops an update being
// swapped in transit. macOS therefore keeps the notify-and-open-the-page path
// below until a Developer ID exists, at which point this becomes a two-line
// change: drop the IS_WIN gate and add "zip" to mac.target.
//
// Requires the repo to be public, or the metadata request 404s exactly like
// the GitHub API path did.
let autoUpdater = null;
let updateDownloaded = false;

function initAutoUpdater() {
  // Unpackaged runs have no app-update.yml, and electron-updater throws rather
  // than degrading, so `npm start` would break.
  if (!IS_WIN || !app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn(`electron-updater unavailable: ${err.message}`);
    return;
  }
  // Ask before spending someone's bandwidth on a ~100MB installer.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: `MeetLoaf ${info.version} is available.`,
      detail: `You have ${app.getVersion()}. Download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) autoUpdater.downloadUpdate().catch((err) => {
      console.error(`Update download failed: ${err.message}`);
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateDownloaded = true;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: `MeetLoaf ${info.version} is ready to install.`,
      detail: 'Installing restarts the app. It will also install by itself next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (response !== 0) return;
    // quitAndInstall spawns the installer and quits. The before-quit handler
    // may hold the quit briefly to flush a Home Assistant "leave" — that's
    // fine, the installer waits for the process to exit either way.
    app.isQuitting = true;
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.error(`Auto-update error: ${err && err.message}`);
  });
}

// Manual checks want to hear "you're up to date" or an error; background ones
// should stay quiet. These two listeners are attached per-check rather than in
// init so a background poll can't surface a dialog.
function checkForUpdatesWin(manual) {
  const once = (event, fn) => {
    const wrapped = (...args) => { autoUpdater.off(event, wrapped); fn(...args); };
    autoUpdater.on(event, wrapped);
  };
  if (manual) {
    once('update-not-available', () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `You're on the latest version (${app.getVersion()}).`
      });
    });
    once('error', (err) => {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Could not check for updates.',
        detail: err && err.message ? err.message : String(err)
      });
    });
  }
  if (updateDownloaded) {
    // Already fetched and waiting; re-running the check would find nothing new.
    autoUpdater.emit('update-downloaded', { version: 'the downloaded update' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    console.error(`Update check failed: ${err.message}`);
  });
}

async function checkForUpdates({ manual = false } = {}) {
  if (!manual && Date.now() - lastUpdateCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS) return;
  if (autoUpdater) {
    lastUpdateCheckAt = Date.now();
    return checkForUpdatesWin(manual);
  }
  return checkForUpdatesViaReleasePage({ manual });
}

// macOS (and any unpackaged run): compare tags and offer to open the release
// page. No download, no install — see the note above.
async function checkForUpdatesViaReleasePage({ manual = false } = {}) {
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
  // macOS wants a monochrome "Template" image it can tint for the menu bar.
  // The Windows notification area has no tinting, and a black glyph vanishes
  // on the dark taskbar, so use the full-colour app icon there.
  const iconPath = path.join(__dirname, IS_MAC ? 'trayTemplate.png' : 'tray.png');
  if (!fs.existsSync(iconPath)) {
    console.warn('Tray icon missing — run npm run icon to build it');
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (IS_MAC) image.setTemplateImage(true); // macOS auto-tints for menu bar appearance
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

// ─── Screen-share source picker (Windows / Linux) ──────────────────────────
// macOS delegates this to ScreenCaptureKit's native picker. Everywhere else
// getDisplayMedia() lands in our handler with no UI, so we show a small modal
// listing screens and windows. Resolves { id, audio } or null on cancel.
let pickerWindow = null;
let pickerResolve = null;

function pickDisplaySource(sources) {
  // A second share request while the picker is open replaces the first.
  if (pickerResolve) { pickerResolve(null); pickerResolve = null; }
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();

  const payload = {
    systemAudio: IS_WIN,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
    }))
  };

  return new Promise((resolve) => {
    pickerResolve = resolve;
    pickerWindow = new BrowserWindow({
      width: 760,
      height: 560,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!(mainWindow && !mainWindow.isDestroyed()),
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Share your screen',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
      webPreferences: {
        preload: path.join(__dirname, 'picker', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    });
    pickerWindow.setMenuBarVisibility(false);
    pickerWindow.loadFile(path.join(__dirname, 'picker', 'index.html'));
    pickerWindow.webContents.once('did-finish-load', () => {
      if (pickerWindow && !pickerWindow.isDestroyed()) {
        pickerWindow.webContents.send('picker:sources', payload);
      }
    });
    pickerWindow.on('closed', () => {
      pickerWindow = null;
      // Closed without choosing = cancel.
      if (pickerResolve === resolve) { pickerResolve = null; resolve(null); }
    });
  });
}

ipcMain.on('picker:choose', (_e, choice) => {
  const resolve = pickerResolve;
  pickerResolve = null;
  if (resolve) {
    resolve(choice && typeof choice.id === 'string'
      ? { id: choice.id, audio: choice.audio === true }
      : null);
  }
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

// ─── Permissions ───────────────────────────────────────────────────────────
//
// What the OS will tell us is uneven, and the panel is honest about that rather
// than inventing certainty:
//
//   camera / microphone  readable on macOS and Windows; promptable on macOS
//                        only, and only while the status is not-determined —
//                        once denied the OS never asks again and Settings is
//                        the only route.
//   screen               readable on macOS. Windows always reports granted
//                        because it has no such permission, so the row is
//                        dropped there rather than shown as a permanent tick.
//   local network        macOS 15+ gates LAN access and Electron exposes no way
//                        to read or request it. The only available signal is
//                        whether a LAN connection actually succeeds, so this row
//                        is probed rather than queried. It is the permission
//                        that silently broke Home Assistant webhooks for six
//                        days, which is why it is worth surfacing imperfectly.
const SETTINGS_PANES = {
  darwin: {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    localNetwork: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
  },
  win32: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone'
  }
};

function settingsPane(id) {
  return (SETTINGS_PANES[process.platform] || {})[id] || null;
}

function mediaStatus(type) {
  try {
    return systemPreferences.getMediaAccessStatus(type);
  } catch {
    // Linux, or an Electron that doesn't implement it for this type.
    return 'unknown';
  }
}

function permissionRows() {
  const rows = [
    { id: 'camera', label: 'Camera', detail: 'Needed for video in meetings.', status: mediaStatus('camera') },
    { id: 'microphone', label: 'Microphone', detail: 'Needed to be heard in meetings.', status: mediaStatus('microphone') }
  ];

  if (IS_MAC) {
    rows.push({ id: 'screen', label: 'Screen Recording', detail: 'Needed to share your screen.', status: mediaStatus('screen') });
    rows.push({
      id: 'localNetwork',
      label: 'Local Network',
      detail: 'Needed to reach Home Assistant on your network.',
      status: 'untested',
      testable: true
    });
  }

  return rows.map((r) => ({
    ...r,
    // askForMediaAccess only prompts from not-determined, and only on macOS.
    canPrompt: IS_MAC && r.status === 'not-determined' && (r.id === 'camera' || r.id === 'microphone'),
    pane: !!settingsPane(r.id)
  }));
}

ipcMain.handle('permissions:get', () => ({ platform: process.platform, rows: permissionRows() }));

ipcMain.handle('permissions:request', async (_e, id) => {
  if (!IS_MAC || (id !== 'camera' && id !== 'microphone')) {
    return { ok: false, error: 'This permission can only be changed in system settings' };
  }
  try {
    const granted = await systemPreferences.askForMediaAccess(id);
    return { ok: granted, status: mediaStatus(id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('permissions:open-settings', async (_e, id) => {
  const pane = settingsPane(id);
  if (!pane) return { ok: false, error: 'No settings pane for this permission on this platform' };
  try {
    await shell.openExternal(pane);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Probes the configured Home Assistant base URL with a plain GET of the root,
// so it can't trigger an automation the way firing a webhook would.
ipcMain.handle('permissions:test-local-network', async () => {
  const ha = haConfig();
  if (!ha.baseUrl) {
    return { ok: false, status: 'unconfigured', error: 'Set a Home Assistant base URL first (Home Assistant tab)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // net.fetch, matching haSend. Probing with the global fetch would report
    // "blocked" on a machine where Home Assistant works perfectly, because only
    // the Chromium stack holds the local-network grant.
    await net.fetch(ha.baseUrl, { method: 'GET', signal: controller.signal });
    return { ok: true, status: 'granted', detail: `Reached ${haRedact(ha.baseUrl)}` };
  } catch (err) {
    return { ok: false, status: 'blocked', error: describeFetchError(err, 5000) };
  } finally {
    clearTimeout(timer);
  }
});

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
        // Hide / Hide Others / Show All are macOS app-menu conventions with
        // no Windows or Linux equivalent.
        ...(IS_MAC
          ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
          : []),
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
        { label: 'Pop Out Presentation', click: () => togglePresentationWindow() },
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
    // Electron accelerators take the literal character for punctuation keys,
    // not the DOM event.code name. Registering "Backquote" throws outright, so
    // every punctuation binding silently failed at startup — visible only as a
    // console warning nobody sees unless they run the app from a terminal.
    Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/',
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
  // `meta` is ⌘ on macOS but the Windows/Super key elsewhere.
  if (mods.includes('meta')) parts.push(IS_MAC ? 'Cmd' : 'Super');
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
    // The popped-out presentation is a plain viewer: Cmd+W there has to close
    // that window, not leave the call.
    if (presentationWindow && !presentationWindow.isDestroyed() &&
        presentationWindow.webContents === webContents) return;
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
    const accel = normalizeAccelerator(entry?.accelerator);
    if (!accel) return;
    if (entry.global) {
      try {
        const ok = globalShortcut.register(accel, fn);
        if (!ok) console.warn(`Shortcut unavailable: ${accel}`);
      } catch (err) {
        console.warn(`Failed to register ${accel}: ${err.message}`);
      }
    } else {
      // Last write wins if two local shortcuts share an accelerator —
      // same constraint applies to global ones via the OS.
      localShortcutMap.set(accel, fn);
    }
  };

  bind(s.mute, () => clickByAriaLabel('turn (on|off) microphone'));
  bind(s.camera, () => clickByAriaLabel('turn (on|off) camera'));
  bind(s.hand, () => clickByAriaLabel('(raise|lower) hand'));
  bind(s.toggleWindow, () => toggleMainWindow());
  bind(s.newMeeting, () => startInstantMeeting());
  bind(s.leave, () => clickByAriaLabel('leave call'));
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

  // On Windows the registration is a command line. Under `npm start` the
  // executable is the stock electron.exe, which needs the app path passed
  // explicitly or a clicked meet:// link launches an empty Electron.
  if (!IS_MAC && process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('meet', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('meet');
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    // If we're already running, route it now. If the URL is what launched us
    // (open-url fires before whenReady), just queue it: the startup path opens
    // pendingDeepLink after loadConfig + createWindow. Calling handleDeepLink
    // during the 'ready' emit would run before createWindow and get dropped.
    if (app.isReady()) handleDeepLink(url);
    else pendingDeepLink = normalizeMeetUrl(url);
  });

  // Local shortcuts are routed through each window's webContents. Attaching
  // before any window is created ensures we catch all of them — main,
  // settings, welcome, and any auth popups Google opens.
  app.on('web-contents-created', (_e, wc) => attachLocalShortcuts(wc));

  app.whenReady().then(() => {
    loadConfig();

    // setActivationPolicy alone doesn't surface the dock icon — dock.show()
    // is what physically does it. Single call at startup.
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular');
      if (app.dock && typeof app.dock.show === 'function') app.dock.show();
    }

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['media', 'mediaKeySystem', 'notifications', 'display-capture', 'picture-in-picture'];
      callback(allowed.includes(permission));
    });

    // Screen sharing: Meet calls getDisplayMedia(); without a registered
    // handler Electron returns no sources and Meet shows "Something went
    // wrong". On macOS 14+ the `useSystemPicker: true` flag delegates
    // source selection to ScreenCaptureKit's native picker. The function
    // arg is the fallback for older macOS where we provide our own choice.
    //
    // Windows and Linux have no system picker, so there the handler is always
    // what runs — and blindly taking sources[0] would share the primary
    // display without asking. Show our own picker instead.
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true
        });
        if (!sources.length) return callback({});
        if (IS_MAC) return callback({ video: sources[0] });
        const choice = await pickDisplaySource(sources);
        if (!choice) return callback({});
        const video = sources.find((s) => s.id === choice.id);
        if (!video) return callback({});
        // 'loopback' (system audio) is only implemented on Windows.
        callback(IS_WIN && choice.audio ? { video, audio: 'loopback' } : { video });
      } catch (err) {
        console.error('display-media handler error:', err.message);
        callback({});
      }
    }, { useSystemPicker: true });

    // Windows/Linux deliver the deep link as a launch argument rather than
    // via open-url, so capture it before createWindow() opens the window.
    if (!pendingDeepLink) {
      const argvDeepLink = process.argv.find((a) => a.startsWith('meet://'));
      if (argvDeepLink) pendingDeepLink = normalizeMeetUrl(argvDeepLink);
    }

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

    initAutoUpdater();
    setTimeout(() => checkForUpdates(), 5000);
  });

  // Quitting mid-call is a "leave" — but the default quit tears the process
  // down long before an HTTP request lands, so hold the quit just long enough
  // to flush it. Guarded by haQuitFlushed since our own app.quit() re-enters.
  let haQuitFlushed = false;
  app.on('before-quit', (event) => {
    app.isQuitting = true;
    if (haQuitFlushed) return;
    haQuitFlushed = true;
    if (!haPresent || !haConfig().enabled) return;

    event.preventDefault();
    commitPhase('away', 'quit');
    const finish = () => app.quit();
    Promise.race([
      haPending,
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]).then(finish, finish);
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
