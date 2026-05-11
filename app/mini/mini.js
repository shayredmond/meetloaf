const card = document.getElementById('card');
const statusEl = document.getElementById('status');
const frameEl = document.getElementById('frame');
const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');

// Click on the card body restores the main window. The control buttons
// stopPropagation so clicking them only fires the toggle, not restore.
card.addEventListener('click', () => window.mini.restore());
card.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    window.mini.restore();
  }
});

micBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.mini.toggleMute();
});

camBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.mini.toggleCamera();
});

window.mini.onStatus((payload) => {
  if (!payload) return;
  statusEl.textContent = payload.text || '';
  statusEl.classList.toggle('in-meeting', !!payload.inMeeting);

  // Mic state: undefined = unknown (no border), true = muted (red), false = active (green)
  if (payload.muted === true) {
    card.classList.add('mic-muted');
    card.classList.remove('mic-active');
    micBtn.classList.add('is-off');
  } else if (payload.muted === false) {
    card.classList.add('mic-active');
    card.classList.remove('mic-muted');
    micBtn.classList.remove('is-off');
  } else {
    card.classList.remove('mic-muted', 'mic-active');
    micBtn.classList.remove('is-off');
  }

  // Camera state — only used to flip the camera button's icon, no border tint
  if (payload.cameraOff === true) camBtn.classList.add('is-off');
  else camBtn.classList.remove('is-off');
});

window.mini.onFrame((dataUrl) => {
  if (!dataUrl) return;
  frameEl.src = dataUrl;
  card.classList.add('has-frame');
});

window.mini.onClear(() => {
  card.classList.remove('has-frame');
  frameEl.src = '';
});
