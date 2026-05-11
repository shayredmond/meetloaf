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

// Pretty-print an accelerator string for display (⌘⇧M style).
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
  return accel.split('+').map((p) => PRETTY[p] || p).join('');
}

function buildAcceleratorFromEvent(e) {
  const parts = [];
  if (e.metaKey) parts.push('Cmd');
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

  // Window mode — single tri-state radio replacing the previous two toggles.
  // Underlying config still uses two booleans (alwaysOnTop, miniMode), and we
  // derive the radio selection from / write to both.
  const cornerRow = document.getElementById('cornerRow');
  const triggerRow = document.getElementById('triggerRow');
  const sizeRow = document.getElementById('sizeRow');

  const modeFromCfg = (window) => {
    if (window?.alwaysOnTop) return 'alwaysOnTop';
    if (window?.miniMode) return 'miniMode';
    return 'standard';
  };

  const modeButtons = document.querySelectorAll('.mode-segmented .segment');
  const setModeUI = (mode) => {
    modeButtons.forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
    const isMini = mode === 'miniMode';
    cornerRow.dataset.disabled = isMini ? 'false' : 'true';
    triggerRow.dataset.disabled = isMini ? 'false' : 'true';
    sizeRow.dataset.disabled = isMini ? 'false' : 'true';
  };

  setModeUI(modeFromCfg(cfg.window));

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = btn.dataset.mode;
      setModeUI(mode);
      state.raw.window = {
        ...(state.raw.window || {}),
        alwaysOnTop: mode === 'alwaysOnTop',
        miniMode: mode === 'miniMode'
      };
      persistRaw();
    });
  });

  // Trigger segmented control — covered | unfocused.
  // Scoped to #triggerRow so this doesn't also clobber the mode buttons,
  // which are .segment elements too but have data-mode (not data-value).
  const segments = document.querySelectorAll('#triggerRow .segment');
  const setSelectedTrigger = (value) => {
    segments.forEach((s) => s.classList.toggle('selected', s.dataset.value === value));
  };
  setSelectedTrigger((cfg.window && cfg.window.miniTrigger) || 'covered');
  segments.forEach((seg) => {
    seg.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = seg.dataset.value;
      setSelectedTrigger(value);
      state.raw.window = { ...(state.raw.window || {}), miniTrigger: value };
      persistRaw();
    });
  });

  // Size segmented (small | medium | large) — scoped to #sizeRow so it doesn't
  // collide with the mode buttons or trigger segments.
  const sizeSegments = document.querySelectorAll('#sizeRow .segment');
  const setSelectedSize = (value) => {
    sizeSegments.forEach((s) => s.classList.toggle('selected', s.dataset.size === value));
  };
  setSelectedSize((cfg.window && cfg.window.miniSize) || 'medium');
  sizeSegments.forEach((seg) => {
    seg.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = seg.dataset.size;
      setSelectedSize(value);
      state.raw.window = { ...(state.raw.window || {}), miniSize: value };
      persistRaw();
    });
  });

  // Corner picker — radiogroup of 4 buttons. The selected one carries .selected.
  const corners = document.querySelectorAll('.corner');
  const setSelectedCorner = (value) => {
    corners.forEach((b) => b.classList.toggle('selected', b.dataset.corner === value));
  };
  setSelectedCorner((cfg.window && cfg.window.miniCorner) || 'bottom-right');
  corners.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = btn.dataset.corner;
      setSelectedCorner(value);
      state.raw.window = { ...(state.raw.window || {}), miniCorner: value };
      persistRaw();
    });
  });

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
        firefoxStatus.textContent = `No Firefox-family browser found in /Applications${chromiumNote}`;
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
        chromeStatus.textContent = 'No Chromium-based browser found in /Applications';
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

window.addEventListener('blur', () => {
  if (activeRow) stopRecording(activeRow, { restore: true });
});
