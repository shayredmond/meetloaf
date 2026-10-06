// Map e.code (physical key) -> Electron accelerator key name.
const CODE_MAP = (() => {
  const m = {};
  for (let c = 65; c <= 90; c++) m[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c);
  for (let d = 0; d <= 9; d++) m[`Digit${d}`] = String(d);
  for (let f = 1; f <= 24; f++) m[`F${f}`] = `F${f}`;
  Object.assign(m, {
    Backquote: 'Backquote',
    Minus: 'Minus',
    Equal: 'Equal',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete'
  });
  return m;
})();

const IS_MAC = window.meetloaf.platform === 'darwin';

// Pretty-print an accelerator string for display: ⌘⇧M style on macOS,
// Ctrl+Shift+M elsewhere (where ⌘/⌥ glyphs mean nothing). Cmd tokens show
// as Ctrl off-Mac, matching how main.js normalises them for registration.
const PRETTY_OTHER = {
  Cmd: 'Ctrl', Command: 'Ctrl', CmdOrCtrl: 'Ctrl', CommandOrControl: 'Ctrl',
  Super: 'Win', Meta: 'Win', Control: 'Ctrl', Option: 'Alt',
  Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/',
  Esc: 'Escape', Return: 'Enter',
  Up: '↑', Down: '↓', Left: '←', Right: '→'
};

const PRETTY = {
  Cmd: '⌘', Command: '⌘', CmdOrCtrl: '⌘', CommandOrControl: '⌘',
  Super: '⌘', Meta: '⌘',
  Ctrl: '⌃', Control: '⌃',
  Alt: '⌥', Option: '⌥',
  Shift: '⇧',
  Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/',
  Plus: '+',
  Space: '␣',
  Enter: '⏎', Return: '⏎',
  Tab: '⇥',
  Escape: '⎋', Esc: '⎋',
  Backspace: '⌫', Delete: '⌦',
  Up: '↑', Down: '↓', Left: '←', Right: '→'
};

function prettyAccelerator(accel) {
  if (!accel) return '';
  if (!IS_MAC) return accel.split('+').map((p) => PRETTY_OTHER[p] || p).join('+');
  return accel.split('+').map((p) => PRETTY[p] || p).join('');
}

function buildAcceleratorFromEvent(e) {
  const parts = [];
  // metaKey is ⌘ on macOS but the Windows key elsewhere.
  if (e.metaKey) parts.push(IS_MAC ? 'Cmd' : 'Super');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = CODE_MAP[e.code];
  if (!key) return null; // modifier-only press, or unsupported key
  parts.push(key);
  return parts.join('+');
}

const PLACEHOLDER = 'Click to record';
const RECORDING_TEXT = 'Press shortcut…';

let activeRow = null;
let statusTimer = null;

const state = { shortcuts: {}, raw: null };

function setStatus(text, kind = 'ok') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.classList.toggle('visible', !!text);
  el.style.color = kind === 'error' ? '#ff453a' : '';
  if (statusTimer) clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => setStatus(''), 2200);
}

function shortcutEntry(key) {
  const entry = state.shortcuts[key];
  if (entry && typeof entry === 'object') {
    return { accelerator: entry.accelerator || '', global: entry.global !== false };
  }
  // Be tolerant of legacy string entries while migration is in flight.
  return { accelerator: typeof entry === 'string' ? entry : '', global: true };
}

function paintRow(row) {
  const key = row.dataset.key;
  const { accelerator, global } = shortcutEntry(key);
  const captureBtn = row.querySelector('[data-capture]');
  const isEmpty = !accelerator;

  row.dataset.empty = isEmpty ? 'true' : 'false';
  captureBtn.classList.toggle('empty', isEmpty);
  captureBtn.textContent = isEmpty ? PLACEHOLDER : prettyAccelerator(accelerator);

  const globalBtn = row.querySelector('[data-global]');
  if (globalBtn) globalBtn.classList.toggle('checked', global);
}

function paintAll() {
  document.querySelectorAll('.row[data-key]').forEach(paintRow);
}

