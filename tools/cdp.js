// Dev helper: drive the running app's webviews over Chrome DevTools Protocol.
// Launch the app with:  set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Usage:
//   node tools/cdp.js list
//   node tools/cdp.js eval <page: app|overlay> "<js expression>"      (awaits promises, prints JSON)
//   node tools/cdp.js shot <page> <out.png>
//   node tools/cdp.js logs <page> <seconds>                          (console output for N seconds)
const PORT = process.env.CDP_PORT || 9333;

async function pages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter((p) => p.type === 'page');
}

async function connect(which) {
  const list = await pages();
  const page = list.find((p) => p.url.includes(which + '.html'));
  if (!page) throw new Error(`no ${which} page; have: ${list.map((p) => p.url).join(', ')}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else listeners.forEach((f) => f(msg));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, on: (f) => listeners.push(f), close: () => ws.close() };
}

(async () => {
  const [cmd, which, arg] = process.argv.slice(2);
  if (cmd === 'list') { for (const p of await pages()) console.log(p.url); return; }
  const c = await connect(which);
  if (cmd === 'eval') {
    const r = await c.send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    else console.log(JSON.stringify(r.result?.result?.value, null, 1));
  } else if (cmd === 'shot') {
    // optional 5th arg: "ghost" = a close-up around the overlay Ghost's current position
    let clip;
    if (process.argv[5] === 'ghost') {
      const r = await c.send('Runtime.evaluate', { expression: "import('./ghost/ghost-companion.js').then(({ghostCompanion:g})=>({x:g._pos.x,y:g._pos.y,s:g._sizePx}))", awaitPromise: true, returnByValue: true });
      const g = r.result.result.value, half = g.s * 1.6;
      clip = { x: Math.max(0, g.x - half), y: Math.max(0, g.y - half), width: half * 2, height: half * 2, scale: 2 };
    }
    const r = await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    require('fs').writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved', arg);
  } else if (cmd === 'logs') {
    await c.send('Runtime.enable');
    c.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') console.log(m.params.type, m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', m.params.exceptionDetails.exception?.description);
    });
    await new Promise((r) => setTimeout(r, (Number(arg) || 5) * 1000));
  }
  c.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
