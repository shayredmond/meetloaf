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
  // reference. That is the whole trick, and it is what makes this possible at
  // all — Electron has no usable Picture-in-Picture path on macOS.
  //
  // presentationTick() is deliberately driven from outside, by two callers:
  // the MutationObserver below (immediate, but throttled to a crawl whenever
  // MeetLoaf is hidden) and the main process's own unthrottled poll. It is
  // idempotent, and its close hysteresis is measured in wall-clock time rather
  // than tick counts so that both callers produce identical behaviour.

  // Our own camera and our own screen share must never be mistaken for someone
  // else's presentation. Recording the track ids where they're created is
  // exact; any DOM-side "is this the self-view?" test would only be a guess.
  const localTrackIds = new Set();

  function rememberLocalTracks(stream) {
    try {
      for (const track of stream.getVideoTracks()) localTrackIds.add(track.id);
    } catch { /* not a MediaStream — hand it back untouched */ }
    return stream;
  }

  function patchCapture(name) {
    const md = navigator.mediaDevices;
    if (!md || typeof md[name] !== 'function') return;
    const original = md[name].bind(md);
    md[name] = function (...args) {
      return original(...args).then(rememberLocalTracks);
    };
  }
  patchCapture('getUserMedia');
  patchCapture('getDisplayMedia');

  // Meet's own wording decides *whether* a presentation is running; the
  // scoring below decides *which* element it is. Splitting the question this
  // way means a missed label can only cost us the feature, never pop out a
  // random participant's camera.
  // "presentation" as a bare noun is all over Meet's chrome — layout options,
  // the Present now flyout, tooltips, hidden pre-rendered dialogs — so matching
  // it meant the announcement was effectively always true. Only the phrasing
  // Meet uses to announce an actual presenter counts.
  const PRESENTING_RE = /\bis presenting\b|\b\S+['\u2019]s presentation\b/i;
  const SELF_PRESENTING_RE = /\byou are presenting\b|\byour presentation\b/i;

  function isVisible(el) {
    try {
      if (typeof el.checkVisibility === 'function') return el.checkVisibility();
      return !!el.offsetParent;
    } catch {
      return false;
    }
  }

  // Returns the matching strings rather than a boolean so the debug dump can
  // show exactly what tripped it.
  function announcementMatches() {
    const hits = [];
    for (const el of document.querySelectorAll('[aria-label], [role="heading"]')) {
      const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
      // Long strings are wrapper subtrees whose concatenated text matches
      // almost anything — the same trap controlLabels() guards against.
      if (!text || text.length > 80) continue;
      if (SELF_PRESENTING_RE.test(text)) continue;
      if (!PRESENTING_RE.test(text)) continue;
      // Meet pre-renders plenty of UI it isn't showing yet.
      if (!isVisible(el)) continue;
      hits.push(text);
    }
    return hits;
  }

  function remotePresentationAnnounced() {
    return announcementMatches().length > 0;
  }

  function hasLocalTrack(v) {
    const stream = v.srcObject;
    if (!stream || typeof stream.getVideoTracks !== 'function') return false;
    return stream.getVideoTracks().some((t) => localTrackIds.has(t.id));
  }

  // Meet mirrors your own camera, and only your own camera. Unlike the track-id
  // check this doesn't depend on our getUserMedia patch having been installed
  // before Meet took its reference to it — a race we can't be sure of winning,
  // since we're injected at dom-ready and Meet's bundle may have run already.
  function isMirrored(v) {
    try {
      const t = getComputedStyle(v).transform;
      if (!t || t === 'none') return false;
      return new DOMMatrixReadOnly(t).a < 0;
    } catch {
      return false;
    }
  }

  function isLocalVideo(v) {
    return hasLocalTrack(v) || isMirrored(v);
  }

  function candidateVideos() {
    return Array.from(document.querySelectorAll('video')).filter(
      (v) => v.srcObject && v.videoWidth > 0 && v.videoHeight > 0 && !isLocalVideo(v)
    );
  }

  // No single property says "this is a screen share", but several independent
  // ones line up on it. object-fit carries the most weight because it isn't
  // cosmetic: shared content has to be letterboxed rather than cropped, so
  // Meet is forced to render it with `contain` where camera tiles use `cover`.
  function scorePresentation(v) {
    let score = 0;
    try {
      if (getComputedStyle(v).objectFit === 'contain') score += 3;
    } catch { /* element detached mid-scan */ }
    const area = v.videoWidth * v.videoHeight;
    if (area >= 1280 * 720) score += 2;
    else if (area >= 1024 * 576) score += 1;
    // Camera tiles are 16:9 essentially without exception. A shared display
    // frequently isn't — 16:10 laptops, portrait monitors, single windows.
    if (Math.abs(v.videoWidth / v.videoHeight - 16 / 9) > 0.08) score += 1;
    return score;
  }

  function renderedArea(v) {
    const r = v.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function bestCandidate() {
    const all = candidateVideos();
    let video = null;
    let score = -1;
    for (const v of all) {
      const s = scorePresentation(v);
      // Rendered size breaks ties: between two equally screen-shaped videos,
      // the one Meet gave the stage to is the one being presented.
      if (s > score || (s === score && video && renderedArea(v) > renderedArea(video))) {
        video = v;
        score = s;
      }
    }
    return { video, score, all };
  }

  // The gate that stops a merely large camera tile from being mistaken for a
  // share. A presentation is one of two things, and both are consequences of
  // how Meet has to lay it out rather than cosmetic choices: either it is
  // visibly uncropped (shared content must be letterboxed; camera tiles are
  // cropped to fill their tile), or it is visibly the main stage (Meet demotes
  // the cameras to a strip while someone presents). Requiring one of the two
  // means a change to either behaviour costs us detection, never a false pop-out.
  function qualifies(video, all) {
    try {
      if (getComputedStyle(video).objectFit === 'contain') return true;
    } catch { /* element detached mid-scan */ }
    const mine = renderedArea(video);
    if (mine <= 0) return false;
    const rivals = all.filter((v) => v !== video).map(renderedArea).filter((a) => a > 0);
    // "Twice the size of every other tile" is vacuously true when there is no
    // other tile — which is exactly the state on joining a call, and is what
    // popped a window open with nobody sharing. Dominance needs something to
    // dominate; with a lone video the object-fit test above is the only way in.
    if (!rivals.length) return false;
    return mine >= Math.max(...rivals) * 2;
  }

  // qualifies() is the real discriminator, so an announced presentation only
  // needs the score to show a flicker of evidence. Unannounced, we act solely
  // on a video that looks unmistakably like shared content — that path exists
  // so the feature survives Meet changing its wording. The announced floor is
  // above a plain 720p camera tile (which scores 2) on purpose.
  const SCORE_ANNOUNCED = 3;
  const SCORE_UNANNOUNCED = 4;

  function presentationVideo() {
    const { video, score, all } = bestCandidate();
    if (!video || !qualifies(video, all)) return null;
    const floor = remotePresentationAnnounced() ? SCORE_ANNOUNCED : SCORE_UNANNOUNCED;
    return score >= floor ? video : null;
  }

  const POPOUT_NAME = 'meetloaf-presentation';
  // How long the presentation has to stay gone before the window closes. Meet
  // tears down and rebuilds video elements during layout changes, so brief
  // gaps are normal and must not make the window flap.
  const POPOUT_CLOSE_GRACE_MS = 5000;

  const POPOUT_DOC = `<!doctype html>
<html><head><meta charset="utf-8"><title>Presentation</title>
<meta name="color-scheme" content="dark">
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
</style></head>
<body><video id="meetloaf-presentation" autoplay playsinline muted></video></body></html>`;

  let popout = null;
  let popoutVideo = null;
  // Set when the user closes the window by hand. Cleared once the presentation
  // ends, so dismissing it applies to this presentation only.
  let popoutDismissed = false;
  let lastSeenAt = 0;

  function openPopout() {
    if (popout && !popout.closed) return true;
    popout = window.open('', POPOUT_NAME, 'width=1024,height=640');
    if (!popout) {
      log('pop-out window was blocked');
      return false;
    }
    popout.document.open();
    popout.document.write(POPOUT_DOC);
    popout.document.close();
    popoutVideo = popout.document.getElementById('meetloaf-presentation');
    log('presentation popped out');
    return true;
  }

  function closePopout(reason) {
    if (popout && !popout.closed) {
      log('closing pop-out:', reason);
      popout.close();
    }
    popout = null;
    popoutVideo = null;
  }

  // Assigning the same MediaStream to a second <video> is fine, and it works
  // across windows because about:blank inherits the opener's origin. Re-run on
  // every tick: Meet swaps the underlying element and stream freely, and this
  // no-ops when nothing changed.
  function attach(stream) {
    if (!popoutVideo || !stream || popoutVideo.srcObject === stream) return;
    popoutVideo.srcObject = stream;
    const played = popoutVideo.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }

  function presentationTick(enabled) {
    const video = enabled ? presentationVideo() : null;
    const now = Date.now();

    if (video) {
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
      if (openPopout()) {
        // Leave the reasoning in the console: a wrong pop-out should be
        // diagnosable after the fact, without having to reproduce it live.
        log('popped out on:', describeVideo(video), 'announced:', announcementMatches());
        attach(video.srcObject);
      }
      return true;
    }

    popoutDismissed = false;
    if (popout && now - lastSeenAt > POPOUT_CLOSE_GRACE_MS) closePopout('presentation ended');
    return false;
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────
  //
  // Every detection signal, for every video on the page, in one object. Run
  // __meetloafPresentationDebug() from DevTools during a call — once with
  // nobody presenting and once while someone is — and the difference between
  // the two dumps is the answer to "what should the detector key on?".

  // Meet's class names are obfuscated and rotate, but its data-* attributes and
  // aria-labels don't. If there's a stable "this tile is a presentation" marker
  // anywhere in the markup, this is what will surface it.
  function ancestryOf(v) {
    const out = [];
    let el = v;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      const attrs = {};
      for (const a of Array.from(el.attributes || [])) {
        if (a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'role') {
          attrs[a.name] = a.value.slice(0, 60);
        }
      }
      out.push({ tag: el.tagName.toLowerCase(), attrs });
    }
    return out;
  }

  function describeVideo(v) {
    const rect = v.getBoundingClientRect();
    let objectFit = '?';
    try { objectFit = getComputedStyle(v).objectFit; } catch { /* detached */ }
    const stream = v.srcObject;
    const tracks = stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    return {
      intrinsic: `${v.videoWidth}x${v.videoHeight}`,
      rendered: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      objectFit,
      mirrored: isMirrored(v),
      knownLocalTrack: hasLocalTrack(v),
      paused: v.paused,
      score: scorePresentation(v),
      tracks: tracks.map((t) => ({
        label: t.label,
        readyState: t.readyState,
        settings: (() => { try { return t.getSettings(); } catch { return null; } })()
      })),
      ancestry: ancestryOf(v)
    };
  }

  function presentationDebug() {
    const all = Array.from(document.querySelectorAll('video'));
    const candidates = candidateVideos();
    const { video, score } = bestCandidate();
    return {
      announced: remotePresentationAnnounced(),
      announcementMatches: announcementMatches(),
      detected: !!presentationVideo(),
      bestScore: score,
      bestQualifies: video ? qualifies(video, candidates) : false,
      floor: remotePresentationAnnounced() ? SCORE_ANNOUNCED : SCORE_UNANNOUNCED,
      localTrackIdsKnown: localTrackIds.size,
      candidates: candidates.map(describeVideo),
      excludedAsLocalOrEmpty: all.filter((v) => !candidates.includes(v)).map(describeVideo)
    };
  }

  window.__meetloafPresentationDebug = presentationDebug;

  // Called by the main process on its unthrottled poll, and locally below.
  window.__meetloafPresentationTick = presentationTick;

  // Manual override for the View menu. `open` deliberately ignores the score
  // threshold and takes the best candidate outright — it's the escape hatch
  // for exactly the case where auto-detection didn't fire.
  window.__meetloafPopout = {
    isOpen: () => !!(popout && !popout.closed),
    open: () => {
      const { video } = bestCandidate();
      if (!video) {
        log('pop-out requested but no remote video is playing');
        return false;
      }
      popoutDismissed = false;
      lastSeenAt = Date.now();
      if (!openPopout()) return false;
      attach(video.srcObject);
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
  log('content script ready, watching for settings tablist + call phase');
})();