async function persist() {
  state.raw.shortcuts = { ...state.shortcuts };
  const result = await window.meetloaf.saveConfig(state.raw);
  if (result.ok) {
    setStatus('Saved');
  } else {
    setStatus(result.error || 'Save failed', 'error');
  }
}

function startRecording(row) {
  if (activeRow === row) return;
  if (activeRow) stopRecording(activeRow, { restore: true });

  activeRow = row;
  const captureBtn = row.querySelector('[data-capture]');
  captureBtn.classList.add('recording');
  captureBtn.textContent = RECORDING_TEXT;
  window.meetloaf.recordingStart();
}

function stopRecording(row, { restore = false } = {}) {
  if (!row) return;
  const captureBtn = row.querySelector('[data-capture]');
  captureBtn.classList.remove('recording');
  if (activeRow === row) activeRow = null;
  if (restore) paintRow(row);
  // Resume registration only if no other row is recording.
  if (!activeRow) window.meetloaf.recordingStop();
}

function commitRecording(row, accel) {
  const key = row.dataset.key;
  const prev = shortcutEntry(key);
  state.shortcuts[key] = { accelerator: accel || '', global: prev.global };
  paintRow(row);
  stopRecording(row);
  persist();
}

function toggleGlobal(row) {
  const key = row.dataset.key;
  const prev = shortcutEntry(key);
  state.shortcuts[key] = { accelerator: prev.accelerator, global: !prev.global };
  paintRow(row);
  persist();
}

document.addEventListener('keydown', (e) => {
  if (!activeRow) return;
  e.preventDefault();
  e.stopPropagation();

  // Esc cancels without changing
  if (e.code === 'Escape') {
    stopRecording(activeRow, { restore: true });
    return;
  }

  // Backspace/Delete with NO modifiers clears the binding
  if ((e.code === 'Backspace' || e.code === 'Delete') &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    commitRecording(activeRow, '');
    return;
  }

  const accel = buildAcceleratorFromEvent(e);
  if (!accel) return; // modifier-only, keep waiting
  commitRecording(activeRow, accel);
}, true);

document.addEventListener('click', (e) => {
  // Click outside the active recorder cancels recording
  if (activeRow && !e.target.closest('.row')?.isSameNode(activeRow)) {
    stopRecording(activeRow, { restore: true });
  }
});

async function persistRaw() {
  const result = await window.meetloaf.saveConfig(state.raw);
  setStatus(result.ok ? 'Saved' : (result.error || 'Save failed'), result.ok ? 'ok' : 'error');
}

// Settings window has a fixed height now (set in main.js). The panel
// content scrolls if it overflows. No-op `autoresize` so existing call
// sites keep working without changing each one.
function autoresize() {}

