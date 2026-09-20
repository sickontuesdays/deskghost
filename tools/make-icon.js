// Draws the app icon (a four-point Ghost-style shell with a glowing eye) → src-tauri/icons/source.png.
// Then `npm run icon` makes every size Tauri needs. No dependencies — raw RGBA + zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const c = N / 2;
const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function over(i, r, g, b, a) {
  const ia = 1 - a;
  px[i] = r * a + px[i] * ia; px[i + 1] = g * a + px[i + 1] * ia; px[i + 2] = b * a + px[i + 2] * ia;
  px[i + 3] = Math.min(255, (a + (px[i + 3] / 255) * ia) * 255);
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const dx = (x - c) / c, dy = (y - c) / c;
    const r = Math.hypot(dx, dy);
    // four-point star shell: |x|^p + |y|^p < 1 with p < 1 gives concave sides
    const p = 0.62, star = Math.pow(Math.abs(dx) / 0.94, p) + Math.pow(Math.abs(dy) / 0.94, p);
    const aStar = 1 - smooth(0.985, 1.0, star);
    if (aStar > 0) {
      const shade = 0.55 + 0.45 * clamp(0.5 - dy * 0.6 - dx * 0.25);           // light from the top-left
      const edge = smooth(0.7, 0.98, star) * 0.35;                             // darker rim
      const v = (shade - edge) * 255;
      over(i, v * 0.86, v * 0.9, v * 0.98, aStar);
    }
    // dark core ring around the eye
    const aCore = 1 - smooth(0.36, 0.375, r);
    if (aCore > 0) over(i, 18, 22, 30, aCore);
    // glowing eye
    const eye = 1 - smooth(0.17, 0.30, r);
    if (eye > 0) {
      const hot = 1 - smooth(0.0, 0.16, r);
      over(i, 90 + 165 * hot, 200 + 55 * hot, 255, eye);
    }
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'src-tauri', 'icons', 'source.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
