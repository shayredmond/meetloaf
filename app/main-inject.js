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

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      try { inject(); } catch (err) { log('inject error', err); }
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  schedule();
  log('content script ready, watching for settings tablist');
})();
