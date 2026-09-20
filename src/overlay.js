// The transparent, click-through overlay window: hosts the Ghost companion.
import { ghostCompanion } from './ghost/ghost-companion.js';
import { ghostShellSource } from './ghost/ghost-shell-source.js';
import { loadCatalog, getSelection } from './shared.js';

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

// The window ignores the mouse, so the Rust side relays the global cursor position. Re-dispatching it as a
// mousemove lets the companion code (wake-on-move, glance at the cursor) work unchanged.
listen('cursor', (e) => {
  const [x, y] = e.payload;
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
});

let lastStatus = null;
ghostCompanion.onStatus = (s) => { lastStatus = s; emit('ghost-status', s); };

// The Rust side hides the overlay window while the Ghost is off (and while a fullscreen app is in front), so it
// only occupies the screen when there's something to draw. Keep it told whether there is.
const reportOn = () => invoke('set_ghost_on', { on: ghostCompanion.getMode() !== 'off' && !!ghostShellSource.getEquippedGhost() }).catch(() => {});

// While the window is hidden, stop the render loop entirely (resumes where it left off).
listen('overlay-suspended', ({ payload: suspended }) => {
  const g = ghostCompanion;
  g._suspended = suspended;
  if (suspended) { if (g._raf) cancelAnimationFrame(g._raf); g._raf = null; }
  else if (g.three && !g._raf) { g._t0 = performance.now(); g._raf = requestAnimationFrame(g._tick); }
});

/** Show a shell. Only the shell on screen stays decoded in memory — each one holds several MB of textures. */
function showShell(shell, shader) {
  const g = ghostShellSource.getEquippedGhost();
  if (!g || g.itemHash !== (shell >>> 0) || (g.shaderHash || 0) !== ((shader || 0) >>> 0)) ghostShellSource._shellCache.clear();
  ghostCompanion.setShell(shell, shader || null);
}

async function start() {
  const catalog = await loadCatalog();
  ghostShellSource.setCatalog(catalog);
  const sel = getSelection();
  if (!catalog || !sel?.shell || !catalog.items?.[sel.shell]) {
    reportOn();                                  // nothing picked → keep the overlay hidden
    invoke('show_main');                         // nothing to show yet — send the user to the picker
    return;
  }
  showShell(sel.shell, sel.shader);
  reportOn();
  if (ghostCompanion.getMode() === 'off') ghostCompanion.onStatus({ state: 'off' });
  ghostCompanion.init();
}

// commands from the picker/settings window and the tray
const SETTERS = {
  size: (v) => ghostCompanion.setSize(v),
  minSpeed: (v) => ghostCompanion.setMinSpeed(v),
  maxSpeed: (v) => ghostCompanion.setMaxSpeed(v),
  fps: (v) => ghostCompanion.setFps(v),
  scanRate: (v) => ghostCompanion.setScanRate(v),
};
const LAST_ON_MODE = 'dg_last_mode';

/** Change visibility mode. 'off' tears the Ghost down completely (GPU context freed); turning back on returns to
 *  the last on-mode. Tells the main window so its on/off button and settings stay in sync. */
function setMode(mode) {
  const cur = ghostCompanion.getMode();
  if (mode === 'off' && cur !== 'off') localStorage.setItem(LAST_ON_MODE, cur);
  if (mode !== 'off') localStorage.setItem(LAST_ON_MODE, mode);
  ghostCompanion.setMode(mode);
  reportOn();
  emit('ghost-mode', mode);
  if (mode === 'off') ghostCompanion.onStatus({ state: 'off' });
}

listen('ghost-cmd', async ({ payload: c }) => {
  if (!c) return;
  if (c.cmd === 'shell') {
    if (!ghostShellSource._catalog) ghostShellSource.setCatalog(await loadCatalog());
    showShell(c.shell, c.shader);
    reportOn();
    if (ghostCompanion.getMode() !== 'off' && !ghostCompanion.three && !ghostCompanion._loading) ghostCompanion._enable();
  } else if (c.cmd === 'mode') {
    setMode(c.value);
  } else if (c.cmd === 'toggle') {
    setMode(ghostCompanion.getMode() !== 'off' ? 'off' : (localStorage.getItem(LAST_ON_MODE) || 'always'));
  } else if (c.cmd === 'set' && SETTERS[c.key]) {
    SETTERS[c.key](Number(c.value));
  } else if (c.cmd === 'status') {
    emit('ghost-status', ghostCompanion.getMode() === 'off' ? { state: 'off' } : (lastStatus || { state: 'idle' }));
  }
});

// a rebuilt catalog may have new shells — reload it, keep the current pick
listen('catalog-updated', async () => {
  ghostShellSource.setCatalog(await loadCatalog());
  if (!ghostCompanion.three && !ghostCompanion._loading) start();
});

start();
