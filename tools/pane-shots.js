// Dev helper: render shells in the picker preview with their stage-7 panes highlighted (window.__GHOST_PANE_DEBUG),
// so it's visible which surface the glass/solid rule decides about. Saves one PNG of the preview per shell.
// usage: node tools/pane-shots.js <outDir> <hash> [hash…]
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(which) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const p = list.find((x) => x.type === 'page' && x.url.includes(which + '.html'));
  if (!p) throw new Error('no ' + which + ' page open');
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
  const app = await page('app');
  await app.ev("window.__GHOST_PANE_DEBUG = 1; document.querySelector('#kind [data-kind=shell]').click(); 'on'");
  for (const h of hashes) {
    const name = await app.ev(`(()=>{const t=document.querySelector('.tile[data-hash="${h}"]'); if(!t) return null; t.click(); return t.querySelector('.nm').textContent;})()`);
    if (!name) { console.log(h, 'not in the picker'); continue; }
    for (let i = 0; i < 80; i++) { await sleep(250); if (await app.ev("document.getElementById('stage-msg').hidden")) break; }
    // face the camera: the preview spins on its own, which was capturing some shells from behind
    await app.ev("(()=>{const p=window.__preview; if(p){p.spin=false;p.yaw=0;p.pitch=0;} return !!p})()");
    await sleep(700);
    const rect = await app.ev("(()=>{const r=document.querySelector('.stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
    const shot = await app.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const file = path.join(outDir, `${h}_${name.replace(/[^\w]+/g, '_')}.png`);
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log('saved', path.basename(file));
  }
  await app.ev("delete window.__GHOST_PANE_DEBUG; 'off'");
  app.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
