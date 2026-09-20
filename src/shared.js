// Helpers shared by the overlay and the main window. Both pages are served from the same origin, so they share
// localStorage — the pick and the companion's settings live there.

export const BUNGIE_ROOT = 'http://bungie.localhost';   // the app's caching proxy for www.bungie.net (src-tauri/src/cache.rs)
const SELECTION_KEY = 'dg_selection';                     // { shell: hash, shader: hash|null }

/** The catalog built on first run ({ version, builtAt, items }), or null if setup hasn't run. */
export async function loadCatalog() {
  try {
    const buf = await window.__TAURI__.core.invoke('get_catalog');
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf || []);
    if (!bytes.length) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    console.warn('[deskghost] catalog unavailable:', e?.message || e);
    return null;
  }
}

export function getSelection() {
  try { return JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null'); } catch { return null; }
}

export function saveSelection(shell, shader) {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ shell: shell || null, shader: shader || null })); } catch (_) {}
}

export function iconUrl(icon) {
  return icon ? BUNGIE_ROOT + icon : '';
}
