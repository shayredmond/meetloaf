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

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      try { inject(); } catch (err) { log('inject error', err); }
      try { reportCallPhase(); } catch (err) { log('call-phase error', err); }
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  schedule();
  log('content script ready, watching for settings tablist + call phase');
})();