// Sidebar tab navigation: click a nav item, show its panel, hide the rest.
function setupTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('[role="tabpanel"]');
  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // Leaving a half-recorded shortcut armed would swallow keystrokes in
      // whichever panel the user lands on.
      if (activeRow) stopRecording(activeRow, { restore: true });
      const target = item.dataset.target;
      navItems.forEach((n) => {
        const isActive = n === item;
        n.classList.toggle('active', isActive);
        n.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      panels.forEach((p) => {
        p.hidden = p.id !== `panel-${target}`;
      });
      autoresize();
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  const cfg = await window.meetloaf.getConfig();
  state.raw = cfg;
  // Deep-normalize so we don't share entry objects with state.raw.shortcuts;
  // also tolerates pre-migration string values just in case.
  state.shortcuts = Object.fromEntries(
    Object.entries(cfg.shortcuts || {}).map(([k, v]) => {
      if (v && typeof v === 'object') return [k, { accelerator: v.accelerator || '', global: v.global !== false }];
      return [k, { accelerator: typeof v === 'string' ? v : '', global: true }];
    })
  );
  paintAll();

  document.querySelectorAll('.row[data-key]').forEach((row) => {
    row.querySelector('[data-capture]').addEventListener('click', (e) => {
      e.stopPropagation();
      startRecording(row);
    });
    row.querySelector('[data-clear]').addEventListener('click', (e) => {
      e.stopPropagation();
      commitRecording(row, '');
    });
    const globalBtn = row.querySelector('[data-global]');
    if (globalBtn) {
      globalBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeRow) stopRecording(activeRow, { restore: true });
        toggleGlobal(row);
      });
    }
  });

  // Window mode — Standard | Always on top. Backed by the alwaysOnTop boolean.
  const modeFromCfg = (window) => (window?.alwaysOnTop ? 'alwaysOnTop' : 'standard');

  const modeButtons = document.querySelectorAll('.mode-segmented .segment');
  const setModeUI = (mode) => {
    modeButtons.forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
  };

  setModeUI(modeFromCfg(cfg.window));

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = btn.dataset.mode;
      setModeUI(mode);
      state.raw.window = {
        ...(state.raw.window || {}),
        alwaysOnTop: mode === 'alwaysOnTop'
      };
      persistRaw();
    });
  });

  // Pop out presentations — same `window` config section as the mode above.
  const popOutBtn = document.getElementById('popOutPresentation');
  if (popOutBtn) {
    const popOutFromCfg = (w) => w?.popOutPresentation !== false;
    popOutBtn.classList.toggle('checked', popOutFromCfg(cfg.window));
    popOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !popOutBtn.classList.contains('checked');
      popOutBtn.classList.toggle('checked', next);
      state.raw.window = { ...(state.raw.window || {}), popOutPresentation: next };
      persistRaw();
    });
  }

  // Routing tab: Firefox extension install
  const firefoxStatus = document.getElementById('firefoxStatus');
  const installFirefoxBtn = document.getElementById('installFirefoxBtn');
  if (firefoxStatus && installFirefoxBtn) {
    async function refreshFirefoxStatus() {
      const info = await window.meetloaf.detectFirefox();
      if (!info.firefox) {
        const chromiumNote = info.chromium
          ? ` (${info.chromium.name} detected — Chromium-based browsers can't install Firefox extensions)`
          : '';
        firefoxStatus.textContent = `No Firefox-family browser found${chromiumNote}`;
        installFirefoxBtn.hidden = true;
        return;
      }
      if (!info.extensionBundled) {
        firefoxStatus.textContent = `${info.firefox.name} found, but the extension XPI isn't bundled. Run extension/build.sh first.`;
        installFirefoxBtn.hidden = true;
        return;
      }
      firefoxStatus.textContent = `Found ${info.firefox.name}. Click Install to add the extension.`;
      installFirefoxBtn.hidden = false;
    }
    refreshFirefoxStatus();

    installFirefoxBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await window.meetloaf.installFirefoxExtension();
      if (result?.ok) {
        setStatus('Opening Firefox…');
      } else {
        setStatus(result?.error || 'Install failed', 'error');
      }
    });
  }

  // Routing tab: Chrome / Chromium extension (manual load-unpacked flow,
  // since Chrome blocks .crx side-loading and we don't have a Web Store listing)
  const chromeStatus = document.getElementById('chromeStatus');
  const showChromeFolderBtn = document.getElementById('showChromeFolderBtn');
  const openChromeExtensionsBtn = document.getElementById('openChromeExtensionsBtn');
  const chromeInstructions = document.getElementById('chromeInstructions');
  if (chromeStatus && showChromeFolderBtn && openChromeExtensionsBtn && chromeInstructions) {
    async function refreshChromeStatus() {
      const info = await window.meetloaf.detectChrome();
      if (!info.chromium) {
        chromeStatus.textContent = 'No Chromium-based browser found';
        showChromeFolderBtn.hidden = true;
        openChromeExtensionsBtn.hidden = true;
        chromeInstructions.hidden = true;
        return;
      }
      if (!info.extensionBundled) {
        chromeStatus.textContent = `${info.chromium.name} found, but the extension folder is missing.`;
        showChromeFolderBtn.hidden = true;
        openChromeExtensionsBtn.hidden = true;
        chromeInstructions.hidden = true;
        return;
      }
      chromeStatus.textContent = `Found ${info.chromium.name}. Load the extension via developer mode:`;
      showChromeFolderBtn.hidden = false;
      openChromeExtensionsBtn.hidden = false;
      chromeInstructions.hidden = false;
    }
    refreshChromeStatus();

    showChromeFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await window.meetloaf.showChromeFolder();
      if (!result?.ok) setStatus(result?.error || 'Could not show folder', 'error');
    });

    openChromeExtensionsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await window.meetloaf.openChromeExtensions();
      if (result?.ok) setStatus('Opening browser…');
      else setStatus(result?.error || 'Could not open browser', 'error');
    });
  }

  setupHomeAssistant();

  // About section: re-run welcome tour
  const showWelcomeBtn = document.getElementById('showWelcomeBtn');
  if (showWelcomeBtn) {
    showWelcomeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.meetloaf.showWelcome();
    });
  }

  // About section: config file location
  const pathDisplay = document.getElementById('configPathDisplay');
  const resetBtn = document.getElementById('resetConfigPathBtn');
  const chooseBtn = document.getElementById('chooseConfigPathBtn');

  async function refreshConfigPath() {
    const info = await window.meetloaf.getConfigPath();
    pathDisplay.textContent = info.current;
    resetBtn.hidden = info.isDefault;
    autoresize();
  }
  refreshConfigPath();

  chooseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.meetloaf.chooseConfigPath();
    if (result?.ok) {
      setStatus('Config moved');
      refreshConfigPath();
    }
  });

  resetBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.meetloaf.resetConfigPath();
    if (result?.ok) {
      setStatus('Reset to default');
      refreshConfigPath();
    }
  });

});

