// A rotating 3D preview of a shell (+ shader) in the picker. Same renderer, lighting and shell loader as the
// overlay, so what you see here is what lands on the desktop. Drag to turn it.
import { ghostShellSource } from './ghost/ghost-shell-source.js';

const SHELL_FORWARD = [1, 0, 0];   // Destiny shells: eye = model +X (same defaults as ghost-companion.js)
const SHELL_UP = [0, 0, 1];

export class ShellPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.three = null;
    this.group = null;
    this.token = 0;
    this.yaw = 0; this.pitch = 0; this.spin = true;
    this._raf = null;
    this._tick = this._tick.bind(this);
    this._bindDrag();
    document.addEventListener('visibilitychange', () => (document.hidden ? this._stop() : this._start()));
  }

  async _init() {
    if (this.three) return this.three;
    const THREE = await import('./vendor/three/three.module.js');
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.CineonToneMapping;     // matches ghost-companion.js _boot
    renderer.toneMappingExposure = 0.85;
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(0.5, 1, 1.2); scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.45); rim.position.set(-0.6, -0.3, 0.6); scene.add(rim);
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#cdd6e6'); g.addColorStop(0.5, '#7e8696'); g.addColorStop(1, '#3a3f49');
    x.fillStyle = g; x.fillRect(0, 0, 256, 128);
    const grad = new THREE.CanvasTexture(c); grad.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(grad).texture;
    grad.dispose(); pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    const holder = new THREE.Group(); scene.add(holder);
    this.three = { THREE, renderer, scene, camera, holder, base: this._baseRotation(THREE) };
    this._resize();
    new ResizeObserver(() => this._resize()).observe(this.canvas);
    return this.three;
  }

  /** Model eye (FORWARD) toward the camera, model UP to screen up — honours a calibration saved by the overlay. */
  _baseRotation(THREE) {
    let fwd = SHELL_FORWARD, up = SHELL_UP;
    try {
      const o = JSON.parse(localStorage.getItem('sot_ghost_orient') || '{}')?.shell;
      if (Array.isArray(o?.fwd) && o.fwd.length === 3) fwd = o.fwd;
      if (Array.isArray(o?.up) && o.up.length === 3) up = o.up;
    } catch (_) {}
    const mf = new THREE.Vector3(...fwd).normalize();
    const mr = new THREE.Vector3(...up).cross(mf).normalize();
    const mu = new THREE.Vector3().crossVectors(mf, mr).normalize();
    const m = new THREE.Matrix4().makeBasis(mr, mu, mf).transpose();   // model basis → identity
    return new THREE.Quaternion().setFromRotationMatrix(m);             // world basis is identity (x right, y up, z to camera)
  }

  _resize() {
    if (!this.three) return;
    const { renderer, camera } = this.three;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  _bindDrag() {
    let last = null;
    this.canvas.addEventListener('pointerdown', (e) => { last = { x: e.clientX, y: e.clientY }; this.spin = false; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.yaw += (e.clientX - last.x) * 0.01;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + (e.clientY - last.y) * 0.01));
      last = { x: e.clientX, y: e.clientY };
    });
    const end = () => { last = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('dblclick', () => { this.spin = true; this.pitch = 0; });
  }

  /** Show a shell. Resolves true when shown, false if it failed or a newer request replaced it. */
  async show(catalog, shellHash, shaderHash) {
    const token = ++this.token;
    const { THREE, holder, camera } = await this._init();
    ghostShellSource.setCatalog(catalog);
    ghostShellSource._shellCache.clear();                 // keep only one decoded shell in memory while browsing
    ghostShellSource.setSelection(shellHash, shaderHash || null);
    let group = null;
    try { group = await ghostShellSource.loadEquippedShell(THREE); } catch (_) { group = null; }
    if (token !== this.token) { if (group) this._dispose(group); return false; }
    if (this.group) { holder.remove(this.group); this._dispose(this.group); this.group = null; }
    if (!group) { this._stop(); this._renderOnce(); return false; }

    const box = new THREE.Box3().setFromObject(group);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    group.position.sub(box.getCenter(new THREE.Vector3()));
    const pivot = new THREE.Group(); pivot.add(group);
    holder.add(pivot);
    this.group = pivot;
    const dist = sphere.radius / Math.sin((camera.fov * Math.PI) / 360) * 1.12;
    camera.position.set(0, 0, dist); camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
    this.ud = group.userData || {};
    this._start();
    return true;
  }

  _start() { if (!this._raf && this.group && !document.hidden) { this._t = performance.now(); this._raf = requestAnimationFrame(this._tick); } }
  _stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  _renderOnce() { if (this.three) this.three.renderer.render(this.three.scene, this.three.camera); }

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this._t) / 1000); this._t = now;
    const { THREE, holder, base, renderer, scene, camera } = this.three;
    if (this.spin) this.yaw += dt * 0.45;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch));
    holder.quaternion.copy(q).multiply(base);
    const ud = this.ud || {}, t = now / 1000;
    if (ud.eye?.count) ud.eye.set({ open: 1, intensity: 0.75 });
    if (ud.glow?.count) ud.glow.set(1 + 0.12 * Math.sin(t * 1.1));
    if (ud.vfx?.count) ud.vfx.set(t);
    if (ud.ddAnim?.count) ud.ddAnim.set(t);
    if (ud.cards?.count) ud.cards.set(t);
    if (ud.rotor?.count) ud.rotor.set(t);
    renderer.render(scene, camera);
  }

  _dispose(obj) {
    obj.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose?.(); }
    });
  }
}
