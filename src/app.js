// Main window: first-run setup, the Ghost picker (shell + shader, with a 3D preview) and settings.
import { loadCatalog, getSelection, saveSelection, iconUrl } from './shared.js';
import { ShellPreview } from './preview.js';

const { invoke } = window.__TAURI__.core;
const { listen, emitTo } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const toOverlay = (payload) => emitTo('overlay', 'ghost-cmd', payload);

const TIERS = [
  { tier: 6, name: 'Exotic', color: 'var(--exotic)' },
  { tier: 5, name: 'Legendary', color: 'var(--legendary)' },
  { tier: 4, name: 'Rare', color: 'var(--rare)' },
  { tier: 3, name: 'Uncommon', color: 'var(--uncommon)' },
  { tier: 2, name: 'Common', color: 'var(--common)' },
];
const tierColor = (t) => (TIERS.find((x) => x.tier === t) || TIERS[4]).color;

let catalog = null;
let lists = { shell: [], shader: [] };
const view = { kind: 'shell', search: '', sort: 'name', tiers: new Set() };
const pending = { shell: null, shader: null };   // what's being previewed
let applied = getSelection() || {};              // what's on the desktop
let preview = null;

// ---------------------------------------------------------------- tabs
function showTab(tab) {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('ghost').hidden = tab !== 'ghost';
  $('settings').hidden = tab !== 'settings';
  $('about').hidden = tab !== 'about';
  if (tab === 'settings') refreshSettings();
  if (tab === 'about') showVersion();
}
/** Link buttons (clan website, Discord) open in the user's browser — never in this window. */
function wireLinks(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-link]');
    if (!b) return;
    e.stopPropagation();
    invoke('open_external', { url: b.dataset.link }).catch(console.warn);
  });
}
wireLinks($('headlinks'));
wireLinks($('about'));

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
listen('open-tab', (e) => { if (catalog) showTab(e.payload); });

// ---------------------------------------------------------------- status (from the overlay)
const STATUS_TEXT = { loading: 'Loading Ghost…', ready: 'On your desktop', error: "Couldn't load that Ghost", off: 'Ghost is off', idle: '' };
listen('ghost-status', ({ payload: s }) => {
  const el = $('status');
  el.className = 'status ' + (s?.state || '');
  el.textContent = STATUS_TEXT[s?.state] ?? '';
  el.hidden = !el.textContent;
});
listen('ghost-mode', ({ payload }) => markMode(payload));

// ---------------------------------------------------------------- setup
async function runSetup() {
  $('setup').hidden = false; $('ghost').hidden = true; $('settings').hidden = true; $('about').hidden = true; $('tabs').hidden = true;
  $('setup-retry').hidden = true;
  const msg = $('setup-msg'), bar = $('setup-bar'), prog = bar.parentElement;
  msg.classList.remove('error'); msg.textContent = 'Contacting Bungie…';
  prog.classList.add('indeterminate');
  const unlisten = await listen('setup-progress', ({ payload: p }) => {
    const known = p.total > 0;
    prog.classList.toggle('indeterminate', !known);
    bar.style.width = known ? `${Math.min(100, (p.done / p.total) * 100)}%` : '';
    const mb = (n) => (n / 1048576).toFixed(1);
    msg.textContent = p.stage === 'download' && known ? `${p.message} — ${mb(p.done)} of ${mb(p.total)} MB`
      : p.stage === 'icons' && known ? `${p.message} — ${p.done} of ${p.total}`
      : p.message;
  });
  try {
    const r = await invoke('run_setup');
    unlisten();
    catalog = await loadCatalog();
    if (!catalog) throw new Error('the item list could not be read back');
    console.log('[deskghost] setup done', r);
    enterPicker();
  } catch (e) {
    unlisten();
    prog.classList.remove('indeterminate'); bar.style.width = '0';
    msg.classList.add('error');
    msg.textContent = `Setup didn't finish: ${e?.message || e}. Check your internet connection and try again.`;
    $('setup-retry').hidden = false;
  }
}
$('setup-retry').addEventListener('click', runSetup);

// ---------------------------------------------------------------- picker
function buildLists() {
  lists = { shell: [], shader: [] };
  for (const [hash, it] of Object.entries(catalog.items || {})) lists[it.kind]?.push({ hash: Number(hash), ...it });
  $('count-shell').textContent = lists.shell.length;
  $('count-shader').textContent = lists.shader.length;
  const chips = $('tiers');
  chips.innerHTML = '';
  for (const t of TIERS) {
    if (!lists.shell.some((x) => x.tier === t.tier) && !lists.shader.some((x) => x.tier === t.tier)) continue;
    const b = document.createElement('button');
    b.textContent = t.name; b.dataset.tier = t.tier;
    b.addEventListener('click', () => {
      view.tiers.has(t.tier) ? view.tiers.delete(t.tier) : view.tiers.add(t.tier);
      b.classList.toggle('on', view.tiers.has(t.tier));
      renderGrid();
    });
    chips.appendChild(b);
  }
}

