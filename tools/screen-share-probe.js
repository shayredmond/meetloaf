// Screen-share probe — paste into MeetLoaf's DevTools console while in a call.
// Not shipped. Collects what Meet's DOM and WebRTC state look like before,
// during and after a presentation so detection can key off a real marker
// instead of video-shape heuristics.
//
//   __probe.mark('label')     snapshot now (call at each state)
//   copy(__probe.dump())      copy everything as JSON to the clipboard
(function () {
  if (window.__probe) { console.log('[probe] already installed'); return; }
  const t0 = performance.now();
  const ts = () => Math.round(performance.now() - t0);
  const KEYWORD_RE = /present|screen|shar|stage|spotlight|pin|tile|layout/i;
  const timeline = [];
  const marks = [];
  const pcs = new Set();
  const sdps = [];
  const MAX_TIMELINE = 5000;

  const push = (e) => { if (timeline.length < MAX_TIMELINE) timeline.push({ t: ts(), ...e }); };
  const short = (s, n = 100) => (s == null ? s : String(s).replace(/\s+/g, ' ').trim().slice(0, n));

  function attrs(el) {
    const out = {};
    for (const a of el.attributes || []) {
      if (a.name === 'class' || a.name === 'style') continue;
      if (a.name.startsWith('data-') || a.name.startsWith('aria-') ||
          ['role', 'jsname', 'jscontroller', 'jsmodel', 'jsaction', 'id', 'title'].includes(a.name)) {
        out[a.name] = short(a.value, 120);
      }
    }
    return out;
  }

  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
    return short(s, 80);
  }

  function visible(el) {
    try { return el.checkVisibility ? el.checkVisibility() : !!el.offsetParent; } catch { return false; }
  }

  function rect(el) {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }

  function ancestry(el, depth = 14) {
    const chain = [];
    for (let n = el.parentElement, i = 0; n && i < depth; n = n.parentElement, i++) {
      const a = attrs(n);
      if (Object.keys(a).length || ownText(n)) chain.push({ tag: n.tagName.toLowerCase(), rect: rect(n), text: ownText(n) || undefined, ...a });
    }
    return chain;
  }

  function describeVideo(v, i) {
    const s = v.srcObject;
    let tracks = [];
    try {
      tracks = s ? s.getTracks().map((t) => ({
        kind: t.kind, id: t.id, label: short(t.label, 60), contentHint: t.contentHint,
        readyState: t.readyState, muted: t.muted, settings: t.getSettings && t.getSettings()
      })) : [];
    } catch {}
    let cs = {};
    try { const c = getComputedStyle(v); cs = { objectFit: c.objectFit, transform: c.transform }; } catch {}
    return {
      i, streamId: s && s.id, tracks, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      rect: rect(v), visible: visible(v), paused: v.paused, ...cs, self: attrs(v), ancestry: ancestry(v)
    };
  }

  function keywordElements() {
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      if (hits.length >= 300) break;
      const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
      const text = ownText(el);
      const dataHit = Array.from(el.attributes).some((a) => a.name.startsWith('data-') && KEYWORD_RE.test(a.name));
      if (!(KEYWORD_RE.test(label) || KEYWORD_RE.test(text) || dataHit)) continue;
      hits.push({ tag: el.tagName.toLowerCase(), visible: visible(el), rect: rect(el), text: text || undefined, ...attrs(el) });
    }
    return hits;
  }

  function census() {
    const dataAttrs = {}, controllers = {}, jsnames = {};
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) if (a.name.startsWith('data-')) dataAttrs[a.name] = (dataAttrs[a.name] || 0) + 1;
      const c = el.getAttribute('jscontroller'); if (c) controllers[c] = (controllers[c] || 0) + 1;
      const j = el.getAttribute('jsname'); if (j) jsnames[j] = (jsnames[j] || 0) + 1;
    }
    return { dataAttrs, controllers, jsnames };
  }

  async function rtcSummary() {
    const out = [];
    for (const pc of pcs) {
      const entry = { connectionState: pc.connectionState, transceivers: [], inbound: [] };
      try {
        entry.transceivers = pc.getTransceivers().map((tr) => ({
          mid: tr.mid, direction: tr.direction, currentDirection: tr.currentDirection,
          recvTrack: tr.receiver.track && { kind: tr.receiver.track.kind, id: tr.receiver.track.id, muted: tr.receiver.track.muted },
          sendTrack: tr.sender.track && { kind: tr.sender.track.kind, id: tr.sender.track.id, contentHint: tr.sender.track.contentHint }
        }));
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            entry.inbound.push({
              mid: r.mid, trackIdentifier: r.trackIdentifier, ssrc: r.ssrc, frameWidth: r.frameWidth,
              frameHeight: r.frameHeight, framesPerSecond: r.framesPerSecond, contentType: r.contentType,
              bytesReceived: r.bytesReceived, codecId: r.codecId
            });
          }
        });
      } catch (e) { entry.error = String(e); }
      out.push(entry);
    }
    return out;
  }

  // Existing peer connections were created before we got here; patching the
  // prototype catches them the next time Meet calls into them.
  const P = window.RTCPeerConnection && RTCPeerConnection.prototype;
  if (P) {
    const stripSdp = (sdp) => (sdp || '').split(/\r?\n/).filter((l) =>
      /^(m=|a=mid|a=msid|a=content|a=label|a=extmap|a=sendrecv|a=recvonly|a=sendonly|a=inactive|a=x-google|a=imageattr|a=simulcast|a=rid)/.test(l)).join('\n');
    const adopt = (pc) => {
      if (pcs.has(pc)) return;
      pcs.add(pc);
      push({ ev: 'pc-adopted', n: pcs.size });
      pc.addEventListener('track', (e) => push({
        ev: 'rtc-track', kind: e.track.kind, trackId: e.track.id, mid: e.transceiver && e.transceiver.mid,
        streams: e.streams.map((s) => s.id)
      }));
    };
    for (const name of ['setRemoteDescription', 'setLocalDescription', 'getStats', 'addTransceiver', 'createOffer', 'createAnswer', 'addIceCandidate']) {
      const orig = P[name];
      if (typeof orig !== 'function') continue;
      P[name] = function (...args) {
        adopt(this);
        if ((name === 'setRemoteDescription' || name === 'setLocalDescription') && args[0] && args[0].sdp) {
          sdps.push({ t: ts(), which: name, type: args[0].type, sdp: stripSdp(args[0].sdp) });
          push({ ev: 'sdp', which: name, type: args[0].type });
        }
        return orig.apply(this, args);
      };
    }
  }

  // Timeline of anything that looks relevant, so the transition itself is
  // captured even if the marks are taken a few seconds late.
  const describeNode = (el) => ({ tag: el.tagName.toLowerCase(), visible: visible(el), text: ownText(el) || undefined, ...attrs(el) });
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const videos = n.tagName === 'VIDEO' ? [n] : Array.from(n.querySelectorAll('video'));
          for (const v of videos) push({ ev: 'video-added', ancestry: ancestry(v, 8) });
          const label = n.getAttribute('aria-label') || '';
          if (KEYWORD_RE.test(label) || KEYWORD_RE.test(short(n.textContent, 120) || '')) push({ ev: 'node-added', ...describeNode(n) });
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          const count = n.tagName === 'VIDEO' ? 1 : n.querySelectorAll('video').length;
          if (count) push({ ev: 'video-removed', count, ...attrs(n) });
        }
      } else if (m.type === 'attributes') {
        const name = m.attributeName;
        if (!(name.startsWith('data-') || name.startsWith('aria-') || name === 'jscontroller')) continue;
        const val = m.target.getAttribute(name);
        if (!KEYWORD_RE.test(name) && !KEYWORD_RE.test(val || '') && m.target.tagName !== 'VIDEO') continue;
        push({ ev: 'attr', name, old: short(m.oldValue), val: short(val), on: describeNode(m.target) });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true });

  window.__probe = {
    async mark(label) {
      const snap = {
        label, t: ts(), url: location.pathname, viewport: [innerWidth, innerHeight],
        videos: Array.from(document.querySelectorAll('video')).map(describeVideo),
        keywords: keywordElements(), census: census(), rtc: await rtcSummary()
      };
      marks.push(snap);
      push({ ev: 'mark', label });
      console.log(`[probe] mark "${label}": ${snap.videos.length} videos, ${snap.keywords.length} keyword elements, ${pcs.size} peer connections`);
      return `ok (${marks.length} marks)`;
    },
    dump() {
      return JSON.stringify({ ua: navigator.userAgent, marks, timeline, sdps }, null, 1);
    },
    _state: { marks, timeline, sdps, pcs }
  };
  console.log('[probe] installed — call __probe.mark("before") next');
})();