// ─── Home Assistant panel ──────────────────────────────────────────────────

const HA_DEFAULTS = {
  enabled: false,
  mode: 'webhook',
  joinOn: 'lobby',
  baseUrl: '',
  token: '',
  join: '',
  leave: ''
};

const HA_JOINON_COPY = {
  lobby: 'At the earliest moment MeetLoaf can tell you are in a meeting: the pre-join screen, so lights and camera are already set up while you pick your devices — or connection itself, when there is no pre-join screen. Starting a meeting from the New button or a meet://new link goes straight in.',
  connected: 'Only once you are actually admitted and connected. Nothing fires at the pre-join screen.'
};

const HA_COPY = {
  webhook: {
    mode: 'POSTs JSON to a Home Assistant webhook. No access token needed.',
    target: 'Webhook ID, or a full webhook URL.',
    joinPlaceholder: 'meetloaf-joined',
    leavePlaceholder: 'meetloaf-left'
  },
  service: {
    mode: 'Calls the Home Assistant REST API. Needs a long-lived access token.',
    target: 'Entity ID to act on.',
    joinPlaceholder: 'automation.meeting_started',
    leavePlaceholder: 'automation.meeting_ended'
  }
};

function setupHomeAssistant() {
  const el = {
    enabled: document.getElementById('haEnabled'),
    modeHelp: document.getElementById('haModeHelp'),
    joinOnHelp: document.getElementById('haJoinOnHelp'),
    baseUrlRow: document.getElementById('haBaseUrlRow'),
    baseUrl: document.getElementById('haBaseUrl'),
    tokenRow: document.getElementById('haTokenRow'),
    token: document.getElementById('haToken'),
    join: document.getElementById('haJoin'),
    joinHelp: document.getElementById('haJoinHelp'),
    leave: document.getElementById('haLeave'),
    leaveHelp: document.getElementById('haLeaveHelp'),
    webhookHelp: document.getElementById('haWebhookHelp'),
    serviceHelp: document.getElementById('haServiceHelp')
  };
  if (!el.enabled) return;

  // Select on the data attributes, not a shared class: two segmented controls
  // in one panel meant a class-based selector matched both, and the second
  // paint pass stripped the first control's `selected`.
  const modeButtons = document.querySelectorAll('[data-ha-mode]');
  const joinOnButtons = document.querySelectorAll('[data-ha-joinon]');
  const ha = { ...HA_DEFAULTS, ...(state.raw.homeAssistant || {}) };
  if (ha.mode !== 'service') ha.mode = 'webhook';
  if (ha.joinOn !== 'connected') ha.joinOn = 'lobby';

  // Typing shouldn't write config.json on every keystroke; coalesce into one
  // save shortly after the user stops (and flush immediately on blur).
  let saveTimer = null;
  function commit({ immediate = false } = {}) {
    state.raw.homeAssistant = { ...ha };
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) {
      persistRaw();
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistRaw();
    }, 600);
  }

  function paint() {
    const copy = HA_COPY[ha.mode];
    el.enabled.classList.toggle('checked', ha.enabled);
    modeButtons.forEach((b) => b.classList.toggle('selected', b.dataset.haMode === ha.mode));
    joinOnButtons.forEach((b) => b.classList.toggle('selected', b.dataset.haJoinon === ha.joinOn));
    el.joinOnHelp.textContent = HA_JOINON_COPY[ha.joinOn];
    el.modeHelp.textContent = copy.mode;
    el.joinHelp.textContent = copy.target;
    el.leaveHelp.textContent = copy.target;
    el.join.placeholder = copy.joinPlaceholder;
    el.leave.placeholder = copy.leavePlaceholder;

    // A token is meaningless for webhooks, so the field goes away entirely
    // rather than sitting there inviting people to paste a credential.
    el.tokenRow.hidden = ha.mode !== 'service';
    el.webhookHelp.hidden = ha.mode !== 'webhook';
    el.serviceHelp.hidden = ha.mode !== 'service';

    // Full webhook URLs carry their own host, so the base URL stops mattering.
    const isFullUrl = (v) => /^https?:\/\//i.test(v);
    const baseUnused = ha.mode === 'webhook' &&
      (ha.join || ha.leave) &&
      (!ha.join || isFullUrl(ha.join)) &&
      (!ha.leave || isFullUrl(ha.leave));
    el.baseUrlRow.dataset.inactive = baseUnused ? 'true' : 'false';
  }

  el.baseUrl.value = ha.baseUrl;
  el.token.value = ha.token;
  el.join.value = ha.join;
  el.leave.value = ha.leave;
  paint();

  el.enabled.addEventListener('click', (e) => {
    e.stopPropagation();
    ha.enabled = !ha.enabled;
    paint();
    commit({ immediate: true });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      ha.mode = btn.dataset.haMode === 'service' ? 'service' : 'webhook';
      paint();
      commit({ immediate: true });
    });
  });

  joinOnButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      ha.joinOn = btn.dataset.haJoinon === 'connected' ? 'connected' : 'lobby';
      paint();
      commit({ immediate: true });
    });
  });

  [['baseUrl', el.baseUrl], ['token', el.token], ['join', el.join], ['leave', el.leave]]
    .forEach(([key, input]) => {
      input.addEventListener('input', () => {
        ha[key] = input.value.trim();
        paint();
        commit();
      });
      input.addEventListener('blur', () => commit({ immediate: true }));
      // Deliberately NOT stopping propagation: the click has to reach the
      // document handler that cancels an in-progress shortcut recording,
      // otherwise the capture-phase keydown listener eats what you type here
      // and binds it as a hotkey.
    });

  document.querySelectorAll('[data-ha-test]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const which = btn.dataset.haTest;
      // Test against what's on screen, not what was last written to disk.
      commit({ immediate: true });
      btn.disabled = true;
      setStatus(`Sending test ${which}\u2026`);
      try {
        const result = await window.meetloaf.testHomeAssistant(which);
        if (result?.ok) setStatus(`Test ${which} sent (HTTP ${result.status})`);
        else setStatus(result?.error || `Test ${which} failed`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

window.addEventListener('blur', () => {
  if (activeRow) stopRecording(activeRow, { restore: true });
});
