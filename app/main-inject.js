// Content script injected into every Meet page (via executeJavaScript from
// main on dom-ready). Watches for Meet's Settings dialog to open and
// appends a "MeetLoaf Settings" entry. We clone Meet's existing menu item
// to inherit their (obfuscated) class names, then swap the icon + label +
// click handler — this way our entry matches Meet's styling exactly.
(function () {
  if (window.__meetloafInjected) return;
  window.__meetloafInjected = true;

  const log = (...args) => console.log('[meetloaf]', ...args);
  const MARKER = 'data-meetloaf';

  // No separate stylesheet needed now — separation is done with inline
  // styles directly on our wrapper, which can't be overridden by Meet's CSS.

  function findSettingsTablist() {
    // Meet's settings tablist is keyed by aria-label="Settings". This is
    // user-facing accessibility metadata, much more stable than the
    // obfuscated CSS class names (Ikd8W, dbgxwe, etc.) which rotate.
    const direct = document.querySelector('[role="tablist"][aria-label="Settings" i]');
    if (direct) return direct;
    // Fallback: any tablist containing tabs labeled "Audio" + "Video".
    const tablists = document.querySelectorAll('[role="tablist"]');
    for (const tl of tablists) {
      const labels = Array.from(tl.querySelectorAll('[role="tab"]'))
        .map((t) => (t.getAttribute('aria-label') || '').toLowerCase());
      if (labels.includes('audio') && labels.includes('video')) return tl;
    }
    return null;
  }

  function closeMeetSettings() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }));
    setTimeout(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const dlg of dialogs) {
        const closeBtn = dlg.querySelector('[aria-label*="lose" i], [aria-label*="dismiss" i]');
        if (closeBtn) closeBtn.click();
      }
    }, 30);
  }

  function inject() {
    const tablist = findSettingsTablist();
    if (!tablist) return;
    if (tablist.querySelector(`[${MARKER}]`)) return; // already injected

    // Clone Meet's last menu item to inherit all their styling classes.
    const items = tablist.querySelectorAll('[role="none"]');
    if (items.length === 0) return;
    const cloned = items[items.length - 1].cloneNode(true);
    cloned.setAttribute(MARKER, 'wrapper');

    // Re-clone the button so we drop addEventListener handlers + jsaction.
    const oldButton = cloned.querySelector('button[role="tab"]');
    if (!oldButton) return;
    const newButton = oldButton.cloneNode(true);

    // Strip Meet's jsaction wiring so their dispatcher doesn't fight our click.
    ['jsaction', 'jscontroller', 'jslog', 'jsname', 'aria-describedby',
     'aria-controls', 'data-tooltip-enabled', 'data-tooltip-x-position',
     'data-tooltip-y-position'].forEach((a) => newButton.removeAttribute(a));
    newButton.setAttribute('aria-label', 'MeetLoaf Settings');
    newButton.setAttribute('aria-selected', 'false');
    newButton.setAttribute(MARKER, 'button');
    // role="tab" implies it's part of the tablist navigation. Switch to
    // role="button" so it doesn't try to participate in tab keyboard nav.
    newButton.setAttribute('role', 'button');

    // Swap the Material Symbol icon and the visible label.
    const icon = newButton.querySelector('i');
    if (icon) icon.textContent = 'breakfast_dining';
    const label = newButton.querySelector('span[jsname="V67aGc"]')
                || newButton.querySelector('span:not([class*="tooltip"])')
                || newButton;
    label.textContent = 'MeetLoaf Settings';

    function activate(e) {
      if (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      log('opening MeetLoaf Settings');
      closeMeetSettings();
      window.postMessage({ source: 'meetloaf-injected', type: 'open-settings' }, '*');
    }
    newButton.addEventListener('click', activate);
    newButton.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') activate(ev);
    });

    oldButton.replaceWith(newButton);

    // Drop the cloned tooltip; ours doesn't need one.
    const tooltip = cloned.querySelector('[role="tooltip"]');
    if (tooltip) tooltip.remove();

    // Visual separation via top margin only — Meet's wrapper styling
    // suppresses borders no matter how we inject them, so we just lean on
    // a generous gap to communicate "this isn't part of Meet's tabs."
    cloned.style.marginTop = '32px';

    tablist.appendChild(cloned);
    log('injected entry into', tablist);
  }

  // ─── "Present a browser tab" hover popover ───────────────────────────────
  //
  // Hovering Meet's Share screen button pops up a small tray above it with a
  // "Present a browser tab" pill, the way Reactions pops its emoji row. It
  // asks main to open this meeting in the browser's Companion mode (see
  // presentInBrowser() in main.js).
  //
  // It lives in its own fixed layer on <body>, never inside Meet's toolbar:
  // Meet renders the toolbar with Incremental DOM, which strips nodes it
  // didn't create on every redraw. A button injected there got removed and
  // re-added constantly, and each round made the whole toolbar flicker. The
  // Share screen button is found by its label (or its icon, which survives
  // the label changing while presenting), never by class names.
  const PRESENT_TAB_LABEL = 'Present a browser tab';
  const SHARE_ICON = 'computer_arrow_up';
  // Meet's own "Share screen" hover label sits ~28px above the button; the
  // tray goes above that rather than covering it.
  const POPOVER_LIFT = 36;
  const POPOVER_HIDE_DELAY = 200;

  function findShareScreenButton() {
    return document.querySelector('button[aria-label="Share screen" i]')
      || Array.from(document.querySelectorAll('button i.google-symbols'))
        .find((i) => i.textContent.trim() === SHARE_ICON)?.closest('button');
  }

  function isShareScreenButton(el) {
    const button = el?.closest?.('button');
    if (!button) return false;
    if (/^share screen$/i.test(button.getAttribute('aria-label') || '')) return true;
    return Array.from(button.querySelectorAll('i.google-symbols'))
      .some((i) => i.textContent.trim() === SHARE_ICON);
  }

  let popover = null;
  let popoverHideTimer = null;

  function buildPopover() {
    // Outer layer is transparent and stretches down to the Share button
    // (padding-bottom, set when shown), so the pointer can travel up to the
    // tray without crossing a gap that would close it.
    const wrap = document.createElement('div');
    wrap.setAttribute(MARKER, 'present-tab-popover');
    Object.assign(wrap.style, {
      position: 'fixed', zIndex: '2147483647', transform: 'translateX(-50%)',
      display: 'none'
    });

    const tray = document.createElement('div');
    Object.assign(tray.style, {
      background: 'rgb(30, 31, 32)', borderRadius: '24px', padding: '8px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)'
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(MARKER, 'present-tab');
    const restBg = 'rgb(51, 53, 55)';
    const hoverBg = 'rgb(68, 71, 74)';
    Object.assign(button.style, {
      display: 'flex', alignItems: 'center', gap: '10px',
      height: '48px', padding: '0 20px 0 16px', border: '0', borderRadius: '24px',
      background: restBg, color: 'rgb(227, 227, 227)', cursor: 'pointer',
      font: '500 14px/20px "Google Sans", Roboto, sans-serif', letterSpacing: '0.1px',
      whiteSpace: 'nowrap'
    });
    const icon = document.createElement('i');
    // Meet's icon font, so the glyph matches the toolbar's.
    icon.className = 'google-symbols notranslate';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'tab';
    Object.assign(icon.style, { fontSize: '24px', fontStyle: 'normal', lineHeight: '24px' });
    const label = document.createElement('span');
    label.textContent = PRESENT_TAB_LABEL;
    button.append(icon, label);

    button.addEventListener('pointerenter', () => { button.style.background = hoverBg; });
    button.addEventListener('pointerleave', () => { button.style.background = restBg; });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePopover();
      log('present a browser tab');
      window.postMessage({ source: 'meetloaf-injected', type: 'present-tab' }, '*');
    });

    tray.appendChild(button);
    wrap.appendChild(tray);
    return wrap;
  }

  function showPopover(share) {
    clearTimeout(popoverHideTimer);
    if (!popover) popover = buildPopover();
    if (!popover.isConnected) document.body.appendChild(popover);
    const b = share.getBoundingClientRect();
    popover.style.display = 'block';
    popover.style.paddingBottom = `${POPOVER_LIFT}px`;
    popover.style.left = `${Math.round(b.left + b.width / 2)}px`;
    // Bottom edge (bridge included) sits on the Share button's top edge.
    popover.style.top = 'auto';
    popover.style.bottom = `${Math.round(window.innerHeight - b.top)}px`;
  }

  function hidePopover() {
    clearTimeout(popoverHideTimer);
    if (popover) popover.style.display = 'none';
  }

  function popoverVisible() {
    return !!popover && popover.isConnected && popover.style.display !== 'none';
  }

  // Delegated from the document so it keeps working however often Meet
  // replaces the Share button's element.
  // Off unless main has said the setting is on (window.__meetloafPresentTab,
  // set on every page load and on settings save).
  document.addEventListener('pointerover', (e) => {
    if (window.__meetloafPresentTab !== true) {
      if (popoverVisible()) hidePopover();
      return;
    }
    if (isShareScreenButton(e.target)) {
      showPopover(e.target.closest('button'));
    } else if (popover && popover.contains(e.target)) {
      clearTimeout(popoverHideTimer);
    } else if (popoverVisible()) {
      clearTimeout(popoverHideTimer);
      popoverHideTimer = setTimeout(hidePopover, POPOVER_HIDE_DELAY);
    }
  }, true);
  // Going for Meet's own Share screen means they don't want ours.
  document.addEventListener('pointerdown', (e) => {
    if (isShareScreenButton(e.target)) hidePopover();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePopover();
  }, true);
  document.documentElement.addEventListener('pointerleave', hidePopover);
  window.addEventListener('blur', hidePopover);
  window.addEventListener('resize', hidePopover);

  // Called from the observer: the call ended, or the toolbar went away.
  function maintainPopover() {
    if (popoverVisible() && !findShareScreenButton()) hidePopover();
  }

  // ─── Call-phase watcher (drives the Home Assistant join/leave events) ────
  //
  // Three phases matter, and the URL can't distinguish them — the
  // xxx-yyyy-zzz code is in the address bar for all of them:
  //
  //   lobby      the pre-join / "green room" screen, where you pick your
  //              camera and mic. This is where a preparation automation needs
  //              to have already run, so it's a first-class phase, not a
  //              waiting state.
  //   in_call    admitted and connected; Meet renders "Leave call".
  //   post_call  the "You left the meeting" / "Rejoin" screen. Critically
  //              this is NOT a lobby: treating it as one would leave a camera
  //              or on-air light switched on indefinitely after you hang up.
  //
  // Anything unrecognised reports `unknown`, which main treats as "not
  // present". Failing that direction is deliberate: if Meet renames a label,
  // the worst case is an automation that doesn't fire, never a device left on.
  //
  // We match Meet's own control labels for the same reason the settings
  // injection does — the obfuscated CSS classes rotate, these don't. Unlike
  // "Leave call", the pre-join button carries its label as text rather than an
  // aria-label, so both are checked.
  //
  // This side only *observes*. Debouncing lives in the main process, because
  // MeetLoaf hides its window instead of closing it: a hidden renderer gets
  // its rAF suspended and its timers throttled, so neither the observer below
  // nor a setTimeout here can be relied on while the window is tucked away.
  // Main polls __meetloafCallPhase() on an unthrottled timer to cover that.
  const IN_CALL_RE = /leave call/i;
  const LOBBY_RE = /^(join now|ask to join|switch here|join anyway)$/i;
  const POST_CALL_RE = /^(rejoin|return to home ?screen|back to home ?screen)$/i;

  function controlLabels() {
    const labels = [];
    for (const el of document.querySelectorAll('[role="button"], button')) {
      const aria = el.getAttribute('aria-label');
      if (aria) labels.push(aria.trim());
      // Cap the length: an outer wrapper button can contain a whole subtree,
      // whose concatenated text would match almost anything.
      const text = (el.textContent || '').trim();
      if (text && text.length <= 40) labels.push(text);
    }
    return labels;
  }

  function callPhase() {
    const labels = controlLabels();
    // Order matters: in_call wins outright, and post_call is checked before
    // lobby so a "Rejoin" screen can never be mistaken for a pre-join screen.
    if (labels.some((l) => IN_CALL_RE.test(l))) return 'in_call';
    if (labels.some((l) => POST_CALL_RE.test(l))) return 'post_call';
    if (labels.some((l) => LOBBY_RE.test(l))) return 'lobby';
    return 'unknown';
  }

  // Read directly by the main process via executeJavaScript, which runs
  // regardless of how throttled the renderer's own timers are.
  window.__meetloafCallPhase = callPhase;

  let lastPosted = null;

  function reportCallPhase() {
    const observed = callPhase();
    if (observed === lastPosted) return;
    lastPosted = observed;
    log('phase:', observed);
    window.postMessage(
      { source: 'meetloaf-injected', type: 'meeting-phase', phase: observed },
      '*'
    );
  }
  // ─── Presentation pop-out ───────────────────────────────────────────────
  //
  // Meet has its own "Open in new window" control on a presentation tile, and
  // it does the right thing: a real window with the shared screen, and the main
  // view drops the share and goes back to the faces. MeetLoaf used to open its
  // own window and hand it the MediaStream by reference, which duplicated the
  // presentation rather than moving it — you ended up watching it twice.
  //
  // This is NOT the Picture-in-Picture menu item, which uses the Document PiP
  // API that Electron has never implemented (electron#39633, still open) and
  // which silently renders nothing. "Open in new window" is an ordinary popup,
  // already permitted by the window-open handler, and it works.
  //
  // So detection stays — it is the half that was always right — and the action
  // becomes a click on Meet's control. That deletes the window, the document,
  // the stream hand-off and their failure modes outright.

  const PRESENTATION_TILE_RE = /\(presentation\)|['’]s presentation\b/i;
  const OWN_PRESENTATION_RE = /\byour presentation\b/i;

  // Remote WebRTC tracks have no device behind them, so Chromium labels them
  // with their own id. Anything else is a local capture.
  function isRemoteTrack(t) {
    let settings = {};
    try { settings = t.getSettings() || {}; } catch { /* track torn down */ }
    return t.label === t.id && !settings.displaySurface;
  }

  function liveRemoteStream(v) {
    const stream = v && v.srcObject;
    if (!stream || typeof stream.getVideoTracks !== 'function') return null;
    if (!v.videoWidth || !v.videoHeight) return null;
    const tracks = stream.getVideoTracks();
    if (!tracks.length || !tracks.every((t) => t.readyState === 'live' && isRemoteTrack(t))) return null;
    return stream;
  }

  // A tile's labels (name, pin and audio buttons) are siblings of the element
  // carrying data-participant-id rather than descendants of it. Widen to the
  // largest ancestor that still holds only this one tile: everything in there
  // belongs to it, and nothing from a neighbouring tile can leak in.
  function tileScope(tile) {
    let scope = tile;
    for (let el = tile.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelectorAll('[data-participant-id]').length !== 1) break;
      scope = el;
    }
    return scope;
  }

  function tileLabels(scope) {
    const labels = [];
    for (const el of scope.querySelectorAll('[aria-label], span, [role="tooltip"]')) {
      const aria = el.getAttribute('aria-label');
      if (aria) labels.push(aria.trim());
      // Own text only: a wrapper's concatenated text could match anything.
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim();
      if (own && own.length <= 120) labels.push(own);
    }
    return labels;
  }

  function isPresentationLabelled(labels) {
    return labels.some((l) => PRESENTATION_TILE_RE.test(l)) &&
           !labels.some((l) => OWN_PRESENTATION_RE.test(l));
  }

  function inspectTiles() {
    const seen = new Set();
    const out = [];
    for (const tile of document.querySelectorAll('[data-participant-id]')) {
      const video = tile.querySelector('video');
      if (!video) continue;
      const id = tile.getAttribute('data-participant-id');
      if (seen.has(id)) continue;
      seen.add(id);
      const labels = tileLabels(tileScope(tile));
      out.push({
        id,
        tile,
        video,
        stream: liveRemoteStream(video),
        presentation: isPresentationLabelled(labels),
        labels
      });
    }
    return out;
  }

  // Someone else's presentation, carrying a live remote track: the same test
  // the old stream hand-off used, now returning the tile itself because the
  // window is Meet's to open and all we need is its control.
  function presentationTile() {
    return inspectTiles().find((t) => t.presentation && t.stream) || null;
  }

  const OPEN_IN_WINDOW_RE = /open in new window/i;

  // Clicked once per presentation. Re-clicking would fight the user: if they
  // close Meet's window deliberately, it must stay closed until the next share.
  let openedForTile = null;
  let lastControlMissing = false;

  function findOpenControl(tile) {
    const scopes = [tile ? tileScope(tile.tile) : null, document].filter(Boolean);
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('[role="button"], button')) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (label && OPEN_IN_WINDOW_RE.test(label)) return el;
      }
    }
    return null;
  }

  function openInOwnWindow(tile) {
    const control = findOpenControl(tile);
    if (!control) {
      // Meet may only put this control in the DOM while the tile is hovered.
      // Recorded rather than retried blindly, so the debug dump says so.
      lastControlMissing = true;
      return false;
    }
    lastControlMissing = false;
    control.click();
    log('asked Meet to open the presentation in its own window');
    return true;
  }

  // Detection runs unconditionally and `autoOpen` gates only the click: main
  // relies on the return value to notice a share ending, which it must do even
  // when auto pop-out is off and the window was opened by hand.
  function presentationTick(autoOpen) {
    const tile = presentationTile();
    if (!tile) {
      openedForTile = null;
      return false;
    }
    if (autoOpen && openedForTile !== tile.id && openInOwnWindow(tile)) openedForTile = tile.id;
    return true;
  }

  function presentationDebug() {
    const tile = presentationTile();
    return {
      detected: !!tile,
      tileId: tile ? tile.id : null,
      alreadyOpened: openedForTile,
      controlFound: !!findOpenControl(tile),
      controlMissingLastTry: lastControlMissing,
      tiles: inspectTiles().map((t) => ({
        id: t.id,
        presentation: t.presentation,
        remoteLive: !!t.stream,
        size: `${t.video.videoWidth}x${t.video.videoHeight}`,
        labels: t.labels.filter((l) => /present|pin|open in/i.test(l))
      }))
    };
  }

  window.__meetloafPresentationDebug = presentationDebug;
  window.__meetloafPresentationTick = presentationTick;

  // Manual trigger for the View menu. Ignores the once-per-presentation guard,
  // because asking for it explicitly means asking for it again.
  window.__meetloafPopout = {
    open: () => {
      const tile = presentationTile();
      if (!openInOwnWindow(tile)) return false;
      if (tile) openedForTile = tile.id;
      return true;
    }
  };

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      try { inject(); } catch (err) { log('inject error', err); }
      try { maintainPopover(); } catch (err) { log('present-tab error', err); }
      try { reportCallPhase(); } catch (err) { log('call-phase error', err); }
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  schedule();
  log('content script ready, watching for settings tablist, call phase + presentations');
})();
