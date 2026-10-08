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

  // ─── Presentation pop-out ───────────────────────────────────────────────
  //
  // When a *remote* participant starts presenting, split their shared content
  // out into its own window, so the main window can go back to being the
  // faces. The stream is never re-captured or mirrored: a window opened with
  // window.open() from this page is same-origin and lives in the same
  // renderer, so a <video> inside it can be handed Meet's own MediaStream by
  // reference. Electron has no usable Picture-in-Picture path on macOS, so
  // this is the only way to get a detached live video at all.
  //
  // Detection keys on facts Meet states, not on what a video looks like. An
  // earlier version guessed from object-fit, resolution and tile size; it
  // popped out cameras on join and missed real shares. What a live capture
  // (Oct 2026) showed instead:
  //
  //   - Every tile carries data-participant-id="spaces/…/devices/N", and a
  //     presentation is its own device, separate from the presenter's camera.
  //   - Only the presentation tile is labelled as one: its name reads
  //     "X (Presentation)" and its pin button "Pin X's presentation to …".
  //     Camera tiles say "Pin X to …".
  //   - A remote track's label is its id (a UUID). Local tracks carry the
  //     device name (camera) or are blank with a displaySurface (your share),
  //     which excludes your own presentation exactly.
  //   - Meet reuses <video> elements across tiles — when the presentation ended
  //     the same element was handed the presenter's camera — so this re-decides
  //     from the tile on every tick and never holds on to an element.
  //
  // Like the call-phase watcher this reads English labels. A Meet wording
  // change costs the feature; it can't pop out the wrong person, because a
  // camera tile never carries the presentation label.
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

  function presentationStream() {
    const hit = inspectTiles().find((t) => t.presentation && t.stream);
    return hit ? hit.stream : null;
  }

  const POPOUT_NAME = 'meetloaf-presentation';
  // How long the presentation has to stay gone before the window closes. Meet
  // tears down and rebuilds tiles during layout changes, so brief gaps are
  // normal and must not make the window flap.
  const POPOUT_CLOSE_GRACE_MS = 5000;

  let popout = null;
  let popoutVideo = null;
  // Set when the user closes the window by hand. Cleared once the presentation
  // ends, so dismissing it applies to this presentation only.
  let popoutDismissed = false;
  // A manual pop-out (View menu) shows whatever the user asked for, so the
  // tick mustn't close it just because detection doesn't agree.
  let popoutManual = false;
  let popoutRebuilds = 0;
  let lastSeenAt = 0;

  // The window is opened empty and furnished afterwards, every tick, rather
  // than written once at open time.
  //
  // document.write() into a just-opened window races the about:blank
  // navigation: the write lands, then the real document commits and replaces
  // it. That left a window stuck at readyState "loading" with no <video> in it
  // — open, black, and permanently empty, because nothing ever looked again.
  //
  // Building the DOM is not enough on its own either; the same replacement
  // would discard it. What makes this reliable is that it re-checks on every
  // tick and rebuilds whenever the element has gone, so losing the race costs
  // one tick instead of the whole feature.
  function ensurePopoutVideo() {
    if (!popout || popout.closed) return null;
    let doc;
    try { doc = popout.document; } catch { return null; }
    // Mid-navigation: body isn't there yet. The next tick will find it.
    if (!doc || !doc.body) return null;

    let v = doc.getElementById('meetloaf-presentation');
    if (!v) {
      // Counted so a recurrence is visible in __meetloafPresentationDebug()
      // rather than needing another live capture to find. One rebuild is the
      // race being lost and repaired; a climbing count means something is
      // clearing the document repeatedly.
      popoutRebuilds += 1;
      if (popoutRebuilds > 1) log('pop-out video rebuilt', popoutRebuilds, 'times');
      doc.title = 'Presentation';
      if (doc.documentElement) doc.documentElement.style.cssText = 'height:100%';
      doc.body.style.cssText = 'margin:0;height:100%;background:#000;overflow:hidden';
      v = doc.createElement('video');
      v.id = 'meetloaf-presentation';
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#000';
      doc.body.appendChild(v);
    }
    popoutVideo = v;
    return v;
  }

  function openPopout() {
    if (popout && !popout.closed) return true;
    popout = window.open('', POPOUT_NAME, 'width=1024,height=640');
    if (!popout) {
      log('pop-out window was blocked');
      return false;
    }
    popoutVideo = null;
    // May be too early — ensurePopoutVideo retries on each tick.
    ensurePopoutVideo();
    return true;
  }

  function closePopout(reason) {
    if (popout && !popout.closed) {
      log('closing pop-out:', reason);
      popout.close();
    }
    popout = null;
    popoutVideo = null;
    popoutManual = false;
  }

  // Assigning the same MediaStream to a second <video> is fine, and it works
  // across windows because about:blank inherits the opener's origin. Re-run on
  // every tick: Meet swaps elements and streams freely, and this no-ops when
  // nothing changed.
  function attach(stream) {
    const v = ensurePopoutVideo();
    if (!v || !stream || v.srcObject === stream) return;
    v.srcObject = stream;
    const played = v.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }

  function presentationTick(enabled) {
    if (popoutManual) {
      if (popout && popout.closed) closePopout('closed by user');
      return !!popout;
    }
    const stream = enabled ? presentationStream() : null;
    const now = Date.now();

    if (stream) {
      lastSeenAt = now;
      if (popoutDismissed) return true;
      if (popout && popout.closed) {
        // Closed from its own title bar while the presentation is still
        // running: that's "not this one, thanks", not an invitation to
        // reopen on the next tick.
        popoutDismissed = true;
        popout = null;
        popoutVideo = null;
        return true;
      }
      const wasOpen = !!popout;
      if (openPopout()) {
        if (!wasOpen) log('presentation popped out:', presentationDebug().tiles.filter((t) => t.presentation));
        attach(stream);
      }
      return true;
    }

    popoutDismissed = false;
    if (popout && now - lastSeenAt > POPOUT_CLOSE_GRACE_MS) closePopout('presentation ended');
    return false;
  }

  // Run __meetloafPresentationDebug() from DevTools during a call to see what
  // the detector sees for every tile.
  function presentationDebug() {
    return {
      detected: !!presentationStream(),
      open: !!(popout && !popout.closed),
      manual: popoutManual,
      dismissed: popoutDismissed,
      popup: (() => {
        if (!popout || popout.closed) return null;
        let doc;
        try { doc = popout.document; } catch { return { unreachable: true }; }
        const v = doc && doc.getElementById('meetloaf-presentation');
        return {
          docState: doc && doc.readyState,
          rebuilds: popoutRebuilds,
          videoFound: !!v,
          hasStream: !!(v && v.srcObject),
          size: v ? `${v.videoWidth}x${v.videoHeight}` : null,
          paused: v ? v.paused : null
        };
      })(),
      tiles: inspectTiles().map((t) => ({
        id: t.id,
        presentation: t.presentation,
        remoteLive: !!t.stream,
        size: `${t.video.videoWidth}x${t.video.videoHeight}`,
        labels: t.labels.filter((l) => /present|pin|\(/i.test(l))
      }))
    };
  }

  window.__meetloafPresentationDebug = presentationDebug;

  // Called by the main process on its unthrottled poll, and locally below.
  window.__meetloafPresentationTick = presentationTick;

  // Manual override for the View menu: the detected presentation if there is
  // one, otherwise the largest remote video. It's the escape hatch for when
  // Meet's labels moved and auto-detection didn't fire.
  window.__meetloafPopout = {
    isOpen: () => !!(popout && !popout.closed),
    open: () => {
      let stream = presentationStream();
      if (!stream) {
        const area = (v) => v.videoWidth * v.videoHeight;
        const best = inspectTiles().filter((t) => t.stream)
          .sort((a, b) => area(b.video) - area(a.video))[0];
        stream = best ? best.stream : null;
      }
      if (!stream) {
        log('pop-out requested but no remote video is playing');
        return false;
      }
      popoutDismissed = false;
      if (!openPopout()) return false;
      popoutManual = true;
      attach(stream);
      return true;
    },
    close: () => {
      popoutDismissed = true;
      closePopout('manual');
    },
    // Main destroyed the window itself (the call ended, or the renderer is
    // being replaced). Drop our handle without recording it as a dismissal —
    // that flag is reserved for the user closing the window by hand.
    reset: () => {
      popout = null;
      popoutVideo = null;
      popoutDismissed = false;
      popoutManual = false;
    }
  };

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      try { inject(); } catch (err) { log('inject error', err); }
      try { reportCallPhase(); } catch (err) { log('call-phase error', err); }
      // Only ever *maintains* an already-open window here: opening is gated on
      // the user's setting, which only the main process knows, so main's poll
      // is what opens one. This keeps the attached stream fresh and closes the
      // window promptly while MeetLoaf is visible.
      try {
        if (window.__meetloafPopout.isOpen()) presentationTick(true);
      } catch (err) { log('pop-out error', err); }
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  schedule();
  log('content script ready, watching for settings tablist, call phase + presentations');
})();