function renderGrid() {
  const grid = $('grid');
  const q = view.search.trim().toLowerCase();
  let items = lists[view.kind].filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!view.tiers.size || view.tiers.has(x.tier)));
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (view.sort === 'new') items.sort((a, b) => (b.index || 0) - (a.index || 0));
  else if (view.sort === 'tier') items.sort((a, b) => (b.tier || 0) - (a.tier || 0) || byName(a, b));
  else items.sort(byName);

  const frag = document.createDocumentFragment();
  if (view.kind === 'shader' && !q && !view.tiers.size) frag.appendChild(tile(null));   // "no shader"
  for (const it of items) frag.appendChild(tile(it));
  grid.replaceChildren(frag);
  if (!items.length && !(view.kind === 'shader' && !q && !view.tiers.size)) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing matches that search.';
    grid.appendChild(e);
  }
}

function tile(it) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.dataset.hash = it ? it.hash : '';
  const sel = view.kind === 'shell' ? pending.shell : pending.shader;
  if ((it ? it.hash : null) === (sel || null)) b.classList.add('sel');
  if (it) {
    b.style.setProperty('--tier', tierColor(it.tier));
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = iconUrl(it.icon);
    b.appendChild(img);
    b.title = `${it.name} · ${it.tierName || ''}`;
  } else {
    const n = document.createElement('div'); n.className = 'noimg'; n.textContent = '∅'; b.appendChild(n);
    b.title = "The shell's own colours";
  }
  const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = it ? it.name : 'No shader';
  b.appendChild(nm);
  const onDesk = view.kind === 'shell' ? applied.shell : applied.shader;
  if (it && onDesk === it.hash) { const bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = 'ON'; b.appendChild(bd); }
  return b;
}

$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('.tile');
  if (!b) return;
  const hash = b.dataset.hash ? Number(b.dataset.hash) : null;
  if (view.kind === 'shell') pending.shell = hash; else pending.shader = hash;
  for (const t of $('grid').querySelectorAll('.tile.sel')) t.classList.remove('sel');
  b.classList.add('sel');
  updatePick();
  refreshPreview();
});

