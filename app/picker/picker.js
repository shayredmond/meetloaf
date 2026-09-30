const grid = document.getElementById('grid');
const shareBtn = document.getElementById('share');
const cancelBtn = document.getElementById('cancel');
const audioRow = document.getElementById('audioRow');
const audioBox = document.getElementById('audio');
const tabs = [...document.querySelectorAll('.tab')];

let sources = [];
let kind = 'screen';
let selectedId = null;

function render() {
  grid.textContent = '';
  const list = sources.filter((s) => s.kind === kind);
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = kind === 'screen' ? 'No screens found.' : 'No windows found.';
    grid.appendChild(empty);
  }
  for (const s of list) {
    const card = document.createElement('button');
    card.className = 'card' + (s.id === selectedId ? ' selected' : '');
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(s.id === selectedId));

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = '';
      thumb.appendChild(img);
    }
    card.appendChild(thumb);

    const label = document.createElement('div');
    label.className = 'label';
    if (s.icon) {
      const icon = document.createElement('img');
      icon.className = 'icon';
      icon.src = s.icon;
      icon.alt = '';
      label.appendChild(icon);
    }
    const name = document.createElement('span');
    name.textContent = s.name;
    name.title = s.name;
    label.appendChild(name);
    card.appendChild(label);

    card.addEventListener('click', () => { selectedId = s.id; render(); });
    card.addEventListener('dblclick', () => window.picker.choose(s.id, audioBox.checked));
    grid.appendChild(card);
  }
  shareBtn.disabled = !sources.some((s) => s.id === selectedId && s.kind === kind);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    render();
  });
}

shareBtn.addEventListener('click', () => {
  if (selectedId) window.picker.choose(selectedId, audioBox.checked);
});
cancelBtn.addEventListener('click', () => window.picker.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.picker.cancel();
  if (e.key === 'Enter' && !shareBtn.disabled) shareBtn.click();
});

window.picker.onSources((payload) => {
  sources = payload.sources || [];
  audioRow.hidden = !payload.systemAudio;
  // Pre-select the only screen on single-monitor setups — the common case.
  const screens = sources.filter((s) => s.kind === 'screen');
  if (screens.length === 1) selectedId = screens[0].id;
  render();
});
