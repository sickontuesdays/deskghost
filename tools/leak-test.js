// Dev helper: stress the running app and watch for memory that doesn't come back.
// Usage: node tools/leak-test.js <switch|toggle|preview|idle> [rounds]
// (app launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333)
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(which) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const p = list.find((x) => x.type === 'page' && x.url.includes(which + '.html'));
  if (!p) throw new Error('no ' + which + ' page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  /** JS heap after a forced full GC, in MB. */
  const heap = async () => { await send('HeapProfiler.collectGarbage'); await sleep(300); await send('HeapProfiler.collectGarbage'); const h = await send('Runtime.getHeapUsage'); return +(h.result.usedSize / 1048576).toFixed(1); };
  return { send, ev, heap, close: () => ws.close() };
}

const COMP = "import('./ghost/ghost-companion.js').then(m=>m.ghostCompanion)";
const waitReady = (ov) => ov.ev(`(async()=>{const g=await ${COMP};for(let i=0;i<120;i++){if(g.three&&!g._loading)return true;await new Promise(r=>setTimeout(r,250));}return false;})()`);
const gpuCount = (ov) => ov.ev(`(async()=>{const g=await ${COMP};const i=g.three?.renderer?.info;return i?{geometries:i.memory.geometries,textures:i.memory.textures,programs:i.programs?.length}:null})()`);

(async () => {
  const [mode, roundsArg] = process.argv.slice(2);
  const rounds = Number(roundsArg) || 12;
  if (mode === 'switch' || mode === 'toggle' || mode === 'idle') {
    const ov = await page('overlay');
    const shells = await ov.ev("import('./shared.js').then(m=>m.loadCatalog()).then(c=>Object.entries(c.items).filter(([h,i])=>i.kind==='shell').map(([h])=>+h))");
    const pick = await ov.ev("JSON.parse(localStorage.getItem('dg_selection'))");
    await waitReady(ov);
    const base = await ov.heap();
    console.log(`baseline heap ${base} MB`, JSON.stringify(await gpuCount(ov)));
    for (let r = 1; r <= rounds; r++) {
      if (mode === 'switch') {
        const s = shells[(r * 37) % shells.length];
        await ov.ev(`window.__TAURI__.event.emit('ghost-cmd',{cmd:'shell',shell:${s},shader:null})`);
        await sleep(400); await waitReady(ov);
      } else if (mode === 'toggle') {
        await ov.ev("window.__TAURI__.event.emit('ghost-cmd',{cmd:'mode',value:'off'})"); await sleep(700);
        await ov.ev("window.__TAURI__.event.emit('ghost-cmd',{cmd:'mode',value:'always'})"); await sleep(400); await waitReady(ov);
      } else {
        await sleep(30000);
      }
      if (r % Math.max(1, Math.floor(rounds / 6)) === 0 || r === rounds) console.log(`round ${r}: heap ${await ov.heap()} MB`, JSON.stringify(await gpuCount(ov)));
    }
    if (mode === 'switch' && pick) { await ov.ev(`window.__TAURI__.event.emit('ghost-cmd',{cmd:'shell',shell:${pick.shell},shader:${pick.shader || null}})`); await waitReady(ov); }
    console.log(`after (pick restored) heap ${await ov.heap()} MB`, JSON.stringify(await gpuCount(ov)));
    ov.close();
  } else if (mode === 'preview') {
    let app;
    try { app = await page('app'); } catch { const ov = await page('overlay'); await ov.ev("window.__TAURI__.core.invoke('show_main')"); ov.close(); await sleep(4000); app = await page('app'); }
    await app.ev("document.querySelector('#kind [data-kind=shell]').click()");
    const hashes = await app.ev("[...document.querySelectorAll('.tile')].map(t=>t.dataset.hash)");
    const base = await app.heap();
    console.log(`baseline heap ${base} MB`);
    for (let r = 1; r <= rounds; r++) {
      await app.ev(`document.querySelector('.tile[data-hash="${hashes[(r * 41) % hashes.length]}"]').click()`);
      for (let i = 0; i < 60; i++) { await sleep(250); if (await app.ev("document.getElementById('stage-msg').hidden || document.getElementById('stage-msg').textContent.startsWith(\"Couldn't\")")) break; }
      if (r % Math.max(1, Math.floor(rounds / 6)) === 0 || r === rounds) console.log(`preview ${r}: heap ${await app.heap()} MB`);
    }
    app.close();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
