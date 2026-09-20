// Dev helper: render shells in the running app's picker preview and save a PNG of each.
// Usage: node tools/preview-shots.js <outDir> <hash> [hash…]   (app launched with the CDP port, see cdp.js)
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9333;

async function page(which) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const p = list.find((x) => x.type === 'page' && x.url.includes(which + '.html'));
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { send, ev, close: () => ws.close() };
}

(async () => {
  const [outDir, ...hashes] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  let app = await page('app');
  if (!app) {
    const ov = await page('overlay');
    await ov.ev("window.__TAURI__.core.invoke('show_main')"); ov.close();
    await new Promise((r) => setTimeout(r, 4000));
    app = await page('app');
  }
  await app.ev("document.querySelector('#kind [data-kind=shell]').click()");
  for (const h of hashes) {
    const name = await app.ev(`(()=>{const t=document.querySelector('.tile[data-hash="${h}"]'); if(!t) return null; t.click(); return t.querySelector('.nm').textContent;})()`);
    if (!name) { console.log(h, 'no tile'); continue; }
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { await new Promise((r) => setTimeout(r, 500)); ok = await app.ev("document.getElementById('stage-msg').hidden"); }
    await app.ev("(()=>{const p=window.__preview; if(p){p.spin=false;p.yaw=0;p.pitch=0;} return !!p})()");
    await new Promise((r) => setTimeout(r, 900));            // face the camera, then settle
    const rect = await app.ev("(()=>{const r=document.querySelector('.stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
    const shot = await app.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const file = path.join(outDir, name.replace(/[^\w]+/g, '_') + '.png');
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(ok ? 'ok ' : 'FAILED', name, '→', file);
  }
  app.close();
})().catch((e) => { console.error(e); process.exit(1); });