$('kind').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view.kind = b.dataset.kind;
  for (const x of $('kind').querySelectorAll('button')) x.classList.toggle('on', x === b);
  renderGrid();
  $('grid').scrollTop = 0;
});
let searchTimer = null;
$('search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { view.search = e.target.value; renderGrid(); }, 120); });
$('sort').addEventListener('change', (e) => { view.sort = e.target.value; renderGrid(); });
$('clear-shader').addEventListener('click', () => { pending.shader = null; updatePick(); refreshPreview(); if (view.kind === 'shader') renderGrid(); });

function updatePick() {
  const shell = pending.shell ? catalog.items[pending.shell] : null;
  const shader = pending.shader ? catalog.items[pending.shader] : null;
  $('pick-shell-name').textContent = shell ? shell.name : 'No shell picked';
  $('pick-shell-tier').textContent = shell ? (shell.tierName || '') + ' Ghost Shell' : 'Choose one from the Shells list';
  $('pick-shell-icon').src = shell ? iconUrl(shell.icon) : '';
  $('pick-shader-name').textContent = shader ? shader.name : 'Default (no shader)';
  $('pick-shader-icon').src = shader ? iconUrl(shader.icon) : '';
  $('clear-shader').hidden = !shader;
  $('pick-flavor').textContent = shell?.flavor || '';
  const same = (pending.shell || null) === (applied.shell || null) && (pending.shader || null) === (applied.shader || null);
  $('apply').disabled = !shell || same;
  $('apply').textContent = shell && same ? 'On your desktop' : 'Put on desktop';
}

let previewReq = 0;
async function refreshPreview() {
  const msg = $('stage-msg');
  const req = ++previewReq;
  if (!pending.shell) { msg.textContent = 'Pick a shell to preview it'; msg.hidden = false; return; }
  msg.textContent = 'Loading…'; msg.hidden = false;
  const ok = await preview.show(catalog, pending.shell, pending.shader);
  if (req !== previewReq) return;                   // a newer pick is loading
  if (ok) msg.hidden = true;
  else msg.textContent = "Couldn't build this shell";
}

$('apply').addEventListener('click', () => {
  if (!pending.shell) return;
  applied = { shell: pending.shell, shader: pending.shader || null };
  saveSelection(applied.shell, applied.shader);
  toOverlay({ cmd: 'shell', shell: applied.shell, shader: applied.shader });
  if (currentMode() === 'off') $('power').click();   // putting a Ghost on the desktop implies you want to see it
  updatePick();
  renderGrid();
});

/** App version in the About tab (falls back silently if the call isn't available). */
async function showVersion() {
  if ($('version').textContent) return;
  try { $('version').textContent = 'v' + (await window.__TAURI__.app.getVersion()); } catch (_) {}
}

function enterPicker() {
  $('setup').hidden = true; $('tabs').hidden = false;
  buildLists();
  pending.shell = applied.shell && catalog.items[applied.shell] ? applied.shell : null;
  pending.shader = applied.shader && catalog.items[applied.shader] ? applied.shader : null;
  preview = preview || new ShellPreview($('preview'));
  window.__preview = preview;   // dev handle: tools/pane-shots.js pins the angle for comparison shots
  showTab(['#settings', '#about'].includes(location.hash) ? location.hash.slice(1) : 'ghost');
  renderGrid();
  updatePick();
  markMode(currentMode());
  refreshPreview();
  toOverlay({ cmd: 'status' });
}

// ---------------------------------------------------------------- settings
const SETTINGS = [
  { id: 'size', key: 'sot_ghost_size', def: 108, fmt: (v) => `${v}px` },
  { id: 'minSpeed', key: 'sot_ghost_minspeed', def: 110 },
  { id: 'maxSpeed', key: 'sot_ghost_maxspeed', def: 280 },
  { id: 'scanRate', key: 'sot_ghost_scanrate', def: 1, fmt: (v) => `${v}/15` },
  { id: 'fps', key: 'sot_ghost_fps', def: 30, fmt: (v) => `${v} fps` },
];
const readNum = (key, def) => { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : def; };

for (const s of SETTINGS) {
  const input = $(s.id), out = input.nextElementSibling;
  const show = () => { out.textContent = s.fmt ? s.fmt(input.value) : input.value; };
  input.addEventListener('input', () => {
    show();
    // keep min ≤ max visibly consistent (the companion clamps too)
    if (s.id === 'minSpeed' && +input.value > +$('maxSpeed').value - 10) { $('maxSpeed').value = +input.value + 10; $('maxSpeed').dispatchEvent(new Event('input')); }
    if (s.id === 'maxSpeed' && +input.value < +$('minSpeed').value + 10) { $('minSpeed').value = +input.value - 10; $('minSpeed').dispatchEvent(new Event('input')); }
    toOverlay({ cmd: 'set', key: s.id, value: Number(input.value) });
  });
  s.show = show;
}

function currentMode() {
  try { return localStorage.getItem('sot_ghost_mode') || 'always'; } catch { return 'always'; }
}
function markMode(mode) {
  for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  const off = mode === 'off';
  $('power').textContent = off ? 'Turn Ghost on' : 'Turn Ghost off';
  $('power').classList.toggle('off', off);
}
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  markMode(b.dataset.mode);
  toOverlay({ cmd: 'mode', value: b.dataset.mode });
});
// on/off under "Put on desktop": off frees the Ghost entirely; on returns to the last visibility mode
$('power').addEventListener('click', () => {
  const off = currentMode() === 'off';
  const next = off ? (localStorage.getItem('dg_last_mode') || 'always') : 'off';
  markMode(next);
  toOverlay({ cmd: 'mode', value: next });
});

$('monitor').addEventListener('change', (e) => invoke('set_monitor', { index: Number(e.target.value) }).catch(console.warn));

$('hideFullscreen').addEventListener('change', (e) => invoke('set_hide_fullscreen', { on: e.target.checked }).catch(console.warn));

$('autostart').addEventListener('change', async (e) => {
  try { await invoke(e.target.checked ? 'plugin:autostart|enable' : 'plugin:autostart|disable'); }
  catch (err) { console.warn(err); e.target.checked = !e.target.checked; }
});

$('clear-cache').addEventListener('click', async () => {
  await invoke('clear_model_cache').catch(console.warn);
  showCacheSize();
});

$('check-update').addEventListener('click', async () => {
  const btn = $('check-update');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const v = await invoke('check_update');
    btn.textContent = v ? 'Update available' : 'Up to date';
    if (v) $('rebuild').textContent = 'Update now';
  } catch (e) { btn.textContent = "Couldn't reach Bungie"; }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Check for new items'; }, 4000);
});
$('rebuild').addEventListener('click', runSetup);

// ---------------------------------------------------------------- program updates
// Opt-in by design: a check only ever *tells* you. Nothing is downloaded or installed until the button in the
// Updates card is pressed. Looking on startup can be turned off entirely.
const AUTO_CHECK_KEY = 'dg_auto_check';
const autoCheckOn = () => { try { return localStorage.getItem(AUTO_CHECK_KEY) !== '0'; } catch { return true; } };
let foundUpdate = null;     // the Update handle from the last successful check
let installing = false;

