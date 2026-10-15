// Injected into Meet pages on Linux/Wayland only (see main.js, dom-ready).
//
// On Wayland, Electron's getDisplayMedia() resolves the moment our
// display-media handler calls back — but xdg-desktop-portal's "Share your
// screen" dialog only opens after that, when capture actually starts. Meet
// takes the resolved stream as "presenting" and everyone else sees a blank
// tile until the user has picked something in the portal dialog, or for the
// whole call if they cancel it.
//
// So hold the stream back until it delivers its first frame, which is the
// first moment we know the user chose a source. A portal cancel ends the
// track without a frame; that becomes the same NotAllowedError Meet gets when
// someone dismisses Chrome's own picker, so Meet resets its UI as usual.
(function () {
  if (window.__meetloafWaylandShare) return;
  window.__meetloafWaylandShare = true;

  const original = MediaDevices.prototype.getDisplayMedia;
  if (typeof original !== 'function' || typeof MediaStreamTrackProcessor !== 'function') return;

  // Reads from a clone so the frame isn't taken from Meet's own track.
  async function waitForFirstFrame(track) {
    const probe = track.clone();
    const reader = new MediaStreamTrackProcessor({ track: probe }).readable.getReader();
    try {
      const { value, done } = await reader.read();
      if (value) value.close();
      return !done && track.readyState === 'live';
    } catch {
      return false;
    } finally {
      reader.cancel().catch(() => {});
      probe.stop();
    }
  }

  MediaDevices.prototype.getDisplayMedia = async function (...args) {
    const stream = await original.apply(this, args);
    const [track] = stream.getVideoTracks();
    if (track && !(await waitForFirstFrame(track))) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException('Permission denied', 'NotAllowedError');
    }
    return stream;
  };
})();
