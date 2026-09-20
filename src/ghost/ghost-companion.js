/**
 * DESKGHOST PORT of sick-on-tuesday/js/ghost/ghost-companion.js. Differences (keep current for re-syncing):
 *   - the model is always a Destiny shell the user picked (setShell) — the bundled test GLB is gone
 *   - no profile polling / site-action hooks; the overlay window is the whole desktop, so a "panel scan"
 *     can happen anywhere (_panelRectAt)
 *   - mouse input arrives as synthetic mousemove events relayed from the Rust side (the window is click-through)
 *   - default mode is 'always'; three.js is loaded from the app's own vendor folder
 *
 * Ghost Companion — a floating 3D "ghost" that drifts around the site
 * on a transparent, click-through overlay above everything. Phase 1: wander + tumble +
 * float, face its direction of travel, wake-on-mouse-move with a grow-from-zero animation.
 *
 * three.js is lazy-loaded (vendored in lib/vendor/three) only when the companion is enabled,
 * so it costs nothing when off. Pauses rendering when the tab is hidden.
 *
 * Modes (persisted in localStorage 'sot_ghost_mode'):
 *   'off'    — disabled, nothing loaded.
 *   'wake'   — hidden until you move the mouse; grows in, wanders, sleeps after idle. (default)
 *   'always' — always present and wandering.
 *
 * Calibration: FORWARD is the model-space direction its "eye" points (auto-detected from the
 * texture). If it's slightly off, enable the live calibrator: localStorage.sot_ghost_calibrate='1'
 * then reload — arrow keys + Q/E nudge the forward axis and it logs the vector to copy back here.
 */

import { ghostShellSource } from './ghost-shell-source.js';

const THREE_URL = '../vendor/three/three.module.js';

const STORAGE_MODE = 'sot_ghost_mode';
// liquid-metal spike loop (measured from in-game footage @30fps): each set out 3s, then 3s with both retracted
const SPIKE_CYCLE_MS = 12000;
const SPIKE_OUT_MS = 3000;
const SPIKE_MOVE_MS = 110;                        // extend / retract ≈ 3 frames
const CALIBRATE_KEY = 'sot_ghost_calibrate';
// Ring motion. Both rings REST at their designed alignment (angle 0) — the front and back petal sets are built to
// line up, so leaving either at an arbitrary angle looks broken. Every departure returns to 0: the small
// back-and-forth nudges damp out, and the back ring's occasional full revolution lands exactly one turn later.
// The front ring only ever nudges; only the back ring ever makes a full turn, and rarely.
const RING_FRONT_GAP = [6000, 14000];    // ms between the front ring's nudges (occasional)
const RING_BACK_GAP = [2200, 5000];      // the back ring fidgets noticeably more often
const RING_REV_GAP = [28000, 65000];     // ms between the back ring's full revolutions (once in a while)
const RING_REV_MS = 2600;
const RING_GAP_NEVER = [1e9, 1e9];       // rig tab: rings only move when you play them
// Eye-forward + up directions in model space. FORWARD = the "front" (eye) that faces the player;
// UP = which model axis points up on screen (so it isn't rolled onto its side). Calibrated live via
// the admin Ghost tab, persisted PER MODEL (the bundled GLB and equipped shells differ).
const SHELL_FORWARD = [1, 0, 0];         // Destiny shells: eye = model +X (user-verified)
const SHELL_UP = [0, 0, 1];              // best-guess up; tune live via the up-roll calibration
const STORAGE_ORIENT = 'sot_ghost_orient'; // { shell:{fwd,up,eye} }

const DEFAULT_SIZE_PX = 108;  // ~50% larger than the prior 72px (itself 50% > the 48px weapon icons)
const STORAGE_SIZE = 'sot_ghost_size';
const STORAGE_MIN = 'sot_ghost_minspeed';
const STORAGE_MAX = 'sot_ghost_maxspeed';
const DEFAULT_MIN_SPEED = 110; // px/s — ~4x the old 28 (min was "way too slow")
const DEFAULT_MAX_SPEED = 280; // px/s
const STORAGE_FPS = 'sot_ghost_fps';
const DEFAULT_FPS = 30;        // render cap — halves the always-on GPU vs 60fps; still smooth
const STORAGE_SCANRATE = 'sot_ghost_scanrate';
const DEFAULT_SCANRATE = 1;    // scans per 15 idle gestures (when over a panel); 1..15
const EDGE_MARGIN = 90;        // keep this far from viewport edges while wandering
const WAKE_GROW_MS = 360;      // grow-from-zero duration
const SLEEP_AFTER_MS = 4500;   // (wake mode) sleep this long after the last mouse move

export class GhostCompanion {
  constructor() {
    this.mode = this._loadMode();
    this.three = null;          // { THREE, scene, camera, renderer, model, ... }
    this._loading = null;
    this._raf = null;
    this._canvas = null;

    // wander/animation state
    this._pos = { x: 0, y: 0 };       // screen-space center (px)
    this._target = { x: 0, y: 0 };
    this._vel = { x: 0, y: 0 };
    this._legSpeed = 70;              // px/s for the current leg (varies per leg)
    this._state = 'wander';           // 'wander' | 'idle'
    this._stateUntil = 0;             // when the current idle ends
    this._nextGestureAt = 0;          // next idle gesture (jump / twirl / look-around)
    this._jump = null;                // active jump: { start, dur, height, twirl }
    this._jumpP = 0;                  // current jump progress 0..1
    this._lookBoost = 0;              // until-time for a wider "look around" beat
    this._scan = null;                // active panel scan: { start, dur, dirX, dirY }
    this._tilt = null;                // active head-tilt: { start, dur, amp, cycles }
    this._shudder = null;             // active shudder/"spaz": { start, dur }
    this._float = null;               // active long float-in-place: { start, dur, anchorX, anchorY }
    this._perk = null;                // curious perk-up & lean-in: { start, dur, fromX, fromY, towardX, towardY }
    this._transmat = null;            // rare transmat blink: { start, dur, blinkX, blinkY, moved }
    this._spin = null;                // "processing" whole-shell spin-up: { start, dur, dir, turns }
                                      // turns MUST be a whole number: the roll is dropped the instant the spin
                                      // ends, so a fractional count leaves the shell part-way round and it snaps
                                      // back upright (2.5 turns = a visible 180° jump).
    this._speak = null;               // eye "transmit" flicker beat: { start, dur }
    this._gScale = 1;                 // gesture scale multiplier (transmat shrink/grow)
    this._lastGesture = null;         // last idle gesture type (so the same one never plays back-to-back)
    this._react = null;               // action reaction: { phase:'wait'|'nod', start, nodStart, nodDur, variant }
    this._lastActionAt = 0;           // last site-action ping (trailing-debounce the nod until actions settle)
    this._lastNodAt = 0;              // cooldown after a nod (so a burst of calls = one nod)
    this._lastNodVariant = -1;        // vary consecutive nods
    this._lastShudderAt = 0;          // debounce the delete-shudder reaction
    this._spawnMaterialize = false;   // pending: play the transmat "in" on first appear
    this._materializeAt = 0;          // timestamp of the spawn burst
    this._scale = 0;                  // 0..1 grow-in
    this._scaleTarget = 0;
    this._lastMouse = { x: 0, y: 0, t: 0 };
    this._wobbleSeed = Math.random() * 1000;
    this._ringNudgeF = this._ringNudgeB = this._ringRev = null;   // ring fidgets / rare full turn (see _ringNudge)
    this._fwd = SHELL_FORWARD.slice();
    this._up = SHELL_UP.slice();
    this._eyeOff = 0.40;              // eye distance from model centre (× on-screen size); per-model
    this._t0 = performance.now();
    this._axes = null;                // AxesHelper in calibrate mode
    this._sizePx = this._loadSize();  // on-screen size in px (live-adjustable)
    this._diam = 1;                   // model bounding-sphere diameter (set at load)
    this._minSpeed = this._loadNum(STORAGE_MIN, DEFAULT_MIN_SPEED); // travel speed bounds (px/s)
    this._maxSpeed = this._loadNum(STORAGE_MAX, DEFAULT_MAX_SPEED);
    this._fps = this._loadNum(STORAGE_FPS, DEFAULT_FPS);            // render frame-rate cap
    this._scanRate = Math.max(1, Math.min(15, Math.round(this._loadNum(STORAGE_SCANRATE, DEFAULT_SCANRATE)))); // scans per 15 idle gestures over a panel
    this._shellKey = null;                                          // itemHash:shaderHash of the loaded shell
    this.onStatus = null;                                           // DESKGHOST: ({ state:'loading'|'ready'|'error', key }) callback
    this._loadOrient();                                           // per-model forward/up calibration

    this._onMouseMove = this._onMouseMove.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onCalibKey = this._onCalibKey.bind(this);
    this._tick = this._tick.bind(this);
  }

  // ---------- public API ----------
  init() {
    if (this.mode === 'off') return;
    // don't pop in the instant the app starts — wait a moment, then materialize (the transmat "in") on first appear
    setTimeout(() => { if (this.mode !== 'off') this._enable(); }, 1500);
  }

  setMode(mode) {
    if (!['off', 'wake', 'always', 'calibrate', 'rig'].includes(mode)) return;
    const prev = this.mode;
    this.mode = mode;
    try { localStorage.setItem(STORAGE_MODE, mode); } catch (_) {}
    if (prev === 'calibrate' && mode !== 'calibrate') this._exitCalibrate();
    if (prev === 'rig' && mode !== 'rig') this._exitRigDrag();
    if (mode === 'off') { this._disable(); return; }
    Promise.resolve(this._enable()).then(() => {
      if (this.mode === 'calibrate' && this.three) this._enterCalibrate(this.three.THREE);
      else if (this.mode === 'rig') { this._enterRigDrag(); this._scaleTarget = 1; }
      else this._scaleTarget = (this.mode === 'always') ? 1 : 0;
    });
  }
  getMode() { return this.mode; }

  // ---- size (live-adjustable; persisted) ----
  _loadSize() { try { return Number(localStorage.getItem(STORAGE_SIZE)) || DEFAULT_SIZE_PX; } catch { return DEFAULT_SIZE_PX; } }
  _fit() { return this._sizePx / (this._diam || this._sizePx); }
  getSize() { return Math.round(this._sizePx); }
  setSize(px) {
    this._sizePx = Math.max(24, Math.min(480, px));
    try { localStorage.setItem(STORAGE_SIZE, String(Math.round(this._sizePx))); } catch (_) {}
    return this.getSize();
  }
  nudgeSize(d) { return this.setSize(this._sizePx + d); }

