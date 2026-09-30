const steps = Array.from(document.querySelectorAll('.step'));
const dots = Array.from(document.querySelectorAll('.dot'));
const backBtn = document.getElementById('backBtn');
const nextBtn = document.getElementById('nextBtn');
const closeBtn = document.getElementById('closeBtn');

// The Settings shortcut is ⌘, on macOS and Ctrl+, everywhere else.
if (window.welcome.platform !== 'darwin') {
  document.querySelectorAll('[data-settings-key]').forEach((k) => { k.textContent = 'Ctrl + ,'; });
}

let current = 0;
const last = steps.length - 1;

function render() {
  steps.forEach((s, i) => { s.hidden = i !== current; });
  dots.forEach((d, i) => d.classList.toggle('active', i === current));
  backBtn.hidden = current === 0;
  nextBtn.textContent = current === last ? 'Get started' : 'Next';
}

function go(delta) {
  current = Math.max(0, Math.min(last, current + delta));
  render();
}

nextBtn.addEventListener('click', () => {
  if (current === last) {
    window.welcome.dismiss();
  } else {
    go(1);
  }
});

backBtn.addEventListener('click', () => go(-1));
closeBtn.addEventListener('click', () => window.welcome.dismiss());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.welcome.dismiss();
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'Enter') nextBtn.click();
});

render();
