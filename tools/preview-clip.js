// Dev helper: capture a SEQUENCE of preview frames for one shell, so animated effects can be judged over time
// instead of from a single frame that might land between phases.
// usage: node tools/preview-clip.js <outDir> <hash> [frames=12] [intervalMs=250]
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
  const [outDir, hash, framesArg, intervalArg] = process.argv.slice(2);
  const frames = Number(framesArg) || 12;
  const interval = Number(intervalArg) || 250;
  fs.mkdirSync(outDir, { recursive: true });
  const app = await page('app');
  await app.ev("document.querySelector('#kind [data-kind=shell]').click()");
  const name = await app.ev(`(()=>{const t=document.querySelector('.tile[data-hash="${hash}"]'); if(!t) return null; t.click(); return t.querySelector('.nm').textContent;})()`);
  if (!name) { console.error('no tile for', hash); process.exit(1); }
  for (let i = 0; i < 80; i++) { await sleep(250); if (await app.ev("document.getElementById('stage-msg').hidden")) break; }
  // hold the angle still: only the effect should change between frames
  await app.ev("(()=>{const p=window.__preview; if(p){p.spin=false;p.yaw=0;p.pitch=0;} return !!p})()");
  await sleep(600);
  const rect = await app.ev("(()=>{const r=document.querySelector('.stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  const stem = name.replace(/[^\w]+/g, '_');
  for (let f = 0; f < frames; f++) {
    const shot = await app.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    fs.writeFileSync(path.join(outDir, `${stem}_${String(f).padStart(2, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
    await sleep(interval);
  }
  console.log(`${name}: ${frames} frames every ${interval}ms → ${outDir}`);
  app.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