  // ---- travel speed bounds (px/s, persisted) ----
  _loadNum(key, def) { try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : def; } catch { return def; } }
  _loadBool(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : v === '1'; } catch { return def; } }
  getMinSpeed() { return Math.round(this._minSpeed); }
  getMaxSpeed() { return Math.round(this._maxSpeed); }
  setMinSpeed(v) { this._minSpeed = Math.max(20, Math.min(this._maxSpeed - 10, v)); try { localStorage.setItem(STORAGE_MIN, String(Math.round(this._minSpeed))); } catch (_) {} return this.getMinSpeed(); }
  setMaxSpeed(v) { this._maxSpeed = Math.max(this._minSpeed + 10, Math.min(1500, v)); try { localStorage.setItem(STORAGE_MAX, String(Math.round(this._maxSpeed))); } catch (_) {} return this.getMaxSpeed(); }
  nudgeMinSpeed(d) { return this.setMinSpeed(this._minSpeed + d); }
  nudgeMaxSpeed(d) { return this.setMaxSpeed(this._maxSpeed + d); }

  // ---- render frame-rate cap (persisted) ----
  getFps() { return Math.round(this._fps); }
  setFps(v) { this._fps = Math.max(10, Math.min(60, v)); try { localStorage.setItem(STORAGE_FPS, String(Math.round(this._fps))); } catch (_) {} return this.getFps(); }
  nudgeFps(d) { return this.setFps(this._fps + d); }

  getScanRate() { return this._scanRate; }                          // scans per 15 idle gestures (over a panel)
  setScanRate(v) { this._scanRate = Math.max(1, Math.min(15, Math.round(v))); try { localStorage.setItem(STORAGE_SCANRATE, String(this._scanRate)); } catch (_) {} return this._scanRate; }
  nudgeScanRate(d) { return this.setScanRate(this._scanRate + d); }


  // ---- DESKGHOST: which shell to show (the user's pick); reloads the model when it changes ----
  setShell(itemHash, shaderHash = null) {
    ghostShellSource.setSelection(itemHash, shaderHash);
    const g = ghostShellSource.getEquippedGhost();
    const key = g ? `${g.itemHash}:${g.shaderHash || 0}` : null;
    if (key === this._shellKey && this.three) return;
    this._shellKey = key;
    if (this.mode !== 'off' && (this.three || this._loading)) {
      Promise.resolve(this._loading).then(() => { this._disable(); this._enable(); });
    }
  }

  // ---- action reaction: gracefully stop, look at the user, wait for the action to finish, then nod ----
  _reactActive() { return !(this.mode === 'off' || !this.three || !this.three.holder); }
  /** Call as a site action BEGINS: ease out of whatever it's doing and look at the user, then wait. */
  prepareReact() {
    if (!this._reactActive()) return;
    const now = performance.now();
    this._lastActionAt = now;
    if (this._react || now - this._lastNodAt < 1500) return;         // already reacting / just nodded
    this._startReact(now);
  }
  /** Call when the action COMPLETES (or alone, if you can't hook the start). Pings activity; the
   *  loop nods once the pings go quiet (so a whole build = one nod after it finishes). */
  acknowledge() {
    if (!this._reactActive()) return;
    const now = performance.now();
    this._lastActionAt = now;
    if (this._react) return;                                         // already settling → loop will nod when quiet
    if (now - this._lastNodAt < 1500) return;
    this._startReact(now);
  }
  cancelReact() { if (this._react && this._react.phase === 'wait') this._react = null; } // action failed → no nod
  react(kind) { this.acknowledge(); }
  /** Reaction to DELETING something (a build): a full-body shudder, in place. Debounced. */
  reactDelete() {
    if (!this._reactActive()) return;
    const now = performance.now();
    if (now - this._lastShudderAt < 1200) return;
    this._lastShudderAt = now;
    if (this.mode === 'wake') { this._scaleTarget = 1; this._lastMouse.t = now; if (!this._raf && this.three) { this._t0 = now; this._raf = requestAnimationFrame(this._tick); } }
    this._state = 'idle'; this._path = null; this._stateUntil = Math.max(this._stateUntil, now + 1700);
    this._shudder = { start: now, dur: 1050 + Math.random() * 350 };
  }
  _startReact(now) {
    // drop the current gesture(s); orientation will SLERP to face the user (graceful, no snap)
    this._jump = this._tilt = this._shudder = this._float = this._perk = this._spin = this._speak = this._transmat = null;
    this._gScale = 1; this._state = 'idle'; this._path = null; this._stateUntil = now + 6000;
    this._react = { phase: 'wait', start: now };
    if (this.mode === 'wake') { this._scaleTarget = 1; this._lastMouse.t = now; if (!this._raf && this.three) { this._t0 = now; this._raf = requestAnimationFrame(this._tick); } }
  }

  // ---- forward + up calibration (per model; persisted; used by the admin Ghost tab) ----
  _orientKey() { return 'shell'; }
  _loadOrient() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem(STORAGE_ORIENT) || '{}') || {}; } catch (_) {}
    const o = store[this._orientKey()] || {};
    const dF = SHELL_FORWARD, dU = SHELL_UP;
    this._fwd = (Array.isArray(o.fwd) && o.fwd.length === 3) ? o.fwd.slice() : dF.slice();
    this._up = (Array.isArray(o.up) && o.up.length === 3) ? o.up.slice() : dU.slice();
    this._eyeOff = (typeof o.eye === 'number') ? o.eye : 0.18; // eye distance from centre (× size)
  }
  _saveOrient() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem(STORAGE_ORIENT) || '{}') || {}; } catch (_) {}
    store[this._orientKey()] = { fwd: this._fwd, up: this._up, eye: this._eyeOff };
    try { localStorage.setItem(STORAGE_ORIENT, JSON.stringify(store)); } catch (_) {}
  }
  getEyeOffset() { return this._eyeOff; }
  setEyeOffset(v) { this._eyeOff = Math.max(0, Math.min(1.5, v)); this._saveOrient(); return this._eyeOff; }
  nudgeEyeOffset(d) { return this.setEyeOffset(this._eyeOff + d); }

  getForward() { return this._fwd.slice(); }
  nudgeForward(axis, delta) { const f = this._fwd.slice(); f[axis] += delta; this.setForward(f[0], f[1], f[2]); return this.getForward(); }
  resetForward() {
    const dF = SHELL_FORWARD, dU = SHELL_UP;
    this.setForward(dF[0], dF[1], dF[2]); this.setUp(dU[0], dU[1], dU[2]); return this.getForward();
  }
  setForward(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    this._fwd = [x / l, y / l, z / l];
    this._saveOrient();
    console.log('[ghost] FORWARD =', this._fwd.map((v) => v.toFixed(3)));
  }

  getUp() { return this._up.slice(); }
  setUp(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    this._up = [x / l, y / l, z / l];
    this._saveOrient();
    console.log('[ghost] UP =', this._up.map((v) => v.toFixed(3)));
  }
  /** Roll the UP axis around FORWARD by `delta` radians — the "which way is up" calibration. */
  nudgeUpRoll(delta) {
    const f = this._fwd, u = this._up, c = Math.cos(delta), s = Math.sin(delta);
    const d = f[0] * u[0] + f[1] * u[1] + f[2] * u[2];               // Rodrigues rotation of u around f
    const cx = f[1] * u[2] - f[2] * u[1], cy = f[2] * u[0] - f[0] * u[2], cz = f[0] * u[1] - f[1] * u[0];
    this.setUp(u[0] * c + cx * s + f[0] * d * (1 - c), u[1] * c + cy * s + f[1] * d * (1 - c), u[2] * c + cz * s + f[2] * d * (1 - c));
    return this.getUp();
  }

  /** Rotation mapping the model basis (fwdArr eye, upArr up) onto world (wFwd forward, ~screen-up). */
  _orient(THREE, fwdArr, upArr, wFwd) {
    const o = this._otmp || (this._otmp = {
      mf: new THREE.Vector3(), mr: new THREE.Vector3(), mu: new THREE.Vector3(),
      wf: new THREE.Vector3(), wr: new THREE.Vector3(), wu: new THREE.Vector3(),
      m1: new THREE.Matrix4(), m2: new THREE.Matrix4(), q: new THREE.Quaternion(),
    });
    const mf = o.mf.set(fwdArr[0], fwdArr[1], fwdArr[2]).normalize();
    const mr = o.mr.set(upArr[0], upArr[1], upArr[2]).cross(mf);     // right = up × fwd
    if (mr.lengthSq() < 1e-6) mr.set(0, 1, 0).cross(mf);
    if (mr.lengthSq() < 1e-6) mr.set(1, 0, 0);
    mr.normalize();
    const mu = o.mu.crossVectors(mf, mr).normalize();               // up re-orthogonalized
    const wf = o.wf.copy(wFwd).normalize();
    const wr = o.wr.set(0, 1, 0).cross(wf);
    if (wr.lengthSq() < 1e-6) wr.set(1, 0, 0);
    wr.normalize();
    const wu = o.wu.crossVectors(wf, wr).normalize();
    const mMat = o.m1.makeBasis(mr, mu, mf);
    const wMat = o.m2.makeBasis(wr, wu, wf);
    mMat.transpose();                                               // orthonormal → inverse = transpose
    wMat.multiply(mMat);                                            // R = worldBasis · modelBasisᵀ
    return o.q.setFromRotationMatrix(wMat);
  }

  /** An equirectangular gradient texture used to build a neutral environment map for PBR metals.
   *  Must be a proper 2:1 size: PMREMGenerator sizes its cube from width/4, and anything below its
   *  minimum LOD (16px wide → 4px cube) silently yields a BLACK environment. */
  _makeEnvGradient(THREE) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#cdd6e6');   // brighter "sky"
    g.addColorStop(0.5, '#7e8696');
    g.addColorStop(1, '#3a3f49');   // darker "ground"
    x.fillStyle = g; x.fillRect(0, 0, 256, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
  }

  _loadMode() {
    // DESKGHOST: on by default — the whole point of the app. 'off' hides it (and frees the GPU context).
    try { return localStorage.getItem(STORAGE_MODE) || 'always'; } catch { return 'always'; }
  }

  // ---------- enable / disable ----------
  async _enable() {
    if (this.three || this._loading) return;
    this._loading = this._boot().catch((e) => { console.warn('[ghost] failed to start:', e?.message || e); this._loading = null; });
    await this._loading;
  }

  /**
   * Fully tear down so toggling off frees essentially all of the companion's memory: the
   * WebGL/GPU context, every geometry/texture/material, the scene graph, renderer and canvas.
   * Re-enabling rebuilds from scratch (the .glb re-loads from HTTP cache). The only thing that
   * can't be reclaimed is the three.js module code itself (~1.3MB) — ES modules stay cached by
   * the loader for the page's lifetime — but that's small next to the GPU context + model.
   */
  _disable() {
    this._exitCalibrate();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    const ctx = this.three;
    if (ctx) {
      try {
        ctx.scene?.traverse((o) => {
          o.geometry?.dispose?.();
          const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          for (const m of mats) {
            for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } // every *Map texture
            m.dispose?.();
          }
        });
        ctx.scene?.clear?.();
        ctx.renderer?.dispose?.();
        ctx.renderer?.forceContextLoss?.();   // actually releases the WebGL/GPU context
        if (ctx.renderer) ctx.renderer.domElement = null;
      } catch (_) {}
    }
    this._canvas?.remove();
    this._canvas = null;
    this.three = null;        // scene graph + renderer now unreferenced → GC'd
    this._loading = null;
    this._scale = 0;
    this._scan = null;
    this._tilt = null;
    this._shudder = null;
    this._float = null;
    this._perk = null;
    this._transmat = null;
    this._spin = null;
    this._speak = null;
    this._react = null;
    this._gScale = 1;
    this._spawnMaterialize = false; this._materializeAt = 0;
    this._tmp = null; this._scanLook = null; this._eyeDir = null; this._nextBlink = 0; this._coreLook = null; this._morphT0 = null;
  }

  async _boot() {
    const THREE = await import(THREE_URL);
    const shellKey = this._shellKey;
    this.onStatus?.({ state: 'loading', key: shellKey });

    const canvas = document.createElement('canvas');
    canvas.id = 'ghost-canvas';
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: '99999'
    });
    document.body.appendChild(canvas);
    this._canvas = canvas;

    // antialias OFF (the ghost is tiny + moving, so MSAA isn't worth its full-screen multisampled
    // framebuffer) and DPR capped at 1.5 — together this cuts the dominant GPU cost several-fold.
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    // filmic highlight rolloff — measured closest to Destiny's own item renders (see the lighting note below)
    // Cineon rather than ACES: ACES desaturates hard, and measured against Bungie's own item shots across the
    // 24-shell calibration set our colours came out at 0.79 of theirs. Cineon at 0.85 exposure lifts that to 0.89
    // with mean brightness still matched (luma ratio 0.98), which is the "washed out" complaint.
    renderer.toneMapping = THREE.CineonToneMapping;
    renderer.toneMappingExposure = 0.85;

    const scene = new THREE.Scene();
    // Calibrated against Bungie's own item screenshots: 24 shells, subject segmented out of both images, scoring
    // brightness + saturation + hue error over ~14 lighting/tone-mapping settings (tools/ghost-build/shader-research).
    // The old rig (ambient 1.6 / key 2.2 / rim 0.8, no tone mapping) rendered shells ~22% too bright and washed out.
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(0.5, 1, 1.2); scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.45); rim.position.set(-0.6, -0.3, 0.6); scene.add(rim);
    // neutral environment map — PBR metals (the equipped shell is highly metallic) render near-black
    // without something to reflect; a soft gradient env makes them read as lit metal.
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const grad = this._makeEnvGradient(THREE);
      scene.environment = pmrem.fromEquirectangular(grad).texture;
      grad.dispose(); pmrem.dispose();
    } catch (e) { console.warn('[ghost] env map failed:', e?.message || e); }

    const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 4000);
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);

    this.three = { THREE, renderer, scene, camera, model: null };
    this._onResize();

    // the model: the shell the user picked. No fallback model — if it can't be built, say so and stay hidden.
    let model = null;
    try { model = await ghostShellSource.loadEquippedShell(THREE); } catch (_) { model = null; }
    if (this.three?.renderer !== renderer) return;                  // torn down / restarted while loading
    if (!model) {
      console.warn('[ghost] no shell to show (nothing picked, or it failed to load)');
      this._disable();
      this.onStatus?.({ state: 'error', key: shellKey });
      return;
    }
    // center the model so it rotates about its own center
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    model.position.sub(center);                       // recenter geometry on origin
    const holder = new THREE.Group();                 // holder handles screen position + scale
    holder.add(model);
    this._diam = sphere.radius * 2;                   // remembered so size can change live
    holder.scale.setScalar(this._fit());
    scene.add(holder);
    this.three.model = model;
    this.three.holder = holder;
    this._buildScanFx(THREE, scene);                  // panel-scan beams (hidden until used)
    this._buildEyeGlow(THREE, scene);                 // always-on eye glow + transmat burst sprite

    // start somewhere sensible
    this._pos = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.4 };
    this._path = null;
    this._pickNewPath();
    this._scaleTarget = (this.mode === 'always') ? 1 : 0;
    this._spawnMaterialize = true;                    // play the transmat "in" (burst + grow) on first appear

    window.addEventListener('mousemove', this._onMouseMove, { passive: true });
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    if (this.mode === 'calibrate') this._enterCalibrate(THREE);

    this._t0 = performance.now();
    this._raf = requestAnimationFrame(this._tick);
    console.log(`[ghost] companion online (mode: ${this.mode})`);
    this.onStatus?.({ state: 'ready', key: shellKey });
  }

  // ---------- events ----------
  _onMouseMove(e) {
    this._lastMouse = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.mode === 'wake') {
      this._scaleTarget = 1;                                  // wake up
      if (!this._raf && this.three) { this._t0 = performance.now(); this._raf = requestAnimationFrame(this._tick); } // resume if it had gone to sleep
    }
  }
  _onResize() {
    if (!this.three) return;
    const w = window.innerWidth, h = window.innerHeight;
    const { camera, renderer } = this.three;
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  _onVisibility() {
    if (document.hidden) { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
    else if (this.three && !this._raf) { this._t0 = performance.now(); this._raf = requestAnimationFrame(this._tick); }
  }

  // ---------- wander ----------
  /** Pick a new spot and a CURVED path to it (arc or s-curve) at a varied in-range speed. */
  _pickNewPath() {
    const w = window.innerWidth, h = window.innerHeight;
    const start = { x: this._pos.x, y: this._pos.y };
    const end = { x: EDGE_MARGIN + Math.random() * (w - 2 * EDGE_MARGIN), y: EDGE_MARGIN + Math.random() * (h - 2 * EDGE_MARGIN) };
    this._target = end;

    // leg speed within [min, max]; ~20% are near-max "darts".
    const r = Math.random();
    this._legSpeed = r > 0.8
      ? this._maxSpeed * (0.85 + Math.random() * 0.15)
      : this._minSpeed + Math.random() * (this._maxSpeed - this._minSpeed) * 0.6;

    // build a curved control polygon: arc (quadratic) or s-curve (cubic)
    const dx = end.x - start.x, dy = end.y - start.y, d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d, ny = dx / d;                       // unit perpendicular
    let pts;
    if (Math.random() < 0.5) {                             // s-curve (cubic) — control pts on opposite sides
      const off = d * (0.18 + Math.random() * 0.22), s = Math.random() < 0.5 ? 1 : -1;
      pts = [start,
        { x: start.x + dx * 0.33 + nx * off * s, y: start.y + dy * 0.33 + ny * off * s },
        { x: start.x + dx * 0.66 - nx * off * s, y: start.y + dy * 0.66 - ny * off * s },
        end];
    } else {                                               // arc (quadratic) — one bowed control pt
      const off = d * (0.22 + Math.random() * 0.3) * (Math.random() < 0.5 ? 1 : -1);
      pts = [start, { x: (start.x + end.x) / 2 + nx * off, y: (start.y + end.y) / 2 + ny * off }, end];
    }
    // approximate arc length so speed stays ~constant in px/s
    let len = 0, prev = pts[0];
    for (let i = 1; i <= 16; i++) { const p = this._bezierAt(pts, i / 16); len += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
    this._path = { pts, len: len || 1, u: 0 };
  }

  _bezierAt(pts, u) {
    const v = 1 - u;
    if (pts.length === 3) { const a = v * v, b = 2 * v * u, c = u * u; return { x: a * pts[0].x + b * pts[1].x + c * pts[2].x, y: a * pts[0].y + b * pts[1].y + c * pts[2].y }; }
    const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, e = u * u * u;
    return { x: a * pts[0].x + b * pts[1].x + c * pts[2].x + e * pts[3].x, y: a * pts[0].y + b * pts[1].y + c * pts[2].y + e * pts[3].y };
  }
  _bezierTangent(pts, u) {
    const v = 1 - u; let tx, ty;
    if (pts.length === 3) {
      tx = 2 * v * (pts[1].x - pts[0].x) + 2 * u * (pts[2].x - pts[1].x);
      ty = 2 * v * (pts[1].y - pts[0].y) + 2 * u * (pts[2].y - pts[1].y);
    } else {
      tx = 3 * v * v * (pts[1].x - pts[0].x) + 6 * v * u * (pts[2].x - pts[1].x) + 3 * u * u * (pts[3].x - pts[2].x);
      ty = 3 * v * v * (pts[1].y - pts[0].y) + 6 * v * u * (pts[2].y - pts[1].y) + 3 * u * u * (pts[3].y - pts[2].y);
    }
    const l = Math.hypot(tx, ty) || 1; return { x: tx / l, y: ty / l };
  }

  // ---------- main loop ----------
  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    if (now - this._t0 < (1000 / this._fps) - 1) return;   // throttle: skip frames to hold the FPS cap
    const dt = Math.min(0.06, (now - this._t0) / 1000);
    this._t0 = now;
    if (!this.three) return;
    const { THREE, renderer, scene, camera, holder } = this.three;
    if (!holder) return;

    // calibrate mode: parked top-right, full size, facing the camera dead-on (no wander/wobble)
    if (this.mode === 'calibrate') {
      this._scale = 1;
      holder.visible = true;
      const p = this._calibPos();
      holder.position.set(p.x - window.innerWidth / 2, window.innerHeight / 2 - p.y, 0);
      holder.scale.setScalar(this._fit());
      this._faceCamera(THREE, dt);
      renderer.render(scene, camera);
      return;
    }

    // rig inspector: parked dead-centre at whatever angle you dragged it to, nothing moving on its own —
    // each animation runs only while you play it, so they can be watched one at a time. See _tickRig.
    if (this.mode === 'rig') { this._tickRig(THREE, renderer, scene, camera, holder, now, dt); return; }

    // grow-in / sleep scale (ease toward target)
    const grow = dt / (WAKE_GROW_MS / 1000);
    this._scale += Math.sign(this._scaleTarget - this._scale) * Math.min(Math.abs(this._scaleTarget - this._scale), grow);
    if (this.mode === 'wake' && now - this._lastMouse.t > SLEEP_AFTER_MS) this._scaleTarget = 0;
    if (this._spawnMaterialize && this._scaleTarget === 1) { this._materializeAt = now; this._spawnMaterialize = false; } // transmat-in burst as it first appears

    const awake = this._scale > 0.001;
    holder.visible = awake;
    if (this.three.glow) this.three.glow.visible = false;              // shells draw their own eye (the sprite was for the old GLB)
    if (awake) {
      this._updateReactState(now);             // action reaction: wait for actions to settle, then nod
      this._updateMotion(now, dt);             // wander↔idle state machine → position + bob/sway/jump
      this._updateFacing(THREE, now, dt);      // facing (lead travel / look at player), roll, twirl
      this._updateScan(THREE, now);            // periodic panel scan: angled beams
      this._updateRig(now, dt);                // equipped shell: petals breathe/open, rings counter-rotate, eye darts
      this._updateEyeGlow(THREE, now);         // always-on eye glow (breathing) + transmat burst
      holder.scale.setScalar(this._fit() * this._easeOut(this._scale) * this._gScale);
    }

    renderer.render(scene, camera);

    // fully asleep in 'wake' mode → halt the render loop entirely (≈0 CPU/GPU) until the
    // next mouse move resumes it. (We rendered one final empty frame above to clear the canvas.)
    if (this.mode === 'wake' && this._scaleTarget === 0 && this._scale <= 0.001) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  _easeOut(x) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3); }

  /** True while any movement/idle gesture or an action-reaction is in progress (one at a time). */
  _busy() { return this._jump || this._scan || this._tilt || this._shudder || this._float || this._perk || this._transmat || this._spin || this._speak || this._react; }

  /** Pick the next idle gesture: weighted, but NEVER the same type twice in a row (so it rotates
   *  evenly instead of clumping on one). Transmat is intentionally sparse. (Shudder is NOT here —
   *  it's a reaction to deleting a build, via reactDelete().) */
  _pickGesture() {
    const weights = { jump: 1, tilt: 1, look: 1, float: 0.9, perk: 0.9, spin: 0.8, speak: 0.7, transmat: 0.19 }; // transmat ≈ 1 in 30
    const pool = Object.keys(weights).filter((g) => g !== this._lastGesture);
    let total = 0; for (const g of pool) total += weights[g];
    let x = Math.random() * total;
    let pick = pool[pool.length - 1];
    for (const g of pool) { x -= weights[g]; if (x <= 0) { pick = g; break; } }
    this._lastGesture = pick;
    return pick;
  }

  /** Reaction state machine: while waiting, nod once the site action(s) have settled (no new
   *  acknowledge pings for ~500ms) — or after a safety timeout so it never gets stuck waiting. */
  _updateReactState(now) {
    const r = this._react;
    if (!r || r.phase !== 'wait') return;
    if (now - this._lastActionAt > 500 || now - r.start > 5000) {    // actions done (or give up waiting) → nod
      let v = Math.floor(Math.random() * 3);
      if (v === this._lastNodVariant) v = (v + 1) % 3;               // not the same nod twice in a row
      this._lastNodVariant = v;
      r.phase = 'nod'; r.nodStart = now; r.nodDur = [720, 1000, 1150][v]; r.variant = v;
    }
  }

  /** A short lean target toward the cursor (if recently moved) else a random nearby point, clamped on-screen. */
  _perkTarget() {
    const recent = performance.now() - this._lastMouse.t < 4000;
    let tx, ty;
    if (recent) { tx = this._lastMouse.x; ty = this._lastMouse.y; }
    else { const a = Math.random() * Math.PI * 2; tx = this._pos.x + Math.cos(a) * 130; ty = this._pos.y + Math.sin(a) * 130; }
    const lx = this._pos.x + (tx - this._pos.x) * 0.5, ly = this._pos.y + (ty - this._pos.y) * 0.5; // lean only part way
    return { x: Math.max(EDGE_MARGIN, Math.min(window.innerWidth - EDGE_MARGIN, lx)),
             y: Math.max(EDGE_MARGIN, Math.min(window.innerHeight - EDGE_MARGIN, ly)) };
  }

  /** A short teleport target for the transmat blink, clamped on-screen. */
  _blinkTarget() {
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 110;
    return { x: Math.max(EDGE_MARGIN, Math.min(window.innerWidth - EDGE_MARGIN, this._pos.x + Math.cos(a) * d)),
             y: Math.max(EDGE_MARGIN, Math.min(window.innerHeight - EDGE_MARGIN, this._pos.y + Math.sin(a) * d)) };
  }

  /**
   * Wander to a target leading with the eye; on arrival go IDLE (face the player, run quick
   * bob/sway + periodic jumps / 360° twirl-jumps / look-arounds) for a few seconds, then move on.
   * Sets holder.position; leaves this._vel, this._state, this._jump/_jumpP for the facing pass.
   */
  _updateMotion(now, dt) {
    const holder = this.three.holder;
    const w = window.innerWidth, h = window.innerHeight;

    if (this._state === 'wander') {
      if (!this._path) this._pickNewPath();
      const path = this._path;
      // travel at leg speed (px/s) along the curve; a mild ease only in the last stretch.
      const slow = 0.6 + 0.4 * Math.min(1, (1 - path.u) / 0.12);
      path.u += (this._legSpeed * slow * dt) / path.len;
      const uu = Math.min(1, path.u);
      const p = this._bezierAt(path.pts, uu);
      const tan = this._bezierTangent(path.pts, Math.min(0.999, uu));
      this._vel.x = tan.x * this._legSpeed; this._vel.y = tan.y * this._legSpeed; // direction → eye leads the curve
      this._pos.x = p.x; this._pos.y = p.y;
      if (path.u >= 1) {                                // arrived → idle
        this._state = 'idle';
        this._stateUntil = now + 2200 + Math.random() * 3200;
        this._nextGestureAt = now + 450 + Math.random() * 800;
        this._path = null; this._vel.x = 0; this._vel.y = 0;
      }
    } else {                                            // idle
      this._vel.x *= 0.85; this._vel.y *= 0.85;
      if (!this._busy() && now > this._nextGestureAt) {   // trigger a gesture
        // a panel scan is only possible when hovering a panel, and only at the configured rate
        // (scanRate per 15 idle gestures, default 1/15)
        const panel = this._panelRectAt(this._pos.x, this._pos.y);
        if (panel && Math.random() < this._scanRate / 15) {           // turn to the page and scan
          const ang = Math.random() * Math.PI * 2;                    // look in ANY direction (full 360°)
          this._scan = { start: now, dur: 2700, dirX: Math.cos(ang), dirY: Math.sin(ang) };
          this._lastGesture = 'scan';
          this._stateUntil = Math.max(this._stateUntil, now + 2700 + 400); // hold idle through the scan
        } else {
          const g = this._pickGesture();                              // weighted pick, never the same as last time
          let hold = 1100;                                            // how long to stay put for this gesture
          if (g === 'jump') this._jump = { start: now, dur: 820 + Math.random() * 280, height: 30 + Math.random() * 18, twirl: Math.random() < 0.35 };
          else if (g === 'tilt') this._tilt = { start: now, dur: 1700 + Math.random() * 500, amp: 0.42 + Math.random() * 0.16, cycles: 2 + Math.round(Math.random()) }; // head-tilt: roll back/forth 2-3x
          else if (g === 'look') this._lookBoost = now + 1600;        // a plain "look around" beat
          else if (g === 'float') { this._float = { start: now, dur: 3500 + Math.random() * 1800, anchorX: this._pos.x, anchorY: this._pos.y }; hold = this._float.dur + 400; } // long drift-in-place
          else if (g === 'perk') { const tgt = this._perkTarget(); this._perk = { start: now, dur: 1900 + Math.random() * 400, fromX: this._pos.x, fromY: this._pos.y, towardX: tgt.x, towardY: tgt.y }; hold = this._perk.dur + 300; } // curious lean-in
          else if (g === 'spin') { this._spin = { start: now, dur: 1300 + Math.random() * 500, dir: Math.random() < 0.5 ? 1 : -1, turns: 2 + Math.round(Math.random()) }; hold = this._spin.dur + 300; } // "processing" shell spin-up
          else if (g === 'speak') { this._speak = { start: now, dur: 1400 + Math.random() * 700 }; this._lookBoost = now + 1900; hold = this._speak.dur + 200; } // eye "transmit" flicker
          else if (g === 'transmat') { const b = this._blinkTarget(); this._transmat = { start: now, outMs: 320, goneMs: 3000 + Math.random() * 2000, inMs: 360, blinkX: b.x, blinkY: b.y, moved: false }; hold = this._transmat.outMs + this._transmat.goneMs + this._transmat.inMs + 400; } // transmat away 3-5s
          // (shudder is no longer an idle gesture — it's a reaction to deleting a build: reactDelete())
          this._stateUntil = Math.max(this._stateUntil, now + hold);  // don't wander off mid-gesture
        }
        this._nextGestureAt = now + 850 + Math.random() * 1600;
      }
      if (now > this._stateUntil && !this._busy()) {      // done idling → wander again (path built next frame)
        this._state = 'wander';
        this._path = null;
      }
    }

    // long "float" gesture: drift slowly within a small area for a few seconds (facing keeps
    // looking around). Offsets start at 0 so there's no pop when it begins.
    if (this._float) {
      const p = (now - this._float.start) / this._float.dur;
      if (p >= 1) this._float = null;
      else {
        const e = (now - this._float.start) / 1000;
        this._pos.x = this._float.anchorX + Math.sin(e * 0.5) * 26 + Math.sin(e * 0.31) * 14;
        this._pos.y = this._float.anchorY + Math.sin(e * 0.43) * 20 + Math.sin(e * 0.67) * 11;
        this._lookBoost = now + 300;                            // keep the wider look-around glances going
      }
    }

    // curious "perk-up": ease toward a point of interest, hold attentively, ease back
    if (this._perk) {
      const p = (now - this._perk.start) / this._perk.dur;
      if (p >= 1) this._perk = null;
      else {
        let k; if (p < 0.3) { k = p / 0.3; k = k * k * (3 - 2 * k); } else if (p < 0.7) k = 1; else { k = 1 - (p - 0.7) / 0.3; k = k * k * (3 - 2 * k); }
        this._pos.x = this._perk.fromX + (this._perk.towardX - this._perk.fromX) * k;
        this._pos.y = this._perk.fromY + (this._perk.towardY - this._perk.fromY) * k;
      }
    }

    // transmat: shrink out (gScale→0), stay GONE 3-5s, then grow back somewhere else
    this._gScale = 1;
    if (this._transmat) {
      const tm = this._transmat;
      const e = now - tm.start;
      const total = tm.outMs + tm.goneMs + tm.inMs;
      if (e >= total) this._transmat = null;
      else if (e < tm.outMs) this._gScale = 1 - e / tm.outMs;                 // shrink out
      else if (e < tm.outMs + tm.goneMs) {                                    // gone
        this._gScale = 0;
        if (!tm.moved && e >= tm.outMs + tm.goneMs * 0.5) { this._pos.x = tm.blinkX; this._pos.y = tm.blinkY; tm.moved = true; } // reposition unseen, mid-gone
      } else this._gScale = (e - tm.outMs - tm.goneMs) / tm.inMs;             // grow back
    }

    // jump arc (one-shot): up then back down; apex at p=0.5
    let jumpY = 0;
    if (this._jump) {
      const p = (now - this._jump.start) / this._jump.dur;
      if (p >= 1) { this._jump = null; this._jumpP = 0; }
      else { jumpY = Math.sin(Math.PI * p) * this._jump.height; this._jumpP = p; }
    }

    // quick (not blurry) bob + a touch of horizontal sway, always on
    const t = now / 1000 + this._wobbleSeed;
    const bob = Math.sin(t * 2.2) * 4.5;
    const swayX = Math.sin(t * 1.0) * 5;

    // gesture position offsets: head-tilt drifts slightly; shudder trembles
    let gx = 0, gy = 0;
    if (this._tilt) {
      const p = (now - this._tilt.start) / this._tilt.dur;
      if (p < 1) {
        const ph = p * this._tilt.cycles * Math.PI * 2;
        const env = Math.sin(Math.PI * p);                       // ramp in/out
        gx += Math.sin(ph) * 6 * env;                            // sway side-to-side with the tilt
        gy += Math.sin(ph * 2 + 0.7) * 4 * env;                  // slight up/down at the same time
      }
    }
    if (this._shudder) {
      const p = (now - this._shudder.start) / this._shudder.dur;
      if (p < 1) {
        const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.3); // quick attack, soft release
        const ts = now / 1000;
        gx += (Math.sin(ts * 38) + Math.sin(ts * 61 + 1.7)) * 3.4 * env; // erratic tremble (mixed freqs)
        gy += (Math.sin(ts * 47 + 0.6) + Math.sin(ts * 73 + 2.1)) * 3.0 * env;
      }
    }

    holder.position.set((this._pos.x + swayX + gx) - w / 2, h / 2 - (this._pos.y - bob - jumpY) + gy, 0);
  }

  /** Build the orientation: lead-toward-travel (wander) or look-at-player + glances (idle), a roll
   *  "rock", and a 360° roll around the eye axis during a twirl-jump (eye stays on the player). */
  _updateFacing(THREE, now, dt) {
    const holder = this.three.holder;
    // reuse cached scratch vectors/quaternions every frame (no per-frame allocation → no GC churn)
    const tmp = this._tmp || (this._tmp = {
      fwd: new THREE.Vector3(), face: new THREE.Vector3(), v1: new THREE.Vector3(), right: new THREE.Vector3(),
      qFace: new THREE.Quaternion(), qA: new THREE.Quaternion(), qB: new THREE.Quaternion(), target: new THREE.Quaternion(),
    });
    const fwd = tmp.fwd.set(this._fwd[0], this._fwd[1], this._fwd[2]).normalize();
    const t = now / 1000 + this._wobbleSeed;

    // desired facing (world). +Z = toward the camera/player (keeps the eye visible).
    const face = tmp.face.set(0, 0, 1);
    if (this._scan) {
      // turn to scan in this scan's chosen screen direction (any of 360°), but kept at an ANGLE
      // (a +Z lean toward the camera) so part of the eye stays visible.
      face.set(this._scan.dirX, this._scan.dirY, 0.58).normalize();
      const qScan = this._orient(THREE, this._fwd, this._up, face);
      const rollS = Math.sin(t * 1.1) * 0.06;
      holder.quaternion.slerp(tmp.target.setFromAxisAngle(face, rollS).multiply(qScan), Math.min(1, dt * 4.5));
      return;
    }
    if (this._react) {
      // action reaction: look directly at the user; nod once the action(s) settle (_updateReactState)
      face.set(0, 0, 1);
      const qFace = this._orient(THREE, this._fwd, this._up, face);
      const target = tmp.target.setFromAxisAngle(face, Math.sin(t * 1.3) * 0.05).multiply(qFace);
      if (this._react.phase === 'nod') {
        const p = (now - this._react.nodStart) / this._react.nodDur;
        if (p >= 1) { this._react = null; this._lastNodAt = now; }
        else {
          const e = Math.sin(Math.PI * p);
          const pitch = this._react.variant === 0 ? e * 0.36                                  // single firm
            : this._react.variant === 1 ? Math.abs(Math.sin(Math.PI * p * 2)) * e * 0.30      // double
            : e * 0.46;                                                                        // slow deep
          const right = tmp.right.set(0, 1, 0).cross(face);
          if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
          target.premultiply(tmp.qA.setFromAxisAngle(right, pitch));                          // pitch = nod
          if (this._react.variant === 2) target.premultiply(tmp.qB.setFromAxisAngle(face, e * 0.12));
        }
      }
      holder.quaternion.slerp(target, Math.min(1, dt * 9));        // graceful settle, then crisp nod
      return;
    }
    if (this._state === 'wander') {
      const vmag = Math.hypot(this._vel.x, this._vel.y);
      if (vmag > 6) face.addScaledVector(tmp.v1.set(this._vel.x / vmag, -this._vel.y / vmag, 0), 0.6); // lead travel
    } else {
      const a = (now < (this._lookBoost || 0)) ? 0.42 : 0.2;   // organic glances, wider during a look-around beat
      face.add(tmp.v1.set(
        Math.sin(t * 0.6) * a + Math.sin(t * 0.23 + 1.1) * a * 0.5,
        Math.sin(t * 0.5 + 1.7) * a * 0.8 + Math.sin(t * 0.31) * a * 0.4,
        0
      ));
    }
    if (this._perk) {                                           // lean-in: look toward the point of interest
      const tx = this._perk.towardX - window.innerWidth / 2 - holder.position.x;
      const ty = window.innerHeight / 2 - this._perk.towardY - holder.position.y;
      const tl = Math.hypot(tx, ty) || 1;
      face.set((tx / tl) * 0.8, (ty / tl) * 0.8, 0.7);          // override toward the target, eye still visible
    } else if (now - this._lastMouse.t < 1200) {               // glance at the cursor when it moves
      const cx = this._lastMouse.x - window.innerWidth / 2 - holder.position.x;
      const cy = window.innerHeight / 2 - this._lastMouse.y - holder.position.y;
      const cl = Math.hypot(cx, cy) || 1;
      face.addScaledVector(tmp.v1.set(cx / cl, cy / cl, 0), 0.4);
    }
    // shudder jitters the look direction erratically (the "spaz")
    if (this._shudder) {
      const p = (now - this._shudder.start) / this._shudder.dur;
      if (p < 1) {
        const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.3);
        const ts = now / 1000;
        face.x += (Math.sin(ts * 55 + 0.3) + Math.sin(ts * 84 + 1.2)) * 0.085 * env;
        face.y += (Math.sin(ts * 48 + 1.9) + Math.sin(ts * 71 + 0.4)) * 0.085 * env;
      }
    }
    face.normalize();
    const qFace = this._orient(THREE, this._fwd, this._up, face);

    // roll around the eye/face axis: gentle rock + twirl-jump (360°) + head-tilt (back/forth) + shudder
    // the gentle rock stands down while the shell is spinning around this same axis, so only one thing is
    // rotating the body at a time (the tilt/shudder below are gestures that can't co-occur with a spin)
    const bodySpin = !!(this._spin || (this._jump && this._jump.twirl));
    let roll = bodySpin ? 0 : Math.sin(t * 1.3) * 0.12;         // rock side-to-side
    let twirling = false, crisp = false;
    if (this._jump && this._jump.twirl) {
      const k = Math.min(1, Math.max(0, ((this._jumpP || 0) - 0.3) / (0.92 - 0.3)));
      const eased = k * k * (3 - 2 * k);                        // smoothstep ease in/out
      roll += eased * Math.PI * 2;                              // 360° around the eye
      twirling = k > 0 && k < 1;
    }
    if (this._tilt) {                                          // tilt the "head" L/R around the eye axis, 2-3x
      const p = (now - this._tilt.start) / this._tilt.dur;
      if (p >= 1) this._tilt = null;
      else { const ph = p * this._tilt.cycles * Math.PI * 2; roll += Math.sin(ph) * this._tilt.amp * Math.sin(Math.PI * p); crisp = true; }
    }
    if (this._shudder) {                                       // trembling roll jitter
      const p = (now - this._shudder.start) / this._shudder.dur;
      if (p >= 1) this._shudder = null;
      else {
        const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.3);
        const ts = now / 1000;
        roll += (Math.sin(ts * 42) + Math.sin(ts * 67 + 1.1)) * 0.085 * env;
        crisp = true;
      }
    }
    if (this._spin) {                                          // "processing": whole shell spins around the eye axis
      const p = (now - this._spin.start) / this._spin.dur;
      if (p >= 1) this._spin = null;
      else { const e = p * p * (3 - 2 * p); roll += this._spin.dir * e * this._spin.turns * Math.PI * 2; twirling = true; } // exact-set (monotonic)
    }
    const target = tmp.target.setFromAxisAngle(face, roll).multiply(qFace);

    if (twirling) holder.quaternion.copy(target);              // exact spin (no slerp drift)
    else holder.quaternion.slerp(target, Math.min(1, dt * (crisp ? 12 : 4.5))); // track tilt/shudder closely
  }

  // ---------- panel scan ----------
  /** The panel (.card) the ghost is currently hovering over, as a viewport rect — or null over dead space.
   *  Uses elementFromPoint; the overlay canvas is pointer-events:none, so it reports the page element behind. */
  _panelRectAt(sx, sy) {
    // DESKGHOST: the overlay covers the desktop, which has no panels to find — anywhere is fair game to scan
    const w = window.innerWidth, h = window.innerHeight;
    return { left: 0, top: 0, width: w, height: h, cx: w / 2, cy: h / 2 };
  }

  /** Build the (hidden) scan visuals once: a fan of additive beam lines from the eye. Additive + bright
   *  + thin, so they only ADD light onto the page — they never cover or darken content underneath. */
  _buildScanFx(THREE, scene) {
    const N = 13;
    const arr = new Float32Array(N * 6);                          // N line segments: eye → scan point
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const bmat = new THREE.LineBasicMaterial({ color: 0x9ad8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
    const beams = new THREE.LineSegments(geo, bmat);
    beams.frustumCulled = false; beams.visible = false;
    scene.add(beams);
    this.three.beams = beams; this.three.beamArr = arr; this.three.beamN = N;
  }

  /** Per-frame: drive the active scan (position the footprint over the panel, sweep the scan line,
   *  rake the beams down with it, fade in/out) or keep the FX hidden when not scanning. */
  _updateScan(THREE, now) {
    const t = this.three; if (!t.beams) return;
    if (!this._scan) { if (t.beams.visible) t.beams.visible = false; return; }
    const s = this._scan;
    const p = (now - s.start) / s.dur;
    if (p >= 1) { this._scan = null; t.beams.visible = false; return; }

    // visibility envelope: quick fade-in, hold, fade-out near the end
    const alpha = Math.min(Math.min(1, p / 0.10), Math.min(1, (1 - p) / 0.22)) * 0.7;

    // Where the EYE actually is + which way it looks (so beams come from the eye and go that way):
    // rotate the model-space FORWARD by the ghost's current orientation → world look direction.
    const look = (this._scanLook || (this._scanLook = new THREE.Vector3()))
      .set(this._fwd[0], this._fwd[1], this._fwd[2]).applyQuaternion(t.holder.quaternion);
    let dx = look.x, dy = look.y;                                // look direction projected onto the screen plane
    let dl = Math.hypot(dx, dy);
    if (dl < 1e-3) { dx = 0; dy = -1; dl = 1; }                  // eye pointing straight at camera → default downward
    dx /= dl; dy /= dl;
    const px = -dy, py = dx;                                     // perpendicular: the fan spreads across this

    const eyeR = this._sizePx * this._eyeOff;                   // eye offset from centre toward the look dir (per-model)
    const ex = t.holder.position.x + look.x * eyeR;
    const ey = t.holder.position.y + look.y * eyeR;

    // phased animation: (1) one thick beam extends to length, (2) it spreads into the individual
    // beams, (3) the fan gently breathes (beams drift closer/further apart) until the scan ends.
    const maxReach = this._sizePx * 1.5;
    const fullFan = this._sizePx * 1.6;                         // full fan spread (~160% of the ghost)
    const narrowFan = this._sizePx * 0.10;                     // bunched = reads as one thick beam (linewidth is ignored in WebGL)
    const EXTEND_END = 0.16, SPREAD_END = 0.34;

    let rt = Math.min(1, p / EXTEND_END); rt = rt * rt * (3 - 2 * rt);   // smoothstep
    const reach = maxReach * rt;                                // extend out to full length first

    let fanW;
    if (p < EXTEND_END) {
      fanW = narrowFan;                                         // (1) single thick line while it extends
    } else if (p < SPREAD_END) {
      let sp = (p - EXTEND_END) / (SPREAD_END - EXTEND_END); sp = sp * sp * (3 - 2 * sp);
      fanW = narrowFan + (fullFan - narrowFan) * sp;           // (2) spread into individual beams
    } else {
      fanW = fullFan * (1 + 0.16 * Math.sin(now / 1000 * 5.0)); // (3) breathe closer/further apart
    }

    const cxn = ex + dx * reach, cyn = ey + dy * reach;         // centre of the contact line
    const arr = t.beamArr, N = t.beamN;
    for (let i = 0; i < N; i++) {
      const off = ((i / (N - 1)) - 0.5) * fanW;
      const o = i * 6;
      arr[o] = ex; arr[o + 1] = ey; arr[o + 2] = 0;
      arr[o + 3] = cxn + px * off; arr[o + 4] = cyn + py * off; arr[o + 5] = 0;
    }
    t.beams.geometry.attributes.position.needsUpdate = true;
    t.beams.material.opacity = alpha;
    t.beams.visible = true;
  }

  // ---------- equipped-shell rig ----------
  /**
   * Drive the shell's rig (ghost-shell-source _buildRig): petals "breathe" slightly at idle and open up while
   * scanning / speaking / perking, the front + back petal rings drift and counter-rotate during the spin
   * gesture, a shudder rattles them, and the core (eye) makes small darting looks. Everything eases toward
   * its target; spins use the shortest angular path so a completed turn never unwinds. No-op for the GLB or
   * shells without separate parts.
   */
  _updateRig(now, dt) {
    const rig = this.three?.model?.userData?.rig;
    if (!rig) return;
    const ts = now / 1000, s = rig.state, seed = this._wobbleSeed;
    let spread = 0.05 + 0.035 * Math.sin(ts * 1.3 + seed);        // idle breathing
    // Ring motion (see RING_* above): both rings idle at their designed alignment and only depart from it in
    // bursts that return to 0. Front = occasional small back-and-forth. Back = the same but more often, plus a
    // rare full revolution. Both stand down while the whole body is spinning so the rotations never stack.
    const bodySpinning = !!(this._spin || (this._jump && this._jump.twirl));
    let front = 0, back = 0;
    if (!bodySpinning) {
      front = this._ringNudge(now, 'F', RING_FRONT_GAP);
      back = this._ringNudge(now, 'B', RING_BACK_GAP) + this._ringRevolution(now);
    }
    let rate = 5;

    if (this._scan) spread = 0.6;                                   // open up to scan
    if (this._perk) spread = Math.max(spread, 0.28);
    if (this._speak) spread = Math.max(spread, 0.16 + 0.12 * Math.abs(Math.sin(ts * 9)));
    if (this._spin) {
      // The shell itself is rolling around the eye axis in _updateFacing during this gesture, so the rings do
      // NOT also counter-rotate here — that stacked two spins on top of each other. The petals just fan open
      // and closed, which is what makes it read as "spinning up".
      const p = Math.min(1, (now - this._spin.start) / this._spin.dur);
      spread = Math.max(spread, 0.35 * Math.sin(Math.PI * p));
      rate = 16;
    }
    if (this._shudder) {
      const p = (now - this._shudder.start) / this._shudder.dur;
      if (p < 1) {
        const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.3);
        spread += env * 0.12 * Math.abs(Math.sin(ts * 47) + Math.sin(ts * 61));
        front += env * 0.08 * Math.sin(ts * 53); back += env * 0.08 * Math.sin(ts * 67);
        rate = 20;
      }
    }
    if (this._transmat) spread = 0;                                 // tuck in for the transmat

    // eye darts: pick a small new look target every 0.8-3s
    if (!this._coreLook || now > this._coreLook.next) {
      const big = Math.random() < 0.25;
      this._coreLook = { yaw: (Math.random() * 2 - 1) * (big ? 0.28 : 0.1), pitch: (Math.random() * 2 - 1) * (big ? 0.2 : 0.07), next: now + 800 + Math.random() * 2200 };
    }
    // glowing dyes breathe (in game the emissive parts of a shell pulse gently rather than sitting flat)
    const glow = this.three?.model?.userData?.glow;
    if (glow?.count) glow.set(1 + 0.12 * Math.sin(now / 1000 * 1.1 + this._wobbleSeed));
    const vfx = this.three?.model?.userData?.vfx;
    if (vfx?.count) vfx.set(now / 1000);
    // data-driven per-shell animation (the shell's own masks, not our rig)
    const ddAnim = this.three?.model?.userData?.ddAnim;
    if (ddAnim?.count) ddAnim.set(now / 1000);
    // sprite-card shells (Arena's duelling fighters): flip frames, hop, flash the clash spark
    const cards = this.three?.model?.userData?.cards;
    if (cards?.count) cards.set(now / 1000);
    const rotor = this.three?.model?.userData?.rotor;   // propellers just turn, constantly
    if (rotor?.count) rotor.set(now / 1000);

    // liquid-metal spikes (shells whose data carries the extend/retract signature, e.g. Speed Metal). Timing
    // measured frame-by-frame from in-game footage (30fps): a fixed 12s loop —
    //   0-3s modelled-long set OUT · 3-6s both retracted · 6-9s modelled-short set OUT · 9-12s both retracted,
    // each shooting out in ~0.1s (≈3 frames, slight overshoot) and snapping back in ~0.1s.
    if (rig.morph?.available) {
      if (this._morphT0 == null) this._morphT0 = now - Math.random() * SPIKE_CYCLE_MS;   // random phase per boot
      const t = (now - this._morphT0) % SPIKE_CYCLE_MS;
      rig.morph.set({ long: this._spikePulse(t, 0), short: this._spikePulse(t, SPIKE_CYCLE_MS / 2) });
    }

    const k = 1 - Math.exp(-dt * rate), kEye = 1 - Math.exp(-dt * 18);
    const wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
    rig.set({
      spread: s.spread + (spread - s.spread) * k,
      frontSpin: s.frontSpin + wrap(front - s.frontSpin) * k,
      backSpin: s.backSpin + wrap(back - s.backSpin) * k,
      coreYaw: s.coreYaw + (this._coreLook.yaw - s.coreYaw) * kEye,
      corePitch: s.corePitch + (this._coreLook.pitch - s.corePitch) * kEye,
    });
  }

  // ===================== rig inspector (admin "Ghost Rig" tab) =====================
  // The ghost parks dead-centre and holds whatever angle you drag it to. Nothing animates on its own here:
  // one-shot animations run when you play them, looping ones run while they are switched on. This is the only
  // place animations are isolated — everywhere else they all run together, as they're meant to.

  /** Animations the rig tab can play. one-shot = runs once; loop = runs until switched off. */
  static get RIG_ANIMS() {
    return [
      { id: 'jump', label: 'Jump', kind: 'once' },
      { id: 'twirl', label: 'Jump + 360° twirl', kind: 'once' },
      { id: 'spin', label: 'Processing spin (2-3 turns)', kind: 'once' },
      { id: 'tilt', label: 'Head tilt', kind: 'once' },
      { id: 'nudgeFront', label: 'Front ring nudge', kind: 'once' },
      { id: 'nudgeBack', label: 'Back ring nudge', kind: 'once' },
      { id: 'revBack', label: 'Back ring full revolution', kind: 'once' },
      { id: 'scan', label: 'Panel scan', kind: 'once' },
      { id: 'perk', label: 'Curious lean-in', kind: 'once' },
      { id: 'speak', label: 'Speak flicker', kind: 'once' },
      { id: 'shudder', label: 'Shudder', kind: 'once' },
      { id: 'blink', label: 'Blink', kind: 'once' },
      { id: 'spikes', label: 'Shell spikes (data-driven)', kind: 'loop' },
      { id: 'dd', label: 'Shell dd channels', kind: 'loop' },
      { id: 'vfx', label: 'Shell VFX scroll', kind: 'loop' },
      { id: 'glow', label: 'Shell emissive pulse', kind: 'loop' },
      { id: 'breathe', label: 'Petal breathing', kind: 'loop' },
      { id: 'eye', label: 'Eye darts', kind: 'loop' },
    ];
  }

  /** Drag anywhere on the page (outside the admin panel, so its buttons still work) to turn the ghost. */
  _enterRigDrag() {
    if (this._rigDragOn) return;
    this._rigDragOn = true;
    const inPanel = (e) => !!(e.target?.closest && e.target.closest('#admin-testing-panel'));
    this._onRigDown = (e) => { if (inPanel(e)) return; this._rigDrag = { x: e.clientX, y: e.clientY }; e.preventDefault(); };
    this._onRigMove = (e) => {
      if (!this._rigDrag) return;
      this.dragRig(e.clientX - this._rigDrag.x, e.clientY - this._rigDrag.y);
      this._rigDrag = { x: e.clientX, y: e.clientY };
      this.onRigChange?.();
    };
    this._onRigUp = () => { this._rigDrag = null; };
    window.addEventListener('mousedown', this._onRigDown);
    window.addEventListener('mousemove', this._onRigMove);
    window.addEventListener('mouseup', this._onRigUp);
  }
  _exitRigDrag() {
    if (!this._rigDragOn) return;
    this._rigDragOn = false; this._rigDrag = null;
    window.removeEventListener('mousedown', this._onRigDown);
    window.removeEventListener('mousemove', this._onRigMove);
    window.removeEventListener('mouseup', this._onRigUp);
  }

  getRigRotation() { return { yaw: this._rigYaw || 0, pitch: this._rigPitch || 0, roll: this._rigRoll || 0 }; }
  setRigRotation(yaw, pitch, roll) {
    this._rigYaw = yaw; this._rigPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    if (roll !== undefined) this._rigRoll = roll;
    return this.getRigRotation();
  }
  /** Drag deltas in pixels → rotation (about 0.6° per pixel). */
  dragRig(dx, dy) { return this.setRigRotation((this._rigYaw || 0) + dx * 0.01, (this._rigPitch || 0) + dy * 0.01); }
  resetRigRotation() { this._rigYaw = this._rigPitch = this._rigRoll = 0; return this.getRigRotation(); }

  /**
   * Which looping animations the CURRENTLY LOADED shell can actually show. Most shells carry no data-driven
   * buffer and no VFX layer at all, so those buttons would do nothing — the tab greys them out rather than
   * leaving you wondering whether it's broken.
   */
  getRigAvailability() {
    const ud = this.three?.model?.userData || {};
    return {
      spikes: !!ud.rig?.morph?.available,
      dd: !!ud.ddAnim?.count,
      vfx: !!ud.vfx?.count,
      glow: !!ud.glow?.count,
      eye: !!ud.eye?.count,
      breathe: !!ud.rig,
    };
  }

  getRigLoops() { return [...(this._rigLoops || (this._rigLoops = new Set()))]; }
  setRigLoop(id, on) {
    const s = this._rigLoops || (this._rigLoops = new Set());
    if (on) s.add(id); else s.delete(id);
    if (!on) this._rigRestOne(id);
    return this.getRigLoops();
  }
  /** Put one looping animation back to its neutral pose the moment it's switched off. */
  _rigRestOne(id) {
    const ud = this.three?.model?.userData;
    if (!ud) return;
    if (id === 'spikes' && ud.rig?.morph?.available) ud.rig.morph.set({ long: 0, short: 0 });
    if (id === 'dd' && ud.ddAnim?.count) ud.ddAnim.set(0);
    if (id === 'vfx' && ud.vfx?.count) ud.vfx.set(0);
    if (id === 'glow' && ud.glow?.count) ud.glow.set(1);
  }

  /** Play a one-shot animation right now (rig tab). */
  playRigAnim(id) {
    const now = performance.now();
    if (id === 'jump') this._jump = { start: now, dur: 900, height: 36, twirl: false };
    else if (id === 'twirl') this._jump = { start: now, dur: 1000, height: 36, twirl: true };
    else if (id === 'spin') this._spin = { start: now, dur: 1500, dir: 1, turns: 3 };
    else if (id === 'tilt') this._tilt = { start: now, dur: 1900, amp: 0.5, cycles: 2 };
    else if (id === 'scan') this._scan = { start: now, dur: 2700, dirX: 1, dirY: -0.3 };
    else if (id === 'perk') this._perk = { start: now, dur: 2000, fromX: 0, fromY: 0, towardX: 0, towardY: 0 };
    else if (id === 'speak') this._speak = { start: now, dur: 1600 };
    else if (id === 'shudder') this._shudder = { start: now, dur: 1400 };
    else if (id === 'blink') this._nextBlink = now;
    else if (id === 'nudgeFront') this._ringNudgeF = { start: now, dur: 1400, amp: 0.16, cycles: 1, dir: 1 };
    else if (id === 'nudgeBack') this._ringNudgeB = { start: now, dur: 1400, amp: 0.16, cycles: 1, dir: 1 };
    else if (id === 'revBack') this._ringRev = { at: now, dir: 1 };
    return id;
  }

  /** Rig-tab frame: hold the dragged angle, apply only what's playing, render. */
  _tickRig(THREE, renderer, scene, camera, holder, now, dt) {
    this._scale = 1;
    holder.visible = true;
    const loops = this._rigLoops || (this._rigLoops = new Set());

    // ---- orientation: base "facing you", then the angles you dragged to, then any playing roll
    const base = this._orient(THREE, this._fwd, this._up, new THREE.Vector3(0, 0, 1));
    const t = this._rigTmp || (this._rigTmp = { q: new THREE.Quaternion(), q2: new THREE.Quaternion(), v: new THREE.Vector3() });
    const q = t.q.copy(base);
    q.premultiply(t.q2.setFromAxisAngle(t.v.set(0, 1, 0), this._rigYaw || 0));
    q.premultiply(t.q2.setFromAxisAngle(t.v.set(1, 0, 0), this._rigPitch || 0));

    let roll = this._rigRoll || 0, jumpY = 0;
    if (this._jump) {                                        // jump: arc + optional 360° twirl
      const p = (now - this._jump.start) / this._jump.dur;
      if (p >= 1) this._jump = null;
      else {
        jumpY = Math.sin(Math.PI * p) * this._jump.height;
        if (this._jump.twirl) {
          const k = Math.min(1, Math.max(0, (p - 0.3) / (0.92 - 0.3)));
          roll += k * k * (3 - 2 * k) * Math.PI * 2;
        }
      }
    }
    if (this._spin) {
      const p = (now - this._spin.start) / this._spin.dur;
      if (p >= 1) this._spin = null;
      else roll += this._spin.dir * (p * p * (3 - 2 * p)) * this._spin.turns * Math.PI * 2;
    }
    if (this._tilt) {
      const p = (now - this._tilt.start) / this._tilt.dur;
      if (p >= 1) this._tilt = null;
      else roll += Math.sin(p * this._tilt.cycles * Math.PI * 2) * this._tilt.amp * Math.sin(Math.PI * p);
    }
    if (this._shudder) {
      const p = (now - this._shudder.start) / this._shudder.dur;
      if (p >= 1) this._shudder = null;
      else {
        const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.3), ts = now / 1000;
        roll += (Math.sin(ts * 42) + Math.sin(ts * 67 + 1.1)) * 0.085 * env;
      }
    }
    if (roll) q.multiply(t.q2.setFromAxisAngle(t.v.set(this._fwd[0], this._fwd[1], this._fwd[2]).normalize(), roll));
    holder.quaternion.copy(q);
    holder.position.set(0, jumpY, 0);
    holder.scale.setScalar(this._fit());

    // ---- rig pose: only what's playing or looping
    const rig = this.three?.model?.userData?.rig;
    if (rig) {
      const ts = now / 1000, s = rig.state;
      let spread = loops.has('breathe') ? 0.05 + 0.035 * Math.sin(ts * 1.3 + this._wobbleSeed) : 0.05;
      if (this._scan) { spread = 0.6; if (now - this._scan.start > this._scan.dur) this._scan = null; }
      if (this._perk) { spread = Math.max(spread, 0.28); if (now - this._perk.start > this._perk.dur) this._perk = null; }
      if (this._speak) { spread = Math.max(spread, 0.16 + 0.12 * Math.abs(Math.sin(ts * 9))); if (now - this._speak.start > this._speak.dur) this._speak = null; }
      if (this._spin) spread = Math.max(spread, 0.35);
      const front = this._ringNudge(now, 'F', RING_GAP_NEVER);
      const back = this._ringNudge(now, 'B', RING_GAP_NEVER) + this._ringRevolution(now, false);
      if (!loops.has('eye')) this._coreLook = { yaw: 0, pitch: 0, next: Infinity };
      else if (!this._coreLook || now > this._coreLook.next) {
        this._coreLook = { yaw: (Math.random() * 2 - 1) * 0.16, pitch: (Math.random() * 2 - 1) * 0.12, next: now + 900 + Math.random() * 1800 };
      }
      const k = 1 - Math.exp(-dt * 8), wrap = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
      rig.set({
        spread: s.spread + (spread - s.spread) * k,
        frontSpin: s.frontSpin + wrap(front - s.frontSpin) * k,
        backSpin: s.backSpin + wrap(back - s.backSpin) * k,
        coreYaw: s.coreYaw + (this._coreLook.yaw - s.coreYaw) * k,
        corePitch: s.corePitch + (this._coreLook.pitch - s.corePitch) * k,
      });
      if (rig.morph?.available) {
        if (!loops.has('spikes')) rig.morph.set({ long: 0, short: 0 });
        else {
          if (this._morphT0 == null) this._morphT0 = now;
          const tt = (now - this._morphT0) % SPIKE_CYCLE_MS;
          rig.morph.set({ long: this._spikePulse(tt, 0), short: this._spikePulse(tt, SPIKE_CYCLE_MS / 2) });
        }
      }
    }
    const ud = this.three?.model?.userData;
    if (ud?.glow?.count) ud.glow.set(loops.has('glow') ? 1 + 0.12 * Math.sin(now / 1000 * 1.1) : 1);
    if (ud?.vfx?.count) ud.vfx.set(loops.has('vfx') ? now / 1000 : 0);
    if (ud?.ddAnim?.count) ud.ddAnim.set(loops.has('dd') ? now / 1000 : 0);
    if (ud?.cards?.count) ud.cards.set(loops.has('dd') ? now / 1000 : 0);
    if (ud?.rotor?.count) ud.rotor.set(loops.has('dd') ? now / 1000 : 0);
    if (ud?.eye?.count) {
      let open = 1;
      if (this._nextBlink && now >= this._nextBlink) {
        const e = now - this._nextBlink, dur = 260;
        if (e >= dur) this._nextBlink = 0; else open = Math.abs(e / (dur / 2) - 1);
      }
      ud.eye.set({ open, intensity: 0.75 });
    }
    if (this.three.glow) this.three.glow.visible = false;    // hide the 2D glow sprite; we want the shell itself
    renderer.render(scene, camera);
  }

  /** A small back-and-forth nudge of one ring that both starts and ends exactly at the rest angle, with a pause
   *  before the next one. `gap` is the [min, max] ms between bursts. */
  _ringNudge(now, key, gap) {
    const k = '_ringNudge' + key;
    let w = this[k];
    if (!w) w = this[k] = { start: now + Math.random() * gap[1], dur: 1200, amp: 0, cycles: 1, dir: 1 };
    if (now >= w.start + w.dur) {                   // burst finished → schedule the next after a pause
      w.start = now + gap[0] + Math.random() * (gap[1] - gap[0]);
      w.dur = 1100 + Math.random() * 700;
      w.amp = 0.09 + Math.random() * 0.11;          // ~5-11°, a fidget rather than a turn
      w.cycles = 1 + Math.round(Math.random());     // one or two back-and-forths
      w.dir = Math.random() < 0.5 ? 1 : -1;
      return 0;
    }
    const p = (now - w.start) / w.dur;
    if (p < 0) return 0;                            // still waiting for this burst to begin
    // sin(cycles·2π·p) starts and ends at 0; the sin(π·p) envelope eases it in and out
    return w.dir * w.amp * Math.sin(p * w.cycles * Math.PI * 2) * Math.sin(Math.PI * p);
  }

  /** Once in a long while the BACK ring makes one full turn, landing back on its rest angle. */
  _ringRevolution(now, autoSchedule = true) {
    if (!this._ringRev && !autoSchedule) return 0;           // rig tab: only when explicitly played
    const r = this._ringRev || (this._ringRev = {
      at: now + RING_REV_GAP[0] + Math.random() * (RING_REV_GAP[1] - RING_REV_GAP[0]),
      dir: Math.random() < 0.5 ? 1 : -1,
    });
    const p = (now - r.at) / RING_REV_MS;
    if (p < 0) return 0;
    if (p >= 1) { this._ringRev = null; return 0; }  // exactly one turn → back to the rest angle
    const e = p * p * (3 - 2 * p);                   // smoothstep in/out
    return r.dir * e * Math.PI * 2;
  }

  /** One spike set's extension at cycle time t (ms) for a pulse starting at `start`: fast ease-out extend with a
   *  small overshoot, hold, fast ease-in retract; 0 outside the pulse. */
  _spikePulse(t, start) {
    const e = t - start;
    if (e < 0 || e >= SPIKE_OUT_MS) return 0;
    if (e < SPIKE_MOVE_MS) {
      const p = e / SPIKE_MOVE_MS, c = 1.2;                       // easeOutBack: ~5% overshoot
      return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
    }
    if (e > SPIKE_OUT_MS - SPIKE_MOVE_MS) {
      const p = (SPIKE_OUT_MS - e) / SPIKE_MOVE_MS;              // 1 → 0 across the retract
      return 1 - Math.pow(1 - p, 3);                               // slow start, snaps in at the end
    }
    return 1;
  }

  // ---------- eye glow ----------
  /** A soft radial-gradient sprite texture used for the eye glow + the transmat burst. */
  _makeGlowTexture(THREE) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.28, 'rgba(190,232,255,0.65)');
    grd.addColorStop(1, 'rgba(150,210,255,0)');
    x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
  }

  /** Build the always-on eye glow sprite + a (hidden) transmat burst sprite. Additive, 1 cheap draw each. */
  _buildEyeGlow(THREE, scene) {
    const tex = this._makeGlowTexture(THREE);
    const mk = () => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xbfe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })); s.frustumCulled = false; return s; };
    const glow = mk(); scene.add(glow);
    const burst = mk(); burst.visible = false; scene.add(burst);
    this.three.glow = glow; this.three.burst = burst; this.three.glowTex = tex;
  }

  /** Per-frame: park the glow sprite on the eye and modulate its brightness (always-on breathing +
   *  optional "speak" flicker), and flash the transmat burst during a blink. */
  _updateEyeGlow(THREE, now) {
    const t = this.three; if (!t.glow) return;
    const g = this._easeOut(this._scale) * this._gScale;        // fade/shrink the glow with the model
    const look = (this._eyeDir || (this._eyeDir = new THREE.Vector3()))
      .set(this._fwd[0], this._fwd[1], this._fwd[2]).applyQuaternion(t.holder.quaternion);
    const eyeR = this._sizePx * this._eyeOff * g;
    t.glow.position.set(t.holder.position.x + look.x * eyeR, t.holder.position.y + look.y * eyeR, look.z * eyeR + 1);

    const ts = now / 1000;
    let b = 0.55 + 0.12 * Math.sin(ts * 1.6 + this._wobbleSeed); // always-on breathing
    if (this._speak) {                                          // faster, voice-like flicker
      const p = (now - this._speak.start) / this._speak.dur;
      if (p >= 1) this._speak = null;
      else { const env = Math.sin(Math.PI * p); b += env * (0.30 + 0.26 * (Math.sin(ts * 26) + Math.sin(ts * 37 + 1.1))); }
    }
    b = Math.max(0.12, Math.min(1.3, b)) * g;
    t.glow.material.opacity = b * 0.5;
    t.glow.scale.setScalar(this._sizePx * (0.5 + 0.08 * b) * g);

    // equipped shell: drive the real iris (breathing / speak flicker brightness + an occasional blink wipe)
    const eye = t.model?.userData?.eye;
    if (eye?.count) {
      if (!this._nextBlink) this._nextBlink = now + 2500 + Math.random() * 5000;
      let open = 1;
      if (now >= this._nextBlink) {
        const e = now - this._nextBlink, dur = 260;            // close 0→130ms, reopen 130→260ms
        if (e >= dur) this._nextBlink = now + 3500 + Math.random() * 6500;
        else open = Math.abs(e / (dur / 2) - 1);
      }
      eye.set({ open: open * Math.min(1, g * 1.2), intensity: 0.36 + b * 0.72 });   // ≈0.75 at rest — matched to an in-game capture
    }

    if (t.burst) {                                             // transmat flash (at the vanish + the return)
      let flash = 0;
      if (this._transmat) {
        const tm = this._transmat, e = now - tm.start;
        const bumpAt = (c) => Math.max(0, 1 - Math.abs(e - c) / 170);
        flash = Math.max(bumpAt(tm.outMs), bumpAt(tm.outMs + tm.goneMs));
      }
      if (this._materializeAt) {                               // first-appear materialize (transmat "in")
        const e = now - this._materializeAt;
        flash = Math.max(flash, Math.max(0, 1 - Math.abs(e - 60) / 200)); // bloom as it grows in
        if (e > 420) this._materializeAt = 0;
      }
      if (flash > 0.001) {
        t.burst.visible = true;
        t.burst.position.set(t.holder.position.x, t.holder.position.y, 2);
        t.burst.material.opacity = flash * 0.85;
        t.burst.scale.setScalar(this._sizePx * (0.6 + 1.5 * (1 - flash))); // expands as it fades
      } else t.burst.visible = false;
    }
  }

  // ---------- calibrate mode ----------
  /** Parked screen position (px) — top-right, just under the menu buttons. */
  _calibPos() { return { x: window.innerWidth - this._sizePx * 0.7, y: this._sizePx * 0.7 + 60 }; }


  /** Orient so the configured FORWARD points straight at the camera (+Z) — no wobble/lean. */
  _faceCamera(THREE, dt) {
    const holder = this.three.holder;
    const target = this._orient(THREE, this._fwd, this._up, new THREE.Vector3(0, 0, 1));
    holder.quaternion.slerp(target, Math.min(1, dt * 6));
  }

  _enterCalibrate(THREE) {
    if (!this.three) return;
    if (!this._axes) { this._axes = new THREE.AxesHelper(0.7); this.three.holder.add(this._axes); } // R=+X G=+Y B=+Z
    window.addEventListener('keydown', this._onCalibKey);
    console.log('[ghost] calibrate mode — eye should face you; use the admin Ghost tab (or arrows + Q/E) to align FORWARD =', this._fwd.map((v) => v.toFixed(3)));
  }
  _exitCalibrate() {
    window.removeEventListener('keydown', this._onCalibKey);
    if (this._axes) { this._axes.parent?.remove(this._axes); this._axes.geometry?.dispose?.(); this._axes = null; }
  }
  _onCalibKey(e) {
    if (this.mode !== 'calibrate') return;
    if (e.key === ',' || e.key === '<') { e.preventDefault(); this.nudgeUpRoll(-0.06); return; } // roll up axis
    if (e.key === '.' || e.key === '>') { e.preventDefault(); this.nudgeUpRoll(0.06); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.resetForward(); return; }      // reset fwd + up
    const s = 0.06; const f = this._fwd.slice(); let used = true;
    switch (e.key) {
      case 'ArrowLeft': f[0] -= s; break;
      case 'ArrowRight': f[0] += s; break;
      case 'ArrowUp': f[1] += s; break;
      case 'ArrowDown': f[1] -= s; break;
      case 'q': case 'Q': f[2] -= s; break;
      case 'e': case 'E': f[2] += s; break;
      default: used = false;
    }
    if (!used) return;
    e.preventDefault();
    this.setForward(f[0], f[1], f[2]);
  }
}

export const ghostCompanion = new GhostCompanion();
export default ghostCompanion;