/** Ask the update endpoint whether there is a newer version. Returns the Update, or null. */
async function checkForUpdate() {
  const u = await window.__TAURI__.updater.check();
  foundUpdate = u || null;
  showUpdateState();
  return foundUpdate;
}

function showUpdateState() {
  const card = $('update-card'), badge = $('update-badge');
  if (foundUpdate) {
    $('update-ver').textContent = 'v' + foundUpdate.version;
    $('update-notes').textContent = (foundUpdate.body || '').trim();
    card.hidden = false;
    badge.hidden = false;
  } else {
    card.hidden = true;
    badge.hidden = true;
  }
}

$('update-badge').addEventListener('click', () => {
  showTab('settings');
  $('update-card').scrollIntoView({ block: 'center', behavior: 'smooth' });
});

$('update-later').addEventListener('click', () => {
  if (installing) return;
  $('update-card').hidden = true;      // the badge stays, so it can be found again
});

$('update-check').addEventListener('click', async () => {
  const btn = $('update-check');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const u = await checkForUpdate();
    btn.textContent = u ? 'Update available' : 'Up to date';
  } catch (e) {
    console.warn(e);
    btn.textContent = "Couldn't check";
    $('update-sub').textContent = 'Could not reach the update server. Check your internet connection.';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Check now'; showVersionLine(); }, 4000);
});

$('update-install').addEventListener('click', async () => {
  if (!foundUpdate || installing) return;
  installing = true;
  const bar = $('update-bar'), msg = $('update-msg');
  $('update-install').disabled = true; $('update-later').disabled = true;
  $('update-prog').hidden = false;
  let total = 0, got = 0;
  msg.textContent = 'Downloading…';
  try {
    await foundUpdate.downloadAndInstall((ev) => {
      if (ev.event === 'Started') { total = ev.data.contentLength || 0; }
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength || 0;
        bar.style.width = total ? `${Math.min(100, (got / total) * 100)}%` : '';
        msg.textContent = total ? `Downloading… ${(got / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`
          : `Downloading… ${(got / 1048576).toFixed(1)} MB`;
      } else if (ev.event === 'Finished') {
        bar.style.width = '100%';
        msg.textContent = 'Installing — DeskGhost will close and reopen on its own.';
      }
    });
    // Windows hands over to the installer, which closes the app; if we are somehow still here, restart ourselves
    await window.__TAURI__.process.relaunch();
  } catch (e) {
    console.warn(e);
    installing = false;
    $('update-prog').hidden = true;
    $('update-install').disabled = false; $('update-later').disabled = false;
    msg.textContent = `The update didn't install: ${e?.message || e}. You can download it from the website instead.`;
  }
});

$('autoCheck').addEventListener('change', (e) => {
  try { localStorage.setItem(AUTO_CHECK_KEY, e.target.checked ? '1' : '0'); } catch {}
});

async function showVersionLine() {
  let v = '';
  try { v = await window.__TAURI__.app.getVersion(); } catch (_) {}
  $('update-sub').textContent = v ? `Version ${v} — up to date as far as this copy knows.` : '';
}

async function showCacheSize() {
  const n = await invoke('cache_size').catch(() => 0);
  $('cache-size').textContent = `${(n / 1048576).toFixed(1)} MB of shells, shaders and icons on this PC.`;
}

async function refreshSettings() {
  markMode(currentMode());
  for (const s of SETTINGS) { $(s.id).value = readNum(s.key, s.def); s.show(); }
  const mons = await invoke('list_monitors').catch(() => []);
  $('monitor').replaceChildren(...mons.map((m) => {
    const o = document.createElement('option');
    o.value = m.index; o.selected = m.current;
    o.textContent = `Display ${m.index + 1} — ${m.width}×${m.height}${m.primary ? ' (main)' : ''}`;
    return o;
  }));
  $('monitor').disabled = mons.length < 2;
  $('hideFullscreen').checked = (await invoke('get_overlay_prefs').catch(() => ({ hide_fullscreen: true }))).hide_fullscreen;
  $('autostart').checked = await invoke('plugin:autostart|is_enabled').catch(() => false);
  $('autoCheck').checked = autoCheckOn();
  showVersionLine();
  const built = catalog?.builtAt ? new Date(catalog.builtAt * 1000).toLocaleDateString() : '?';
  const n = (k) => Object.values(catalog?.items || {}).filter((x) => x.kind === k).length;
  $('catalog-info').textContent = `${n('shell')} shells and ${n('shader')} shaders · built ${built}`;
  showCacheSize();
}

// ---------------------------------------------------------------- start
(async () => {
  catalog = await loadCatalog();
  if (!catalog) runSetup();
  else enterPicker();
  // a quiet look for a newer version — it only raises the badge; installing is always a button press
  if (autoCheckOn()) checkForUpdate().catch((e) => console.warn('update check failed', e));
})();
