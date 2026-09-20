/**
 * Ghost Shell Source — renders the user's EQUIPPED Ghost shell as the companion, with Destiny 2's
 * real gear dye shader (ported; verified offline against Bungie's screenshot of the shell).
 *
 * Pipeline:
 *   equipped Ghost itemHash (from the live profile)
 *     → Gear Asset DB (manifest's mobileGearAssetDataBases, a ZIP'd SQLite opened with sql.js)
 *     → DestinyGearAssetsDefinition row → { gear:[dye .js], content:[{ geometry[], textures[] }] }
 *     → each geometry .tgxm = TGXM container: vertex/index buffers + embedded render_metadata.js
 *     → render_metadata.texture_plates[0].plate_set = the shell's OWN diffuse/normal/gearstack/dyeslot
 *       (each placement's texture_tag_name is an inner file inside one of content.textures[] .tgxm.bin)
 *     → gear .js = default/locked dyes (Armor/Cloth/Suit × primary/secondary material properties)
 *     → THREE.Group with a MeshStandardMaterial patched (onBeforeCompile) into the D2 gear shader
 *
 * D2 gear shader (sources: Bungie spasm viewer, lowlines destiny-tgx-loader, Destiny-Collada-Generator
 * template.shader — research copy in tools/ghost-build/shader-research/):
 *   slot (1..6 = Armor/Cloth/Suit × Primary/Secondary) = per-vertex slot (normal.w low byte & 7, 0-based) + 1, overridden
 *     per texel by the dyeslot texture's thresholded RGB
 *   gearstack: R = AO, G = smoothness, B = alpha-test/emissive, A = dye mask + undyed metalness + wear mask
 *   albedo = Overlay(diffuse, lerp(worn tint, tint, wear), dyemask) → HardLight(detail diffuse)
 *
 * Drawn: stage 0 (opaque gbuffer) + the eye iris from stage 7 (additive decal, tinted by the Suit emissive dye)
 * with the eye lens as dark glass. Not yet: stage 1 decals, other stage-7 VFX (e.g. glowing wires).
 *
 * EVERYTHING is best-effort: any failure returns null (the companion then shows nothing and reports it).
 * Debug: localStorage.setItem('sot_ghost_shell_debug','1') then reload.
 *
 * DESKGHOST PORT (differences from sick-on-tuesday/js/ghost/ghost-shell-source.js — keep this list current
 * so the two can be diffed and re-synced):
 *   - the shell + shader come from the user's pick (setSelection), not the logged-in profile
 *   - gear asset entries + item definitions come from the local catalog (setCatalog), which the app builds
 *     from Bungie's public manifest on first run — no sql.js, no site API, no API key
 *   - every Bungie file goes through the app's `bungie` protocol, which serves it from the disk cache or
 *     downloads it from www.bungie.net once and caches it
 */

// http://bungie.localhost/<path> = the app's caching proxy for https://www.bungie.net/<path> (see src-tauri)
import { inGroup } from './shell-groups.js';

const BUNGIE_ROOT = 'http://bungie.localhost';
const GEOMETRY_CDN = BUNGIE_ROOT + '/common/destiny2_content/geometry/platform/mobile/geometry/';
const METADATA_CDN = BUNGIE_ROOT + '/common/destiny2_content/geometry/platform/mobile/render_metadata/';
const TEXTURE_CDN = BUNGIE_ROOT + '/common/destiny2_content/geometry/platform/mobile/textures/';
const GEAR_CDN = BUNGIE_ROOT + '/common/destiny2_content/geometry/gear/'; // the gear[] dye/material ".js" files
const GHOST_BUCKET = 4023194814;               // "Ghost" equipment bucket
const DEFAULT_SHADER_HASH = 4248210736;        // "Default Shader" plug = no shader applied
const EYE_WHITEN = 0.75;  // how far the iris core burns toward white (see _eyeMaterial)
const EMIT_GAMMA = 2.0;   // curve on the emissive mask — see SHELL_ALBEDO
const RENDER_ORDER = { body: 0, lens: 1, coat: 2, decal: 4, translucent: 6, glass: 7, vfx: 8, card: 9, eye: 10 };

// ---- flipbook sprite cards (Arena Shell's duelling Guardian and Rhulk) ----
// A data-driven stage-7 quad whose UVs cover only 1/N of its own texture is ONE FRAME of an N-frame strip; the
// game animates it by sliding the UVs. Timing measured frame-by-frame from in-game footage at 30fps:
// the strike pose holds 42 frames, the leap 18, looping every 60 — and the Guardian hops during the leap while
// the enemy stays put. See research/shell-fixes.md.
const CARD_CYCLE_MS = 2000;     // 60 frames @30fps
const CARD_ALT_MS = 600;        // 18 frames on the alternate frame (the leap); the rest sits on the base frame
const CARD_RISE_MS = 170;       // hop up ≈5 frames
const CARD_FALL_MS = 80;        // and back down ≈2-3 frames, just before the frame flips back
const CARD_HOP = 0.25;          // hop height as a fraction of the card's own height
const CARD_SPARK_MS = 300;      // the clash spark, fired when the base frame returns (≈9 frames)
const CARD_HOP_MIN_SHIFT = 0.04; // a card only hops if its alternate art is drawn this much higher in its cell
// Sprite art is faint line work (on Arena's Guardian only 57 of 4096 texels are brighter than half), so it has to
// be lifted the way the game's own shader does. Straight gain blows the more filled sprites (Rhulk) into a solid
// blob, so the lift compresses instead: faint lines climb a lot, bright areas approach 1 without clipping.
const CARD_GAIN = 1.6;
const CARD_KNEE = 0.12;         // lower = stronger lift of the faint line work
const CARD_FLOOR = 0.05;       // treat near-black as black: Rhulk's sprite has a value-5 border baked around it,
                                // and lifting that draws a box around him
// The fighters are holograms, and the parts bind two more textures for that: a banded "…gradient_a_height" that
// scrolls across them as rolling bright lines, and a soft "…verb_varied_gradient_dif" ramp. Plus the brightest
// line cores burn toward white in game rather than staying the dye's colour.
const CARD_STRIPE_AMT = 0.6;   // how much the rolling bands lift the figure where they cross it
const CARD_STRIPE_SCALE = 1.6;  // bands across the card's height
const CARD_STRIPE_SPEED = 0.22; // scrolls per second
const CARD_RAMP_AMT = 0;        // the soft ramp is black at the top, so shading the figure with it just eats the
                                // upper body — off until we know what the game actually uses it for
const CARD_HOT = 0.7;           // white-hot core on the brightest lines
// Propellers (see _rotorSpin). Fast enough to read as a spinning prop, slow enough that it doesn't strobe into
// looking stationary at the companion's frame-rate cap.
const ROTOR_RPS = 3.0;          // turns per second — fast, but just short of blurring the blades together
const CARD_SHARPEN = 2.2;       // unsharp strength when the sprite is rebuilt (see _renderSprite)
const CARD_UPSCALE = 4;         // the 64px mobile art is redrawn at this multiple
const CARD_BLOOM = 0.6;         // how much of the blurred copy is added back as glow
const FFLATE_URL = '../vendor/fflate.module.js';

// ---- TGXM container layout (VERIFIED against a real shell file) ----
// header: magic[4] + version(u32) + fileOffset(u32) + fileCount(u32) + identifier[256] = 272 bytes
// each entry: name[256] + offset(int64) + size(int64) = 272 bytes (no "type" field)
const TGXM_MAGIC = 'TGXM';
const TGXM_NAME_LEN = 0x100;                   // 256-byte file names
const TGXM_ENTRY_LEN = TGXM_NAME_LEN + 16;     // name + int64 offset + int64 size

// byte sizes of vertex element types — the layout's own "offset" fields overlap (wrong), so elements
// are packed sequentially in declaration order (verified: stride 32 = pos f32×4 + normal i16×4 + tangent i16×4)
const VFMT_SIZE = {
  _vertex_format_attribute_float4: 16, _vertex_format_attribute_float3: 12, _vertex_format_attribute_float2: 8,
  _vertex_format_attribute_float: 4, _vertex_format_attribute_short4: 8, _vertex_format_attribute_short2: 4,
  _vertex_format_attribute_ubyte4: 4, _vertex_format_attribute_byte4: 4,
};

// ghost eye decal textures (stage-7 iris parts): main iris shape (mainglow, or e.g. a heart on some shells),
// a soft bloom (iris_wipe) and an alpha-test gradient (atest) used to wipe the iris open/closed
const EYE_MAIN_RE = /eye_decal_(mainglow|heart)/;
// Bungie's VFX texture families: a stage-7 part naming one of these is an effect layer (energy, fire, smoke,
// wisps, sparks…), not a surface. Those parts carry the shell's look on VFX-heavy shells whose dyes are neutral.
const VFX_TEX_RE = /noise|warp|flow|fire|electric|energy|spark|smoke|plasma|cloud|nebula|godray|contrail|ember|wisp|ripple|twirl|pulse|gradient|glow|lightning|arc|voronoi|perlin|juicebox|wobble|fluid|star_wisp/i;
// An effect layer usually binds two textures: the thing you SEE (flames, embers, smoke, a plate of sparks) and a
// generic noise/warp/gradient used to distort or fade it. Sampling the modulator instead of the shape is why
// Blazing Conqueror's tendril flames were missing — it drew the swirl, not the fire.
const VFX_SHAPE_RE = /fire|flame|ember|spark|smoke|lightning|electric|_plate/i;
const VFX_GLOW_AMT = 0.5;       // how much of the soft under-glow shows beneath the effect's shape
const VFX_RISE = 0.06;          // upward drift of the shape per second (flames rise)
const VFX_STRENGTH = 0.75;      // effect brightness; at the old 0.28 the layers were barely visible at all
const EYE_DEFAULT_TINT = [0.35, 0.75, 1.0];   // used when the Suit emissive tint is plain white (no custom eye colour)

// debug on if window.GHOST_SHELL_DEBUG OR localStorage 'sot_ghost_shell_debug'='1' (the latter
// survives a reload, so it's on BEFORE the shell loads — set it, then refresh)
function shellDebug() {
  if (typeof window === 'undefined') return false;
  if (window.GHOST_SHELL_DEBUG) return true;
  try { return localStorage.getItem('sot_ghost_shell_debug') === '1'; } catch { return false; }
}
const dbg = (...a) => { if (shellDebug()) console.log('[ghost-shell]', ...a); };

function readAscii(dv, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    if (offset + i >= dv.byteLength) break;
    const c = dv.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ---- D2 gear dye shader (GLSL injected into MeshStandardMaterial) ----
const SHELL_VERTEX_PARS = `
attribute float dyeSlot;
varying float vDyeSlot;
varying vec2 vShellUv;
#ifdef SHELL_MORPH
attribute vec3 morphDir;
attribute float morphLen;
attribute float morphGroup;
attribute vec3 morphRetDir;
attribute float morphRetLen;
uniform vec4 shellMorphK;
#endif
#ifdef SHELL_ROTOR
attribute vec3 rotorHub;
attribute vec3 rotorAxis;
attribute float rotorDir;
uniform float shellRotorAngle;
#endif
#ifdef SHELL_DDANIM
// data-driven animation: one direction per vertex, per-channel amount + phase (see _ddAnim)
attribute vec3 ddDir;
attribute vec3 ddAmt;
attribute vec3 ddPhase;
uniform vec3 shellDdK;      // per-channel drive, 0..1
uniform vec3 shellDdSeq;    // 1 = travelling pulse around the ring, 0 = whole channel together
uniform vec3 shellDdHead;   // head of the travelling pulse, 0..1
// narrow bump so a ring lights one cluster at a time
float shellDdBump(float x) { float d = abs(fract(x + 0.5) - 0.5); return smoothstep(0.25, 0.0, d); }
float shellDdDrive(float k, float seq, float head, float ph) {
  return k * mix(1.0, shellDdBump(ph - head), seq);
}
#endif`;

const SHELL_FRAGMENT_PARS = `
uniform sampler2D shellDiffuse;
uniform sampler2D shellGearstack;
uniform sampler2D shellDyeslot;
uniform float shellHasDyeslot;
uniform float shellEmitGamma;
uniform sampler2D shellDetail0;
uniform sampler2D shellDetail1;
uniform sampler2D shellDetail2;
uniform sampler2D shellDetailNrm0;
uniform sampler2D shellDetailNrm1;
uniform sampler2D shellDetailNrm2;
uniform vec4 shellDetailNrmXform[3];
uniform float shellHasDetailNrm[3];
uniform vec4 shellDetailXform[3];
uniform float shellHasDetail[3];
uniform vec3 shellAlbedo[6];
uniform vec3 shellWornAlbedo[6];
uniform vec4 shellWearRemap[6];
uniform vec4 shellParams[6];
uniform vec4 shellWornParams[6];
uniform vec4 shellAdvParams[6];
uniform vec4 shellRoughRemap[6];
uniform vec4 shellWornRoughRemap[6];
uniform vec3 shellEmissive[6];
uniform float shellEmitGate[6];
uniform float shellGlowPulse;   // 1 = steady; the companion breathes this around 1 for glowing dyes
varying float vDyeSlot;
varying vec2 vShellUv;
float shellRemap(float v, vec4 r) { return clamp(v * r.y + r.x, r.z, r.z + r.w); }
vec3 shellOverlay(vec3 base, vec3 blend) { return blend * clamp(base * 4.0, 0.0, 1.0) + clamp(base - 0.25, 0.0, 1.0); }
vec3 shellHardLight(vec3 base, vec3 blend) { return base * clamp(blend * 4.0, 0.0, 1.0) + clamp(blend - 0.25, 0.0, 1.0); }`;

// replaces <map_fragment>: resolves the dye slot, then albedo / roughness / metalness / emissive / AO
const SHELL_ALBEDO = `
vec4 shellGs = texture2D(shellGearstack, vShellUv);
vec3 shellBase = pow(texture2D(shellDiffuse, vShellUv).rgb, vec3(2.2));
float shellSlot = floor(vDyeSlot + 0.5) + 1.0;   // vertex slot bits are 0-based (0 Armor primary … 5 Suit secondary)
if (shellHasDyeslot > 0.5) {
  vec4 dm = texture2D(shellDyeslot, vShellUv);
  if (dm.a > 0.5) {
    bool r = dm.r > 0.5; bool g = dm.g > 0.5; bool b = dm.b > 0.5;
    if (r && g && b) shellSlot = 6.0;
    else if (!r && b) shellSlot = 5.0;
    else if (r && g && !b) shellSlot = 4.0;
    else if (!r && g && !b) shellSlot = 3.0;
    else if (r && !g) shellSlot = 2.0;
    else if (r || g) shellSlot = 1.0;
  }
}
int si = int(clamp(shellSlot, 1.0, 6.0)) - 1;
int di = si / 2;
vec4 shellDx = shellDetailXform[di];
vec2 shellDuv = vShellUv * shellDx.xy + shellDx.zw;
vec4 shellD0 = texture2D(shellDetail0, shellDuv);
vec4 shellD1 = texture2D(shellDetail1, shellDuv);
vec4 shellD2 = texture2D(shellDetail2, shellDuv);
vec4 shellDetail = di == 0 ? shellD0 : (di == 1 ? shellD1 : shellD2);
float shellHasDet = shellHasDetail[di];
vec4 shellDnx = shellDetailNrmXform[di];
vec2 shellDetNrmUv = vShellUv * shellDnx.xy + shellDnx.zw;

float dyemask = step(40.0 / 255.0, shellGs.a);
float wearmask = clamp((shellGs.a - 48.0 / 255.0) * 1.23188405797, 0.0, 1.0);
float undyedMetal = clamp(shellGs.a * 7.96875, 0.0, 1.0);
float emitAmount = clamp((shellGs.b - 40.0 / 255.0) * 1.18604651163, 0.0, 1.0);
// The gearstack B channel is bimodal: genuinely glowing parts sit near 1.0, while large areas of ordinary
// surface sit in a mid band (~0.3 on Visionary) that the linear formula turns into a fifth of full emissive —
// enough to wash whole panels in the dye's tint. Curving the mask keeps real glows intact (0.94 -> 0.86) while
// dropping that band to nothing (0.17 -> 0.01). A flat scale can't do both: it dims the real glows too.
emitAmount = pow(emitAmount, shellEmitGamma);
float mw = shellRemap(wearmask, shellWearRemap[si]);
vec3 dyeColor = mix(shellWornAlbedo[si], shellAlbedo[si], mw);
vec4 dyeParams = mix(shellWornParams[si], shellParams[si], mw);   // x detail diffuse blend, y normal, z roughness, w metalness

float shellDetNrmAmt = dyemask * dyeParams.y * shellHasDetailNrm[di];
vec3 shellCol = mix(shellBase, shellOverlay(shellBase, dyeColor), dyemask);
vec3 detailLin = pow(shellDetail.rgb, vec3(2.2));
shellCol = mix(shellCol, shellHardLight(shellCol, detailLin), dyemask * dyeParams.x * shellHasDet);
diffuseColor.rgb = shellCol;

float smooth0 = shellGs.g;
float detailSmooth = mix(smooth0, shellDetail.a * clamp(smooth0 * 4.0, 0.0, 1.0) + clamp(smooth0 - 0.25, 0.0, 1.0), dyemask * shellHasDet);
float detailedRough = mix(smooth0, detailSmooth, dyeParams.z);
// the *_roughness_remap output IS roughness (e.g. gold ring remap → ~0.3 glossy, cloth sphere → ~1 matte, as in-game);
// only undyed texels use the gearstack smoothness directly. (The Unity port inverts both — wrong for these assets.)
float dyeRough = mix(shellRemap(detailedRough, shellWornRoughRemap[si]), shellRemap(detailedRough, shellRoughRemap[si]), mw);
float shellRoughness = mix(1.0 - smooth0, dyeRough, dyemask);
float shellMetalness = mix(undyedMetal, dyeParams.w, dyemask);
vec3 shellEmit = shellEmissive[si] * emitAmount * mix(1.0, shellGlowPulse, shellEmitGate[si]);
float shellAO = shellGs.r;
#ifdef SHELL_TRANSLUCENT
// translucent (stage-7) layer: glow = the slot's emissive dye tint, brightest where the plate diffuse is bright;
// opacity follows the diffuse too, so dark areas read as clear glass and bright areas as a lit surface
float shellLum = dot(shellBase, vec3(0.2126, 0.7152, 0.0722));
// only a TINTED emissive dye is a real glow; a neutral/white tint is the placeholder and would blow the piece
// out to white (Lunar's moon), so gate the glow on that tint's saturation
shellEmit += shellEmissive[si] * shellBase * (0.15 + 2.0 * shellEmitGate[si]);
diffuseColor.a = clamp(0.45 + 1.2 * shellLum, 0.45, 0.95);
#endif
#ifdef SHELL_COAT
shellRoughness = min(shellRoughness, 0.22);
#endif
#ifdef SHELL_GLASS
// canopy: the plate art underneath is not the glass's own colour — keep a trace of it, drop the
// glow entirely, and make it smooth so the environment reflection and the edge sheen carry the look
shellCol *= 0.12;
diffuseColor.rgb = shellCol;
shellEmit = vec3(0.0);
shellRoughness = min(shellRoughness, 0.06);
shellMetalness = 0.0;
#endif`;

// normal map: Destiny stores tangent-space XY (DirectX green) — rebuild Z instead of trusting B
const SHELL_NORMAL = `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec2 shellN = texture2D(normalMap, vNormalMapUv).xy * 2.0 - 1.0;
  // detail normal (carbon fibre / speckle / brushing) layered on top, strength from the dye's normal blend
  vec3 dn0 = texture2D(shellDetailNrm0, shellDetNrmUv).xyz;
  vec3 dn1 = texture2D(shellDetailNrm1, shellDetNrmUv).xyz;
  vec3 dn2 = texture2D(shellDetailNrm2, shellDetNrmUv).xyz;
  vec3 dn = di == 0 ? dn0 : (di == 1 ? dn1 : dn2);
  shellN += (dn.xy * 2.0 - 1.0) * shellDetNrmAmt;
  vec3 mapN = vec3(shellN, 0.0);
  mapN.xy *= normalScale;
  mapN.z = sqrt(clamp(1.0 - dot(mapN.xy, mapN.xy), 0.0, 1.0));
  normal = normalize(tbn * mapN);
#endif`;

class GhostShellSource {
  constructor() {
    this._shellCache = new Map();   // itemHash:shaderHash → { meshes, dyes, images: Map<name, {w,h,data}> }
    this._catalog = null;           // { items: { [hash]: { kind, name, icon, translationBlock, gear } } } — see setCatalog
    this._selection = null;         // { itemHash, shaderHash|null } — the user's pick
  }

  /** DESKGHOST: the local item catalog built by the app from Bungie's public manifest (src-tauri/src/catalog.rs). */
  setCatalog(catalog) { this._catalog = catalog || null; }

  /** DESKGHOST: the shell (+ optional shader) the user picked. */
  setSelection(itemHash, shaderHash = null) {
    this._selection = itemHash ? { itemHash: itemHash >>> 0, shaderHash: shaderHash ? shaderHash >>> 0 : null } : null;
  }

  getEquippedGhostHash() {
    return this.getEquippedGhost()?.itemHash ?? null;
  }

  /** DESKGHOST: the picked shell → { itemHash, itemInstanceId: null, shaderHash|null } (the site reads the live profile). */
  getEquippedGhost() {
    const s = this._selection;
    if (!s) return null;
    const shaderHash = s.shaderHash && s.shaderHash !== DEFAULT_SHADER_HASH ? s.shaderHash : null;
    return { itemHash: s.itemHash, itemInstanceId: null, shaderHash };
  }

  /** DESKGHOST: the catalog's copy of an item definition (display properties + translationBlock), or null. */
  async _fetchItemDef(hash) {
    const it = this._catalog?.items?.[hash >>> 0];
    if (!it) { dbg('item not in catalog', hash); return null; }
    return { hash: hash >>> 0, displayProperties: { name: it.name, icon: it.icon }, translationBlock: it.translationBlock || null };
  }

  /**
   * Resolve the dyes per slot the way Bungie's viewer does (spasm getResolvedDyeList): the shell's default dyes,
   * overridden per DYE CHANNEL by the applied shader's custom dyes, then the shell's locked dyes.
   *   shell translationBlock.defaultDyes: dyeHash (= gear dye investment_hash) → channelHash
   *   shader translationBlock.customDyes: channelHash → dyeHash
   *   shader gear json custom_dyes/default_dyes: investment_hash → the dye (material properties + detail textures)
   * → { dyes: [slot]→dye, shaderContent: the shader's gear content (its texture containers) or null }
   */
  async _resolveDyes(shellHash, shellGear, shaderHash) {
    const dyes = [];
    for (const d of (shellGear?.default_dyes || [])) if (typeof d?.slot_type_index === 'number') dyes[d.slot_type_index] = d;
    let shaderContent = null;
    if (shaderHash) {
      try {
        const [shellDef, shaderDef, shaderEntry] = await Promise.all([this._fetchItemDef(shellHash), this._fetchItemDef(shaderHash), this._getGearEntry(shaderHash)]);
        const shaderGear = shaderEntry?.gear?.[0] ? await this._fetchMetadata(shaderEntry.gear[0]) : null;
        const chanOf = new Map((shellDef?.translationBlock?.defaultDyes || []).map((d) => [d.dyeHash >>> 0, d.channelHash >>> 0]));
        const dyeFor = new Map((shaderDef?.translationBlock?.customDyes || []).map((d) => [d.channelHash >>> 0, d.dyeHash >>> 0]));
        const pool = new Map();
        for (const list of [shaderGear?.default_dyes, shaderGear?.custom_dyes]) for (const d of (list || [])) pool.set(d.investment_hash >>> 0, d);
        let applied = 0;
        for (const d of (shellGear?.default_dyes || [])) {
          const channel = chanOf.get(d.investment_hash >>> 0);
          const sd = channel != null ? pool.get(dyeFor.get(channel)) : null;
          if (sd) { dyes[d.slot_type_index] = { ...sd, slot_type_index: d.slot_type_index }; applied++; }
        }
        if (applied) shaderContent = (shaderEntry.content || []).find((c) => Array.isArray(c.textures) && c.textures.length) || null;
        dbg('shader', shaderHash, 'dyes applied', applied, 'of', (shellGear?.default_dyes || []).length);
      } catch (e) { dbg('shader dye resolve failed', shaderHash, e?.message || e); }
    }
    for (const d of (shellGear?.locked_dyes || [])) if (typeof d?.slot_type_index === 'number') dyes[d.slot_type_index] = d;
    return { dyes, shaderContent };
  }

  /** DESKGHOST: gear asset definition (geometry/texture file lists + dyes) for an item hash, from the catalog. */
  async _getGearEntry(hash) {
    return this._catalog?.items?.[hash >>> 0]?.gear || null;
  }

  async _fetchGeometry(fileName) {
    const res = await fetch(GEOMETRY_CDN + fileName);
    if (!res.ok) throw new Error('geometry HTTP ' + res.status + ' for ' + fileName);
    return await res.arrayBuffer();
  }

  async _fetchTexture(fileName) {
    const res = await fetch(TEXTURE_CDN + fileName);
    if (!res.ok) throw new Error('texture HTTP ' + res.status + ' for ' + fileName);
    return await res.arrayBuffer();
  }

  /**
   * Fetch the texture containers and decode every inner image whose name is in `needed`
   * → Map<innerName, {w, h, data: Uint8Array RGBA}>. Inner files are PNG (lossless, may carry alpha) or
   * JPEG (opaque body diffuse). Raw RGBA is kept (not ImageBitmap/canvas) because plates must be stitched
   * and canvas premultiplies alpha — the gearstack keeps real data in RGB where alpha is 0.
   */
  async _loadTextures(contents, needed) {
    const out = new Map();
    const files = [...new Set([].concat(...(Array.isArray(contents) ? contents : [contents]).map((c) => (Array.isArray(c?.textures) ? c.textures : []))))];
    if (!files.length || !needed.size) return out;
    const { unzlibSync } = await import(FFLATE_URL);
    await Promise.all(files.map(async (file) => {
      try {
        if (out.size >= needed.size) return;               // everything already found (e.g. in the shell's own containers)
        const tgxm = this._parseTGXM(await this._fetchTexture(file));
        if (!tgxm) return;
        for (const innerName in tgxm.files) {
          if (!needed.has(innerName) || out.has(innerName)) continue;
          const dvb = this._bufferBytes(tgxm, innerName);
          const img = await this._decodeImage(new Uint8Array(dvb.buffer, dvb.byteOffset, dvb.byteLength), unzlibSync);
          if (!img) { dbg('texture decode failed', innerName); continue; }
          out.set(innerName, img);
          dbg('texture loaded', innerName, img.w + 'x' + img.h);
        }
      } catch (e) { dbg('texture container failed', file, e?.message || e); }
    }));
    const missing = [...needed].filter((n) => !out.has(n));
    if (missing.length) dbg('textures not found', missing);
    return out;
  }

  /** PNG → own decoder (exact, non-premultiplied); JPEG / unusual PNGs → browser decode via canvas. */
  async _decodeImage(u8, unzlibSync) {
    if (u8[0] === 0x89 && u8[1] === 0x50) {
      try { const img = this._decodePng(u8, unzlibSync); if (img) return img; } catch (e) { dbg('png decode error', e?.message || e); }
    }
    const type = (u8[0] === 0xff && u8[1] === 0xd8) ? 'image/jpeg' : (u8[0] === 0x89 ? 'image/png' : null);
    if (!type) return null;
    const bmp = await createImageBitmap(new Blob([u8], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const data = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
    return { w: canvas.width, h: canvas.height, data };
  }

  /** Minimal PNG decoder: 8-bit, non-interlaced, grey / grey+alpha / RGB / RGBA → RGBA. null = unsupported. */
  _decodePng(u8, unzlibSync) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0;
    const idat = [];
    while (p + 8 <= u8.length) {
      const len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      const body = u8.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u8[p + 16]; ct = u8[p + 17]; interlace = u8[p + 20]; }
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
    if (depth !== 8 || interlace !== 0 || !bpp || !w || !h) return null;
    let total = 0; for (const c of idat) total += c.length;
    const z = new Uint8Array(total); let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
    const raw = unzlibSync(z);
    const stride = w * bpp, px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[prev + x] : 0, c = (x >= bpp && y) ? px[prev + x - bpp] : 0;
        let v = raw[src + x];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
        px[row + x] = v;
      }
    }
    if (bpp === 4) return { w, h, data: px };
    const data = new Uint8Array(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
      if (bpp === 3) { data[i * 4] = px[j]; data[i * 4 + 1] = px[j + 1]; data[i * 4 + 2] = px[j + 2]; data[i * 4 + 3] = 255; }
      else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[j]; data[i * 4 + 3] = bpp === 2 ? px[j + 1] : 255; }
    }
    return { w, h, data };
  }

  /**
   * Stitch one texture plate (atlas) from its placements → {w, h, data}. Plates can hold several textures
   * (e.g. Hardlink's diffuse = a 480² Warmind texture at 0,0 + a 32² Omolon texture at 480,0 on a 512² plate).
   * The dyeslot plate is stored at quarter resolution (its placement coords are already in that space).
   */
  _stitchPlate(key, plate, images) {
    const quarter = key === 'dyeslot';
    const pw = Math.max(1, (plate.plate_size?.[0] || 0) >> (quarter ? 2 : 0));
    const ph = Math.max(1, (plate.plate_size?.[1] || 0) >> (quarter ? 2 : 0));
    const placements = plate.texture_placements || [];
    // a single texture filling the plate needs no copy
    if (placements.length === 1) {
      const img = images.get(placements[0].texture_tag_name);
      const pl = placements[0];
      if (img && !pl.position_x && !pl.position_y && img.w === pw && img.h === ph) return img;
    }
    const data = new Uint8Array(pw * ph * 4);
    let placed = 0;
    for (const pl of placements) {
      const img = images.get(pl.texture_tag_name);
      if (!img) continue;
      const sw = pl.texture_size_x || img.w, sh = pl.texture_size_y || img.h;
      for (let y = 0; y < sh; y++) {
        const ty = pl.position_y + y; if (ty < 0 || ty >= ph) continue;
        const iy = Math.min(img.h - 1, Math.floor(y * img.h / sh));
        for (let x = 0; x < sw; x++) {
          const tx = pl.position_x + x; if (tx < 0 || tx >= pw) continue;
          const ix = Math.min(img.w - 1, Math.floor(x * img.w / sw));
          const s = (iy * img.w + ix) * 4, d = (ty * pw + tx) * 4;
          data[d] = img.data[s]; data[d + 1] = img.data[s + 1]; data[d + 2] = img.data[s + 2]; data[d + 3] = img.data[s + 3];
        }
      }
      placed++;
    }
    return placed ? { w: pw, h: ph, data } : null;
  }

  /** The dye/material JSON (the gear[] ".js" file). gear/ is the verified CDN path; the others are fallbacks. */
  async _fetchMetadata(file) {
    const candidates = [GEAR_CDN + file, GEOMETRY_CDN + file, METADATA_CDN + file];
    for (const url of candidates) {
      try {
        const res = await fetch(url);
        dbg('gear json try', res.status, url);
        if (!res.ok) continue;
        let json = null;
        try { json = await res.json(); } catch { json = null; }
        if (json) return json;
      } catch (e) { dbg('gear json fetch error', url, e?.message || e); }
    }
    dbg('gear json: no candidate path worked for', file);
    return null;
  }


  /** Parse a TGXM container → { dv, files: {name:{offset,size}} }. */
  _parseTGXM(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 16 || readAscii(dv, 0, 4) !== TGXM_MAGIC) { dbg('TGXM magic mismatch'); return null; }
    const fileOffset = dv.getUint32(8, true);
    const fileCount = dv.getUint32(12, true);
    if (fileCount > 4096 || fileOffset + fileCount * TGXM_ENTRY_LEN > dv.byteLength) { dbg('TGXM table out of range'); return null; }

    const files = {};
    let p = fileOffset;
    for (let i = 0; i < fileCount; i++) {
      const name = readAscii(dv, p, TGXM_NAME_LEN);
      const offset = dv.getUint32(p + TGXM_NAME_LEN, true);       // int64 offset — low 32 bits (fits)
      const size = dv.getUint32(p + TGXM_NAME_LEN + 8, true);     // int64 size — low 32 bits
      p += TGXM_ENTRY_LEN;
      if (name) files[name] = { offset, size };
    }
    return { dv, files };
  }

  /** Decode a buffer's bytes as UTF-8 text (for the embedded render_metadata.js). */
  _bufferText(dv) {
    return new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  }

  /** Raw bytes for a named buffer file inside the TGXM. */
  _bufferBytes(tgxm, name) {
    const f = tgxm.files[name];
    if (!f) return null;
    return new DataView(tgxm.dv.buffer, tgxm.dv.byteOffset + f.offset, f.size);
  }

  /** The body texture plates from render_metadata.texture_plates → { diffuse, normal, gearstack, dyeslot } plate defs. */
  _plateDefs(metadata) {
    const set = metadata?.texture_plates?.[0]?.plate_set;
    if (!set) return null;
    const out = {};
    for (const key of ['diffuse', 'normal', 'gearstack', 'dyeslot']) {
      if (set[key]?.texture_placements?.length) out[key] = set[key];
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Decode render meshes → [{ positions, normals, uvs, slots, indices }].
   * Only render STAGE 0 (opaque gbuffer; parts are listed once per stage via stage_part_offsets) at LOD 0
   * (lod_category values 0..3 = _0, _01, _012, _0123). Indices are triangle strips (0xFFFF restart).
   */
  _decodeMeshes(metadata) {
    const meshes = metadata?.render_model?.render_meshes;
    if (!Array.isArray(meshes)) { dbg('no render_meshes in metadata'); return []; }
    const out = [];

    for (let m = 0; m < meshes.length; m++) {
      try {
        const mesh = meshes[m];
        const allParts = mesh.stage_part_list || [];
        const offs = mesh.stage_part_offsets;
        const hasStages = Array.isArray(offs) && offs.length > 8;
        const lodOf = (pt) => (typeof pt.lod_category === 'object' ? pt.lod_category.value : (pt.lod_category ?? 0));
        const stage = (s) => (hasStages ? allParts.slice(offs[s], offs[s + 1]) : (s === 0 ? allParts : [])).filter((pt) => lodOf(pt) <= 3);
        const parts = stage(0);
        // the eye iris: render stage 7 (transparents), shader type 8 with the ghost eye decal textures
        const isEye = (pt) => (pt.shader?.static_textures || []).some((n) => EYE_MAIN_RE.test(n));
        const eyeParts = stage(7).filter(isEye);
        // Other render-stage-7 (transparents) parts split by the data-driven bit (0x2000), which matches what the
        // pieces actually are in game:
        //   set    → solid glowing VFX bodies (IX's tendrils, Lunar's moon, Inferno's flames) → lit, emissive layer
        //   clear  → glass / clear-coat canopies (Clean Lines' dome, Lampion's shade) → faint, reflective glass
        // (a few of these turn out to be sprite cards rather than solid bodies — split below, once UVs are decoded)
        const dataDrivenParts = stage(7).filter((pt) => !isEye(pt) && (pt.flags & 0x2000));
        // ...and among those, a part that names a clear-coat / cubemap texture is a lacquered SOLID surface
        // (Lampion's lantern), not a pane you can see through — it stays opaque, just glossier.
        const isCoat = (pt) => (pt.shader?.static_textures || []).some((n) => /clear_coat|cubemap/i.test(n));
        const isVfx = (pt) => (pt.shader?.static_textures || []).some((n) => VFX_TEX_RE.test(n));
        const glassParts = stage(7).filter((pt) => !isEye(pt) && !(pt.flags & 0x2000) && !isCoat(pt) && !isVfx(pt));
        const coatParts = stage(7).filter((pt) => !isEye(pt) && !(pt.flags & 0x2000) && isCoat(pt) && !isVfx(pt));
        // effect layers are the NON data-driven VFX parts; a data-driven part is a solid body of the shell
        // (Lunar's moon, IX's tendrils) that happens to use a noise texture, and must stay shaded, not additive
        const vfxParts = stage(7).filter((pt) => !isEye(pt) && isVfx(pt) && !(pt.flags & 0x2000));
        // render-stage-1 decals: parts that sample a static decal texture atlas
        const decalParts = stage(1).filter((pt) => (pt.shader?.static_textures || []).length);
        if (!parts.length && !eyeParts.length && !dataDrivenParts.length && !decalParts.length) continue;

        const buffers = mesh._buffers;
        const idxBuf = buffers[mesh.index_buffer?.file_name];
        if (!idxBuf) { dbg('mesh', m, 'no index buffer'); continue; }
        const idxStride = mesh.index_buffer.value_byte_size || 2;
        const totalIdx = Math.floor(idxBuf.byteLength / idxStride);
        const readIndex = (i) => (idxStride === 2 ? idxBuf.getUint16(i * 2, true) : idxBuf.getUint32(i * 4, true));

        // locate elements; offsets packed sequentially per stream (the metadata offsets are unreliable)
        const vbufs = (mesh.vertex_buffers || []).map((vb) => ({ dv: buffers[vb.file_name], stride: vb.stride_byte_size }));
        const formats = mesh.stage_part_vertex_stream_layout_definitions?.[0]?.formats || [];
        const el = {};
        formats.forEach((fmt, s) => {
          let off = 0;
          const packed = (fmt.elements || []).reduce((sum, e) => sum + (VFMT_SIZE[e.type] || e.size || 0), 0) === fmt.stride;
          for (const e of (fmt.elements || [])) {
            const key = e.semantic.replace('_tfx_vb_semantic_', '') + (e.semantic_index || '');
            if (!el[key]) el[key] = { s, type: e.type, offset: packed ? off : (e.offset || 0), normalized: e.normalized };
            off += VFMT_SIZE[e.type] || e.size || 0;
          }
        });
        const pos = el.position, nrm = el.normal, uv = el.texcoord;
        if (!pos || !vbufs[pos.s]?.dv) { dbg('mesh', m, 'no position stream'); continue; }

        const posVB = vbufs[pos.s];
        const vCount = Math.floor(posVB.dv.byteLength / posVB.stride);
        // The float positions are already final model-space coordinates: across every shell file the raw centre
        // equals position_offset and the raw extent is ±position_scale, i.e. those two just DESCRIBE the bounds.
        // Applying them again is invisible within one file (uniform shrink + shift) but each region file has its
        // own scale, so a shell whose eye comes from a separate file (region 21, the standard eye core) ended up
        // with the eye too small and shifted by the body file's offset — 169 shells (verified 2026-09-19).
        const positions = new Float32Array(vCount * 3);
        for (let v = 0; v < vCount; v++) {
          const b = v * posVB.stride + pos.offset;
          positions[v * 3] = posVB.dv.getFloat32(b, true);
          positions[v * 3 + 1] = posVB.dv.getFloat32(b + 4, true);
          positions[v * 3 + 2] = posVB.dv.getFloat32(b + 8, true);
        }

        // normals (short4 normalized; w's low byte & 7 = the vertex dye slot)
        let normals = null;
        const slots = new Float32Array(vCount);
        if (nrm && vbufs[nrm.s]?.dv && nrm.type === '_vertex_format_attribute_short4') {
          const vb = vbufs[nrm.s];
          normals = new Float32Array(vCount * 3);
          for (let v = 0; v < vCount; v++) {
            const b = v * vb.stride + nrm.offset;
            let x = vb.dv.getInt16(b, true) / 32767, y = vb.dv.getInt16(b + 2, true) / 32767, z = vb.dv.getInt16(b + 4, true) / 32767;
            const len = Math.hypot(x, y, z) || 1;
            normals[v * 3] = x / len; normals[v * 3 + 1] = y / len; normals[v * 3 + 2] = z / len;
            slots[v] = vb.dv.getUint8(b + 6) & 7;
          }
        }

        let uvs = null;
        if (uv && vbufs[uv.s]?.dv) {
          const vb = vbufs[uv.s];
          const tS = mesh.texcoord_scale || [1, 1], tO = mesh.texcoord_offset || [0, 0];
          uvs = new Float32Array(vCount * 2);
          const n = Math.min(vCount, Math.floor(vb.dv.byteLength / vb.stride));
          for (let v = 0; v < n; v++) {
            const b = v * vb.stride + uv.offset;
            uvs[v * 2] = (vb.dv.getInt16(b, true) / 32767) * tS[0] + tO[0];
            uvs[v * 2 + 1] = (vb.dv.getInt16(b + 2, true) / 32767) * tS[1] + tO[1];
          }
        }

        // sanity on positions
        let ok = true, maxAbs = 0;
        for (let i = 0; i < positions.length; i++) { const a = Math.abs(positions[i]); if (!isFinite(a)) { ok = false; break; } if (a > maxAbs) maxAbs = a; }
        if (!ok || maxAbs === 0 || maxAbs > 1e5) { dbg('mesh', m, 'rejected bounds', maxAbs); continue; }

        // bone per vertex = position.w (rigid single-bone skinning; see GHOST_BONES)
        const bones = new Float32Array(vCount);
        for (let v = 0; v < vCount; v++) bones[v] = Math.max(0, Math.round(posVB.dv.getFloat32(v * posVB.stride + pos.offset + 12, true)));

        // Per-part dye slot. Bungie's own loaders read the part's gear_dye_change_color_index as THE dye slot
        // (0→dye0 primary, 1→dye0 secondary, 2→dye1 primary, … i.e. the same 0-5 slot numbering the vertex bits
        // use). We record it per vertex alongside the vertex bits so either source can drive the shader.
        const cciSlots = new Float32Array(vCount).fill(-1);
        const toTris = (list) => {
          const idx = [];
          for (const pt of list) {
            const before = idx.length;
            const start = pt.start_index || 0, count = pt.index_count || 0;
            if (pt.primitive_type === 5 || pt.primitive_type == null) {   // triangle strip (restart 0xFFFF)
              let a = -1, b = -1, wind = 0;
              for (let i = 0; i < count && start + i < totalIdx; i++) {
                const vi = readIndex(start + i);
                if (vi === 0xffff) { a = -1; b = -1; wind = 0; continue; }
                if (a === -1) a = vi; else if (b === -1) b = vi;
                else { if (a !== b && b !== vi && a !== vi) { if (wind === 0) idx.push(a, b, vi); else idx.push(b, a, vi); } a = b; b = vi; wind ^= 1; }
              }
            } else {
              for (let i = 0; i + 2 < count && start + i + 2 < totalIdx; i += 3) idx.push(readIndex(start + i), readIndex(start + i + 1), readIndex(start + i + 2));
            }
            const cci = pt.gear_dye_change_color_index;
            if (typeof cci === 'number' && cci >= 0 && cci <= 5) for (let i = before; i < idx.length; i++) cciSlots[idx[i]] = cci;
          }
          return new Uint32Array(idx);
        };

        // the eye LENS: a small Core-bone (4) disc whose UVs span the whole 0..1 square — it uses its own glass
        // shader in-game, so sampling the body plate there shows random plate texels. Split it out as dark glass.
        const isLens = (pt) => {
          if (!uvs) return false;
          let u0 = 9, v0 = 9, u1 = -9, v1 = -9, core = true;
          for (let i = 0; i < pt.index_count && core; i++) {
            const vi = readIndex(pt.start_index + i);
            if (vi === 0xffff) continue;
            if (bones[vi] !== 4) core = false;
            u0 = Math.min(u0, uvs[vi * 2]); u1 = Math.max(u1, uvs[vi * 2]);
            v0 = Math.min(v0, uvs[vi * 2 + 1]); v1 = Math.max(v1, uvs[vi * 2 + 1]);
          }
          return core && u1 - u0 > 0.9 && v1 - v0 > 0.9 && pt.index_count < 400;
        };
        const lensParts = parts.filter(isLens);

        /** A part's UV bounds — how much of its texture it actually covers. */
        const partUv = (pt) => {
          if (!uvs) return null;
          let u0 = 9, v0 = 9, u1 = -9, v1 = -9, n = 0;
          for (let i = 0; i < pt.index_count; i++) {
            const vi = readIndex(pt.start_index + i);
            if (vi === 0xffff || vi >= vCount) continue;
            n++;
            u0 = Math.min(u0, uvs[vi * 2]); u1 = Math.max(u1, uvs[vi * 2]);
            v0 = Math.min(v0, uvs[vi * 2 + 1]); v1 = Math.max(v1, uvs[vi * 2 + 1]);
          }
          return n ? { u0, u1, v0, v1, uSpan: u1 - u0, vSpan: v1 - v0 } : null;
        };
        // A data-driven quad with its own texture that covers only PART of that texture is one frame of a sprite
        // strip the game flips through (Arena Shell's duelling fighters). The rest are solid bodies of the shell
        // (Lunar's moon, IX's tendrils) whose UVs cover their whole texture — those stay translucent.
        const isCard = (pt) => {
          const uv = partUv(pt);
          return !!uv && uv.uSpan > 0.1 && uv.uSpan < 0.85 && uv.vSpan > 0.6;
        };
        const cardParts = dataDrivenParts.filter(isCard);
        const translucentParts = dataDrivenParts.filter((pt) => !cardParts.includes(pt));
        const indices = toTris(parts.filter((pt) => !lensParts.includes(pt)));
        let flipped = false;
        if (indices.length) {
          if (normals) flipped = this._alignWinding(positions, normals, indices);
          // data-driven parts (flag 0x2000 = the part's shader reads per-vertex animation data): keep each part's
          // unique vertices so the animation layer can classify them (e.g. extend/retract spike clusters)
          const animParts = parts.filter((pt) => (pt.flags & 0x2000) && !lensParts.includes(pt)).map((pt) => {
            const set = new Set();
            for (let i = 0; i < pt.index_count; i++) { const vi = readIndex(pt.start_index + i); if (vi !== 0xffff && vi < vCount) set.add(vi); }
            return Uint32Array.from(set);
          }).filter((v) => v.length);
          // per-vertex animation data (RGBA8; entry k = vertex k, covering vertex 0..highest animated vertex)
          const ddFile = mesh.data_driven_vertex_buffer?.file_name && buffers[mesh.data_driven_vertex_buffer.file_name];
          const dd = ddFile ? new Uint8Array(ddFile.buffer, ddFile.byteOffset, ddFile.byteLength) : null;
          out.push({ kind: 'body', positions, normals, uvs, slots, cciSlots, bones, indices, animParts, dd });
        }
        if (lensParts.length) {
          const lensIdx = toTris(lensParts);
          if (flipped) for (let t = 0; t < lensIdx.length; t += 3) { const x = lensIdx[t + 1]; lensIdx[t + 1] = lensIdx[t + 2]; lensIdx[t + 2] = x; }
          if (lensIdx.length) out.push({ kind: 'lens', positions, normals, uvs, slots, cciSlots, bones, indices: lensIdx });
        }
        for (const pt of eyeParts) {
          const eyeIdx = toTris([pt]);
          if (eyeIdx.length) out.push({ kind: 'eye', positions, normals, uvs, slots, cciSlots, bones, indices: eyeIdx, textures: pt.shader.static_textures.slice(), cci: pt.gear_dye_change_color_index });
        }
        if (translucentParts.length) {
          const tIdx = toTris(translucentParts);
          if (tIdx.length) out.push({ kind: 'translucent', positions, normals, uvs, slots, cciSlots, bones, indices: tIdx });
        }
        // one mesh per sprite card, so each animates on its own
        for (const pt of cardParts) {
          const cIdx = toTris([pt]);
          if (cIdx.length) {
            out.push({ kind: 'card', positions, normals, uvs, slots, cciSlots, bones, indices: cIdx,
              textures: pt.shader.static_textures.slice(), cci: pt.gear_dye_change_color_index, uvRange: partUv(pt) });
          }
        }
        if (glassParts.length) {
          const gIdx = toTris(glassParts);
          if (gIdx.length) out.push({ kind: 'glass', positions, normals, uvs, slots, cciSlots, bones, indices: gIdx });
        }
        // VFX layers grouped by their texture set (one additive material each)
        const vfxGroups = new Map();
        for (const pt of vfxParts) {
          const key = pt.shader.static_textures.join('|');
          let list = vfxGroups.get(key); if (!list) vfxGroups.set(key, list = []);
          list.push(pt);
        }
        for (const [key, list] of vfxGroups) {
          const vIdx = toTris(list);
          // carry the part's own dye slot: a shell-specific effect layer takes its colour from that slot,
          // unlike the shared ghost-eye decal (see _vfxMaterial)
          if (vIdx.length) out.push({ kind: 'vfx', positions, normals, uvs, slots, cciSlots, bones, indices: vIdx, textures: key.split('|'), cci: list[0]?.gear_dye_change_color_index });
        }
        if (coatParts.length) {
          const cIdx = toTris(coatParts);
          if (cIdx.length) out.push({ kind: 'coat', positions, normals, uvs, slots, cciSlots, bones, indices: cIdx });
        }
        // decals grouped by their texture set (one material each)
        const decalGroups = new Map();
        for (const pt of decalParts) {
          const key = `${pt.gear_dye_change_color_index ?? 0}|${pt.shader.static_textures.join('|')}`;
          let list = decalGroups.get(key); if (!list) decalGroups.set(key, list = []);
          list.push(pt);
        }
        for (const [key, list] of decalGroups) {
          const dIdx = toTris(list);
          const [cci, ...tex] = key.split('|');
          if (dIdx.length) out.push({ kind: 'decal', positions, normals, uvs, slots, cciSlots, bones, indices: dIdx, textures: tex, cci: Number(cci) });
        }
        dbg('mesh', m, 'verts', vCount, 'tris', indices.length / 3, 'parts', parts.length, 'eye parts', eyeParts.length, 'maxAbs', maxAbs.toFixed(3));
      } catch (e) { dbg('mesh', m, 'decode error', e?.message || e); }
    }
    return out;
  }

  /** Flip triangle winding if it disagrees with the stored normals (so front-face culling + lighting agree). */
  _alignWinding(p, n, idx) {
    let agree = 0, disagree = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const d = fx * (n[a] + n[b] + n[c]) + fy * (n[a + 1] + n[b + 1] + n[c + 1]) + fz * (n[a + 2] + n[b + 2] + n[c + 2]);
      if (d >= 0) agree++; else disagree++;
    }
    const flip = disagree > agree;
    if (flip) {
      for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; }
    }
    dbg('winding agree', agree, 'disagree', disagree, flip ? '→ flipped' : '');
    return flip;
  }

  /** Build the THREE.Group: one mesh per decoded render mesh, each with the D2 gear shader material. */
  _buildGroup(THREE, cached) {
    const group = new THREE.Group();
    const texCache = new Map();
    const tex = (name, srgb = false) => {
      const img = name && cached.images.get(name);
      if (!img) return null;
      const cacheKey = srgb ? name + '#srgb' : name;
      let t = texCache.get(cacheKey);
      if (!t) {
        t = new THREE.DataTexture(img.data, img.w, img.h, THREE.RGBAFormat);
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;   // gear shader linearises the diffuse itself; data maps stay raw
        t.flipY = false;                     // Destiny UVs are top-left origin (row 0 = top)
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        texCache.set(cacheKey, t);
      }
      return t;
    };
    const eyeMats = [];
    const vfxMats = [];
    const cards = [];
    const rotors = [];
    const glowUniforms = [];
    const ddChannels = [];
    const rig = this._buildRig(THREE, group, cached.meshes);
    for (const mesh of cached.meshes) {
      let mat;
      if (mesh.kind === 'eye') {
        mat = this._eyeMaterial(THREE, tex, mesh.textures, cached.dyes);
        if (!mat) continue;
        eyeMats.push(mat);
      } else if (mesh.kind === 'lens') {
        mat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.12, metalness: 0.0, envMapIntensity: 0.85 }); // dark glass behind the iris
      } else if (mesh.kind === 'translucent') {
        if (!mesh.plates?.diffuse) continue;                 // plate-less transparent cards (shared glow quads) → nothing to shade
        mat = this._shellMaterial(THREE, tex, mesh.plates, cached.dyes, { translucent: true, images: cached.images });
      } else if (mesh.kind === 'vfx') {
        mat = this._vfxMaterial(THREE, tex, mesh.textures, cached.dyes, cached.vfxTint, mesh.cci);
        if (!mat) continue;
        vfxMats.push(mat);
      } else if (mesh.kind === 'card') {
        const card = this._cardMaterial(THREE, tex, mesh, cached, cards.length);
        if (!card) continue;                              // not a strip after all → skip rather than draw it wrong
        mat = card.mat;
        cards.push(card);                                 // `objects` filled in below, once the mesh exists
      } else if (mesh.kind === 'coat') {
        if (!mesh.plates?.diffuse) continue;
        mat = this._shellMaterial(THREE, tex, mesh.plates, cached.dyes, { coat: true, images: cached.images });
      } else if (mesh.kind === 'glass') {
        if (!mesh.plates?.diffuse) continue;
        // A stage-7 pane is only a canopy if you could actually see through it. Metal can't be seen through, so a
        // pane whose dye is metallic (Clean Lines' bronze dome, Wintry Neigh-bor's panels) is a lacquered SOLID —
        // render it as clear coat. Otherwise (Rimed, Eris Morn, Hareball …) it really is glass.
        // A solid pane is just an ordinary opaque surface: let the dye's own roughness/metalness stand rather than
        // forcing it glossy the way the clear-coat path does (that turned Clean Lines' bronze dome into chrome).
        // dev: window.__GHOST_PANE_DEBUG = 1 paints stage-7 panes magenta so it's obvious which part of a shell
        // the glass/solid rule is actually deciding about; 'glass'/'solid' force the decision for comparisons
        if (typeof window !== 'undefined' && window.__GHOST_PANE_DEBUG) {
          mat = new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
          const g0 = new THREE.BufferGeometry();
          g0.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
          g0.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
          const dbgMesh = new THREE.Mesh(g0, mat);
          dbgMesh.renderOrder = 20;
          group.add(dbgMesh);
          continue;
        }
        const forced = typeof window !== 'undefined' && window.__GHOST_GLASS_MODE;
        // A pane in the transparent stage is glass unless this shell is listed as an exception. The rule this
        // replaced — "a pane whose dye is metallic is a lacquered solid" — was wrong on 10 of the 14 shells it
        // was checked against (Clean Lines' canopy, Hard Light's lens, ROV's window…): dye metalness doesn't tell
        // a glass canopy from a solid mane. See shell-groups.js and research/shell-groups.md.
        const solid = forced ? forced === 'solid' : inGroup('opaque-pane', cached.hash);
        mat = this._shellMaterial(THREE, tex, mesh.plates, cached.dyes, solid ? { images: cached.images } : { glass: true, images: cached.images });
      } else if (mesh.kind === 'decal') {
        mat = this._decalMaterial(THREE, tex, cached.images, mesh.textures, mesh.cci, cached.dyes);
        if (!mat) continue;
      } else {
        mat = this._shellMaterial(THREE, tex, mesh.plates, cached.dyes, { images: cached.images });
      }
      // shared vertex attributes (one GPU upload), one index per rig bucket so petals / core can move independently
      const attrs = {
        position: new THREE.BufferAttribute(mesh.positions, 3),
        uv: mesh.uvs ? new THREE.BufferAttribute(mesh.uvs, 2) : null,
        normal: mesh.normals ? new THREE.BufferAttribute(mesh.normals, 3) : null,
        dyeSlot: new THREE.BufferAttribute(this._dyeSlots(mesh), 1),
      };
      if (mat.userData.glowUniform) glowUniforms.push(mat.userData.glowUniform);
      const morph = mesh.kind === 'body' && mat.userData.morphUniform ? this._spikeMorph(THREE, mesh, rig) : null;
      if (morph) {
        attrs.morphDir = new THREE.BufferAttribute(morph.dir, 3);
        attrs.morphLen = new THREE.BufferAttribute(morph.len, 1);
        attrs.morphGroup = new THREE.BufferAttribute(morph.group, 1);
        attrs.morphRetDir = new THREE.BufferAttribute(morph.retDir, 3);
        attrs.morphRetLen = new THREE.BufferAttribute(morph.retLen, 1);
        mat.defines = { ...(mat.defines || {}), SHELL_MORPH: '' };
        rig.addMorph(mat.userData.morphUniform, morph.ratio);
      }
      // General data-driven animation. The spike path above is a hand-verified special case (its timing was
      // measured frame-by-frame from in-game footage), so where it engages it keeps that mesh to itself; every
      // other dd-carrying mesh gets the general treatment.
      // propellers: a flat, blade-split data-driven part just spins (Peaceful Shell's twin rotors)
      const rotor = !morph && mesh.kind === 'body' && mat.userData.rotorUniform ? this._rotorSpin(THREE, mesh, rig) : null;
      if (rotor) {
        attrs.rotorHub = new THREE.BufferAttribute(rotor.hub, 3);
        attrs.rotorAxis = new THREE.BufferAttribute(rotor.axis, 3);
        attrs.rotorDir = new THREE.BufferAttribute(rotor.dir, 1);
        mat.defines = { ...(mat.defines || {}), SHELL_ROTOR: '' };
        rotors.push(mat.userData.rotorUniform);
      }
      const dd = !morph && !rotor && mesh.kind === 'body' && mat.userData.ddUniforms ? this._ddAnim(THREE, mesh, rig) : null;
      if (dd) {
        attrs.ddDir = new THREE.BufferAttribute(dd.dir, 3);
        attrs.ddAmt = new THREE.BufferAttribute(dd.amt, 3);
        attrs.ddPhase = new THREE.BufferAttribute(dd.phase, 3);
        mat.defines = { ...(mat.defines || {}), SHELL_DDANIM: '' };
        ddChannels.push({ kinds: dd.kinds, u: mat.userData.ddUniforms });
      }
      for (const [bucket, idx] of this._splitByBone(mesh)) {
        const g = new THREE.BufferGeometry();
        for (const k in attrs) if (attrs[k]) g.setAttribute(k, attrs[k]);
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        if (!attrs.normal) g.computeVertexNormals();
        const obj = new THREE.Mesh(g, mat);
        obj.renderOrder = RENDER_ORDER[mesh.kind] || 0;  // opaque → decals → translucent → eye
        obj.position.copy(rig.pivotFor(bucket)).negate();   // petals pivot at the eye, everything else at the centre
        rig.node(bucket).add(obj);
        if (mesh.kind === 'card') {
          // Remember where it rests and how tall THIS CARD is, so the animator can hop it (Destiny models are
          // Z-up). Measured over the card's own indices: every mesh shares one position attribute, so the
          // geometry's bounding box would be the whole shell's.
          const card = cards[cards.length - 1];
          let lo = Infinity, hi = -Infinity;
          for (const v of mesh.indices) { const z = mesh.positions[v * 3 + 2]; if (z < lo) lo = z; if (z > hi) hi = z; }
          card.obj = obj;
          card.rest = obj.position.clone();
          card.height = hi > lo ? hi - lo : 0;
        }
      }
    }
    group.userData.rig = rig.api;
    // glowing dyes breathe slightly in game; the companion drives this each frame (1 = steady)
    group.userData.glow = { count: glowUniforms.length, set: (v) => { for (const u of glowUniforms) u.value = v; } };
    // Data-driven animation: the companion advances `t` (seconds); each channel runs its inferred motion.
    // kinds: 1 extend (slow out/hold/in), 2 ring (pulse travelling around), 3 pulse (breathe), 4 flicker (fast).
    group.userData.ddAnim = {
      count: ddChannels.length,
      kinds: ddChannels.length ? ddChannels[0].kinds.slice() : [0, 0, 0],
      set: (t) => {
        for (const ch of ddChannels) {
          for (let c = 0; c < 3; c++) {
            const kind = ch.kinds[c];
            let k = 0, seq = 0, head = 0;
            if (kind === 1) {                                   // extend: out, hold, back, pause (8s loop, offset per channel)
              const p = ((t / 8) + c * 0.33) % 1;
              k = p < 0.06 ? p / 0.06 : p < 0.45 ? 1 : p < 0.51 ? 1 - (p - 0.45) / 0.06 : 0;
            } else if (kind === 2) {                            // ring: a pulse travelling around the clusters
              k = 1; seq = 1; head = (t / 3 + c * 0.2) % 1;
            } else if (kind === 3) {                            // pulse: gentle breathing
              k = 0.5 + 0.5 * Math.sin(t * 1.1 + c * 2.1);
            } else if (kind === 4) {                            // flicker: quick shimmer
              k = 0.5 + 0.5 * Math.sin(t * 5.0 + c * 1.7);
            }
            ch.u.k.value.setComponent(c, k);
            ch.u.seq.value.setComponent(c, seq);
            ch.u.head.value.setComponent(c, head);
          }
        }
      },
    };
    // effect layers drift/breathe over time; the companion advances this each frame (seconds)
    group.userData.vfx = { count: vfxMats.length, set: (t) => { for (const m of vfxMats) m.userData.vfxTime.value = t; } };
    // propellers: they just turn, constantly (see _rotorSpin). The companion advances `t` (seconds).
    group.userData.rotor = {
      count: rotors.length,
      rps: ROTOR_RPS,
      set: (t) => { const a = t * ROTOR_RPS * Math.PI * 2; for (const u of rotors) u.value = a; },
    };
    /**
     * Sprite cards: flip between the frames of their strip on the measured loop, hop the ones whose alternate art
     * sits higher, and — because a shell that has duelling cards also has the clash spark — flash the effect layers
     * at the moment the base frame returns, which is the impact. The companion advances `t` (seconds).
     */
    const sparkBase = vfxMats.map((m) => m.userData.vfxStrength?.value ?? 0);
    group.userData.cards = {
      count: cards.length,
      set: (t) => {
        const p = ((t * 1000) % CARD_CYCLE_MS + CARD_CYCLE_MS) % CARD_CYCLE_MS;
        const onAlt = p < CARD_ALT_MS;
        for (const c of cards) {
          const frame = onAlt ? c.altFrame : c.baseFrame;
          c.map.offset.x = (frame - c.baseFrame) / c.frames;
          if (c.time) c.time.value = t;                     // scrolls the hologram's rolling bands
          if (!c.obj) continue;
          let lift = 0;
          if (onAlt && c.hop) {
            const ease = (x) => { const k = Math.max(0, Math.min(1, x)); return k * k * (3 - 2 * k); };
            lift = p < CARD_RISE_MS ? ease(p / CARD_RISE_MS)
              : p > CARD_ALT_MS - CARD_FALL_MS ? ease((CARD_ALT_MS - p) / CARD_FALL_MS) : 1;
          }
          c.obj.position.set(c.rest.x, c.rest.y, c.rest.z + lift * CARD_HOP * c.height);
        }
        // spark: brightest right after the strike lands, gone well before the next leap
        const since = (p - CARD_ALT_MS + CARD_CYCLE_MS) % CARD_CYCLE_MS;
        const flash = since < CARD_SPARK_MS ? 1 - since / CARD_SPARK_MS : 0;
        for (let i = 0; i < vfxMats.length; i++) {
          const u = vfxMats[i].userData.vfxStrength;
          if (u) u.value = sparkBase[i] * flash;
        }
      },
    };
    // the companion drives these per frame (breathing / blink / speak): eye.set({ open, intensity })
    group.userData.eye = {
      count: eyeMats.length,
      tint: eyeMats[0]?.color.clone() || null,
      set: ({ open, intensity } = {}) => {
        for (const m of eyeMats) {
          const u = m.userData.eyeUniforms;
          if (typeof open === 'number') u.eyeOpen.value = Math.max(0, Math.min(1, open));
          if (typeof intensity === 'number') u.eyeIntensity.value = Math.max(0, intensity);
        }
      },
    };
    return group;
  }

  /** Split a mesh's triangles into rig buckets by bone (rigid skinning: every vertex has one bone = position.w).
   *  Buckets: 'base' (Pedestal/Base/rotation roots + anything unknown), 'core' (4 = eye), 'p5'..'p12' (petals). */
  _splitByBone(mesh) {
    const buckets = new Map();
    const { indices, bones } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const b = bones[indices[t]];
      const key = b === 4 ? 'core' : (b >= 5 && b <= 12 ? 'p' + b : 'base');
      let arr = buckets.get(key); if (!arr) buckets.set(key, arr = []);
      arr.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    return [...buckets].map(([k, a]) => [k, new Uint32Array(a)]);
  }

  /**
   * Procedural Ghost rig from the D2 ghost skeleton's bone layout (Destiny-Collada-Generator ghost.dae joint order):
   *   0 Pedestal, 1 Base, 2 Front_Rotation, 3 Back_Rotation, 4 Core (eye),
   *   5-8 Front Bottom/Top/Left/Right petals, 9-12 Back Bottom/Top/Left/Right petals.
   * The .dae joint positions don't match shell geometry scale/offset, so pivots come from the geometry itself:
   * everything pivots at the model centre; the ring axis runs back-petal centroid → front-petal centroid.
   * Shells without petals (e.g. Speed Metal: all Base + Core) simply have nothing to move but the core.
   * api.set({ spread 0..1, frontSpin rad, backSpin rad, coreYaw rad, corePitch rad })
   */
  /**
   * Centre one ring of petals turns about. Each petal contributes its own centroid (one point per petal, so a
   * big petal doesn't drag the answer toward itself the way a vertex-weighted centroid does), and those points
   * are circle-fitted in the plane across the axis — a ring is by definition the circle its petals sit on, and
   * the fit is what makes all four end up at the same radius so the spin reads as centred.
   */
  _ringPivot(THREE, acc, centroid, bones, axis, up, side, fallback) {
    const pts = [];
    for (const b of bones) { const c = centroid([b]); if (c) pts.push(c); }
    if (!pts.length) return fallback;
    const mean = new THREE.Vector3();
    for (const p of pts) mean.add(p);
    mean.multiplyScalar(1 / pts.length);
    if (pts.length < 3) return mean;
    // project to (u, v) across the axis, then algebraic circle fit (Kåsa)
    const uv = pts.map((p) => { const d = p.clone().sub(mean); return [d.dot(side), d.dot(up)]; });
    let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (const [u, v] of uv) {
      Suu += u * u; Svv += v * v; Suv += u * v;
      Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
    }
    const det = 2 * (Suu * Svv - Suv * Suv);
    if (!isFinite(det) || Math.abs(det) < 1e-18) return mean;          // petals collinear → no circle to fit
    const cu = (Svv * (Suuu + Suvv) - Suv * (Svvv + Svuu)) / det;
    const cv = (Suu * (Svvv + Svuu) - Suv * (Suuu + Suvv)) / det;
    if (!isFinite(cu) || !isFinite(cv)) return mean;
    const out = mean.clone().addScaledVector(side, cu).addScaledVector(up, cv);
    // a fit that lands miles away means the petals aren't really a ring — keep the plain mean instead
    const reach = Math.max(...uv.map(([u, v]) => Math.hypot(u, v))) || 1;
    return Math.hypot(cu, cv) > reach * 1.5 ? mean : out;
  }

  _buildRig(THREE, group, meshes) {
    const acc = new Map();   // bone → { n, x, y, z }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      if (m.kind !== 'body') continue;
      const seen = new Uint8Array(m.bones.length);
      for (let t = 0; t < m.indices.length; t++) {
        const v = m.indices[t]; if (seen[v]) continue; seen[v] = 1;
        const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
        min.min({ x, y, z }); max.max({ x, y, z });
        const b = m.bones[v]; let a = acc.get(b); if (!a) acc.set(b, a = { n: 0, x: 0, y: 0, z: 0 });
        a.n++; a.x += x; a.y += y; a.z += z;
      }
    }
    const center = isFinite(min.x) ? new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5) : new THREE.Vector3();
    const radius = isFinite(min.x) ? max.clone().sub(min).length() / 2 : 1;
    const centroid = (list) => {
      const c = new THREE.Vector3(); let n = 0;
      for (const b of list) { const a = acc.get(b); if (a) { c.x += a.x; c.y += a.y; c.z += a.z; n += a.n; } }
      return n ? c.multiplyScalar(1 / n) : null;
    };
    // The axis both petal rings turn about is the eye axis, which is model +X on every shell (the ghost skeleton
    // is universal — no shell uses more than the same 13 bones). Deriving it from the front/back petal centroids
    // instead looks reasonable but is thrown off by asymmetric shells: measured across the 257 shells that have
    // petals, 29 came out more than 5° off and 7 more than 20° (Nine Lives 54.8°, Visionary 20.6°). A cocked axis
    // makes the rings visibly wobble instead of turning about the centre.
    const axis = new THREE.Vector3(1, 0, 0);
    const up = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);   // Destiny is Z-up
    const side = new THREE.Vector3().crossVectors(axis, up).normalize();
    up.crossVectors(side, axis).normalize();

    // Each ring turns about ITS OWN centre, not the model's bounding-box centre. The box is skewed by whatever
    // sticks out (an antenna, a tail), so pivoting there swings the petals around a point off to one side
    // instead of spinning them in place. The two rings aren't always coaxial either — on Visionary the front and
    // back centres differ across the axis as well as along it — so they get separate pivots. A ring of petals is
    // symmetric about its own centroid, which makes that centroid the rotation centre.
    const frontCenter = this._ringPivot(THREE, acc, centroid, [5, 6, 7, 8], axis, up, side, center);
    const backCenter = this._ringPivot(THREE, acc, centroid, [9, 10, 11, 12], axis, up, side, center);
    const pivot = (at) => { const o = new THREE.Group(); o.position.copy(at); return o; };
    const base = pivot(center), core = pivot(center), frontRing = pivot(frontCenter), backRing = pivot(backCenter);
    group.add(base, core, frontRing, backRing);
    const petals = new Map();
    const node = (bucket) => {
      if (bucket === 'base') return base;
      if (bucket === 'core') return core;
      let p = petals.get(bucket);
      if (!p) {
        const b = +bucket.slice(1);
        p = new THREE.Group();
        const c = centroid([b]);
        const dir = c ? c.clone().sub(center) : new THREE.Vector3();
        dir.addScaledVector(axis, -dir.dot(axis));              // spread radially (perpendicular to the ring axis)
        p.userData.dir = dir.lengthSq() > 1e-12 ? dir.normalize() : new THREE.Vector3();
        (b <= 8 ? frontRing : backRing).add(p);
        petals.set(bucket, p);
      }
      return p;
    };
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    const state = { spread: 0, frontSpin: 0, backSpin: 0, coreYaw: 0, corePitch: 0 };
    const morphUniforms = [];
    let morphRatio = 1;
    const api = {
      get petals() { return petals.size; },
      axis, up, radius,
      /** Where a bucket's meshes must be offset from: petals hang off the rings, which pivot at the eye. */
      pivotFor: (bucket) => { if (!bucket || bucket[0] !== 'p') return center; const b = +bucket.slice(1); return b <= 8 ? frontCenter : backCenter; },
      state,
      /**
       * Spike extension (see _spikeMorph), each spike set independently, 0 = retracted … 1 = fully out:
       *   set({ long, short })  long = the set modelled extended (1 = as modelled), short = the set modelled short.
       */
      morph: {
        get available() { return morphUniforms.length > 0; },
        get ratio() { return morphRatio; },
        set({ long = 1, short = 0 } = {}) {
          const lo = Math.max(0, Math.min(1.15, long)), sh = Math.max(-0.1, Math.min(1.15, short));   // slight overshoot allowed
          // x: how far the short set travels out (× its weighted length)
          // y: how far the long set pulls back in;  z: how far the short set pulls back in
          // Both sets retract almost fully between pulses — in-game only small liquid nubs remain, and those are
          // separate static geometry.
          for (const u of morphUniforms) u.value.set(sh, 0.98 * (1 - Math.min(1, lo)), 0.9 * (1 - Math.min(1, sh)), 0);
        },
      },
      set(s = {}) {
        Object.assign(state, s);
        for (const p of petals.values()) p.position.copy(p.userData.dir).multiplyScalar(state.spread * radius * 0.16);
        frontRing.quaternion.setFromAxisAngle(axis, state.frontSpin);
        backRing.quaternion.setFromAxisAngle(axis, state.backSpin);
        q.setFromAxisAngle(up, state.coreYaw); q2.setFromAxisAngle(side, state.corePitch);
        core.quaternion.multiplyQuaternions(q, q2);
      },
    };
    dbg('rig: petals', [...acc.keys()].filter((b) => b >= 5 && b <= 12).length, 'axis', axis.toArray().map((v) => v.toFixed(2)), 'radius', radius.toFixed(4));
    const addMorph = (uniform, ratio) => { morphUniforms.push(uniform); morphRatio = ratio; };
    return { center, frontCenter, backCenter, axis, up, side, node, api, addMorph, pivotFor: api.pivotFor };
  }

  /**
   * Generic spike extend/retract swap, detected from geometry (no per-shell tables):
   * data-driven parts (flag 0x2000) are grouped into directional clusters around the ring axis (a part whose
   * centroid sits near the centre — e.g. a band wrapping the body — is ignored). Clusters split into the two
   * perpendicular directions (up/down vs left/right); if one pair is clearly longer (≥1.5×), animating s 0→1
   * stretches the short pair out to the long length and retracts the long pair to the short length, from each
   * cluster's base (e.g. Speed Metal's liquid-metal spikes). Returns per-vertex attributes or null.
   */
  /**
   * Spinning rotors, detected from geometry (no per-shell tables).
   *
   * A data-driven part qualifies when it is a FLAT disc (one extent far smaller than the others) whose animation
   * masks split it into blades sitting on opposite sides of its hub, each blade longer than it is wide. That is a
   * propeller: Peaceful Shell's two rotors are flat plates on top of the shell, each split by its masks into two
   * blades reaching out to either side. They spin about the disc's own normal, forever, at ROTOR_RPS.
   *
   * Rotors that mirror each other across the shell (Peaceful's pair) are given opposite directions, which is how a
   * twin-rotor craft actually flies — and looks right whichever way the game spins them.
   * Returns per-vertex attributes, or null when the shell has no rotors.
   */
  _rotorSpin(THREE, mesh, rig) {
    if (!mesh.dd || !mesh.animParts?.length) return null;
    const P = mesh.positions;
    const bounds = (list) => {
      const c = [0, 0, 0];
      for (const v of list) for (let k = 0; k < 3; k++) c[k] += P[v * 3 + k];
      for (let k = 0; k < 3; k++) c[k] /= list.length;
      const ext = [0, 0, 0];
      for (const v of list) for (let k = 0; k < 3; k++) ext[k] = Math.max(ext[k], Math.abs(P[v * 3 + k] - c[k]));
      return { c, ext };
    };
    const rotors = [];
    for (const part of mesh.animParts) {
      if (part.length < 24) continue;
      const whole = bounds(part);
      const thin = whole.ext.indexOf(Math.min(...whole.ext));
      if (whole.ext[thin] > Math.max(...whole.ext) * 0.2) continue;    // not flat: not a propeller plate
      const plane = [0, 1, 2].filter((k) => k !== thin);
      // Each animation mask marks an independently driven piece, so each is its own rotor — Peaceful Shell's two
      // plates carry two rotors apiece, which is how it ends up with four.
      const groups = new Map();
      for (const v of part) {
        const key = `${mesh.dd[v * 4]},${mesh.dd[v * 4 + 1]},${mesh.dd[v * 4 + 2]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
      }
      for (const g of groups.values()) {
        if (g.length < 8) continue;
        const b = bounds(g);
        const long = Math.max(b.ext[plane[0]], b.ext[plane[1]]);
        const short = Math.min(b.ext[plane[0]], b.ext[plane[1]]);
        if (long < b.ext[thin] * 2.5 || long < short * 1.3) continue;  // blades reach out from their hub
        const axis = [0, 0, 0];
        axis[thin] = 1;
        rotors.push({ verts: g, hub: b.c, axis, plane });
      }
    }
    if (!rotors.length) return null;

    // Real quadcopters counter-rotate their adjacent rotors, so diagonally opposite ones turn the same way. With
    // the hubs' offsets from the shell's centre in the rotor plane, that is just the sign of their product.
    const mid = [0, 1, 2].map((k) => rotors.reduce((s, r) => s + r.hub[k], 0) / rotors.length);
    const n = mesh.positions.length / 3;
    const hub = new Float32Array(n * 3), axis = new Float32Array(n * 3), dir = new Float32Array(n);
    for (const r of rotors) {
      const [a, b] = r.plane;
      const da = r.hub[a] - mid[a], db = r.hub[b] - mid[b];
      const spin = (rotors.length > 2 ? da * db : da || db) >= 0 ? 1 : -1;
      for (const v of r.verts) {
        for (let k = 0; k < 3; k++) { hub[v * 3 + k] = r.hub[k]; axis[v * 3 + k] = r.axis[k]; }
        dir[v] = spin;
      }
      r.spin = spin;
    }
    dbg('rotors', rotors.length, rotors.map((r) => r.hub.map((v) => v.toFixed(3)).join(',') + (r.spin > 0 ? ' CW' : ' CCW')).join(' | '));
    return { hub, axis, dir, count: rotors.length };
  }

  /**
   * General per-shell animation from the data-driven vertex buffer.
   *
   * Layout (decoded 2026-09-18): stride 4, entry k = vertex k. Alpha is always 255 and carries nothing; R, G and B
   * are three INDEPENDENT per-vertex weight masks, each selecting a different group of geometry for its own
   * animation channel. Low-cardinality masks are hard group membership, high-cardinality ones are gradients along
   * a part (tip moves more than base). Bungie ships the weights but NOT the motion — that lives in the client
   * shader — so the motion type is inferred per cluster from its geometry:
   *   extend  — elongated and outboard        → grows along its own axis (the liquid-metal spike family)
   *   ring    — several clusters at one radius → a travelling pulse around the ring, one cluster at a time
   *   pulse   — outboard but stubby            → gentle in/out along the outward direction
   *   flicker — neither                        → small local breathing along the vertex normal
   * 75 of 125 shells drive all three channels, 33 drive two.
   */
  _ddAnim(THREE, mesh, rig) {
    if (!mesh.dd || !mesh.animParts?.length) return null;
    const P = mesh.positions, { center, axis } = rig;
    const anim = new Set();
    for (const part of mesh.animParts) for (const v of part) anim.add(v);
    const verts = [...anim].filter((v) => v * 4 + 3 < mesh.dd.length);
    if (verts.length < 12) return null;

    // model scale, for judging "outboard" and "elongated" in units of the shell's own size
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of new Set(mesh.indices)) for (let k = 0; k < 3; k++) { const p = P[v * 3 + k]; if (p < lo[k]) lo[k] = p; if (p > hi[k]) hi[k] = p; }
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;

    const n = mesh.positions.length / 3;
    const dir = new Float32Array(n * 3), amt = new Float32Array(n * 3), phase = new Float32Array(n * 3);
    const kinds = [0, 0, 0];                       // 0 none, 1 extend, 2 ring, 3 pulse, 4 flicker
    const tmp = new THREE.Vector3(), rad = new THREE.Vector3();
    let any = false;

    for (let c = 0; c < 3; c++) {
      let mn = 255, mx = 0;
      for (const v of verts) { const t = mesh.dd[v * 4 + c]; if (t < mn) mn = t; if (t > mx) mx = t; }
      if (mx - mn < 8) continue;                   // flat channel → unused
      const thr = (mn + mx) / 2;
      const hot = verts.filter((v) => mesh.dd[v * 4 + c] > thr);
      if (hot.length < 8) continue;

      const clusters = this._clusterVerts(hot, P, lo, size / 12);
      const big = clusters.filter((g) => g.length >= 6);
      if (!big.length) continue;

      // describe each cluster: outward direction (radial to the rig axis), reach, elongation, angle for ordering
      const desc = big.map((g) => {
        const cen = new THREE.Vector3();
        for (const v of g) cen.x += P[v * 3], cen.y += P[v * 3 + 1], cen.z += P[v * 3 + 2];
        cen.multiplyScalar(1 / g.length).sub(center);
        rad.copy(cen).addScaledVector(axis, -cen.dot(axis));               // drop the along-axis part
        const out = rad.lengthSq() > 1e-14 ? rad.clone().normalize() : cen.clone().normalize();
        let glo = [Infinity, Infinity, Infinity], ghi = [-Infinity, -Infinity, -Infinity];
        for (const v of g) for (let k = 0; k < 3; k++) { const p = P[v * 3 + k]; if (p < glo[k]) glo[k] = p; if (p > ghi[k]) ghi[k] = p; }
        const ext = [0, 1, 2].map((k) => ghi[k] - glo[k]).sort((a, b) => b - a);
        return { g, out, dist: cen.length() / size, elong: ext[0] / Math.max(1e-6, ext[2]), span: ext[0],
          ang: Math.atan2(out.dot(rig.up), out.dot(rig.side)) };
      });

      // classify the channel from its clusters
      const ds = desc.map((d) => d.dist), md = ds.reduce((a, b) => a + b, 0) / ds.length;
      const sd = Math.sqrt(ds.reduce((s, d) => s + (d - md) ** 2, 0) / ds.length);
      const maxE = Math.max(...desc.map((d) => d.elong)), maxD = Math.max(...ds);
      let kind;
      if (desc.length >= 4 && md > 0.15 && sd < md * 0.35) kind = 2;        // ring / sequence
      else if (maxE >= 3 && maxD > 0.1) kind = 1;                            // extend / retract
      else if (maxD > 0.2) kind = 3;                                         // outboard pulse
      else kind = 4;                                                         // local flicker
      kinds[c] = kind;
      any = true;

      // ring clusters fire in angular order so the pulse travels around the ring rather than at random
      const order = desc.map((d, i) => i).sort((a, b) => desc[a].ang - desc[b].ang);
      const slot = new Map(); order.forEach((di, i) => slot.set(di, i / order.length));

      // Amplitude. Bungie gives the weights but not the travel, so this is a judgement call: scale by the
      // cluster's own span, then hard-cap against the model size. Under-animating reads as a subtle mechanical
      // idle; over-animating throws parts off the model (the first cut used the full span and did exactly that).
      const reach = kind === 1 ? 0.35 : kind === 3 ? 0.15 : kind === 2 ? 0.12 : 0.06;
      const cap = size * (kind === 1 ? 0.10 : kind === 3 ? 0.04 : kind === 2 ? 0.035 : 0.02);
      for (let di = 0; di < desc.length; di++) {
        const d = desc[di], ph = slot.get(di) || 0;
        for (const v of d.g) {
          const w = Math.min(1, Math.max(0, (mesh.dd[v * 4 + c] - thr) / Math.max(1, mx - thr)));
          let dx, dy, dz;
          if (kind === 4 && mesh.normals) { dx = mesh.normals[v * 3]; dy = mesh.normals[v * 3 + 1]; dz = mesh.normals[v * 3 + 2]; }
          else { dx = d.out.x; dy = d.out.y; dz = d.out.z; }
          // one direction per vertex: the strongest channel claims it (channels rarely overlap on a vertex)
          if (amt[v * 3] + amt[v * 3 + 1] + amt[v * 3 + 2] === 0) { dir[v * 3] = dx; dir[v * 3 + 1] = dy; dir[v * 3 + 2] = dz; }
          amt[v * 3 + c] = Math.min(w * d.span * reach, w * cap);
          phase[v * 3 + c] = ph;
        }
      }
    }
    if (!any) return null;
    dbg('dd anim channels', kinds.map((k) => ['none', 'extend', 'ring', 'pulse', 'flicker'][k]).join('/'));
    return { dir, amt, phase, kinds };
  }

  /** Grid-bucket + union-find spatial clustering of a vertex list. */
  _clusterVerts(list, P, lo, cell) {
    const par = new Map(), cells = new Map();
    const find = (a) => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
    for (const v of list) {
      const k = `${Math.floor((P[v * 3] - lo[0]) / cell)},${Math.floor((P[v * 3 + 1] - lo[1]) / cell)},${Math.floor((P[v * 3 + 2] - lo[2]) / cell)}`;
      if (!par.has(k)) { par.set(k, k); cells.set(k, []); }
      cells.get(k).push(v);
    }
    for (const k of [...par.keys()]) {
      const [a, b, c] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const nk = `${a + dx},${b + dy},${c + dz}`;
        if (par.has(nk)) { const ra = find(k), rb = find(nk); if (ra !== rb) par.set(ra, rb); }
      }
    }
    const groups = new Map();
    for (const [k, vs] of cells) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(...vs); }
    return [...groups.values()];
  }

  _spikeMorph(THREE, mesh, rig) {
    if (!mesh.animParts?.length) return null;
    const P = mesh.positions, { center, axis, up, side } = rig;
    const tmp = new THREE.Vector3();
    const clusters = [];
    for (const verts of mesh.animParts) {
      const c = new THREE.Vector3();
      for (const v of verts) c.x += P[v * 3], c.y += P[v * 3 + 1], c.z += P[v * 3 + 2];
      c.multiplyScalar(1 / verts.length).sub(center);
      c.addScaledVector(axis, -c.dot(axis));
      if (c.lengthSq() < 1e-14) continue;
      const dir = c.clone().normalize();
      let lo = Infinity, hi = -Infinity;
      for (const v of verts) {
        const r = tmp.set(P[v * 3] - center.x, P[v * 3 + 1] - center.y, P[v * 3 + 2] - center.z).dot(dir);
        if (r < lo) lo = r; if (r > hi) hi = r;
      }
      const len = hi - lo;
      if (!(len > 0) || c.length() < len * 0.35) continue;
      clusters.push({ verts, dir, lo, len, onUp: Math.abs(dir.dot(up)) >= Math.abs(dir.dot(side)) });
    }
    const mean = (list) => list.reduce((s, c) => s + c.len, 0) / (list.length || 1);
    const ups = clusters.filter((c) => c.onUp), sides = clusters.filter((c) => !c.onUp);
    if (!ups.length || !sides.length) return null;
    const upLen = mean(ups), sideLen = mean(sides);
    const ratio = Math.max(upLen, sideLen) / Math.min(upLen, sideLen);
    if (!(ratio >= 1.5)) { dbg('spike morph: clusters found but lengths too similar', ratio.toFixed(2)); return null; }
    const longOnUp = upLen > sideLen;

    // data signature (the geometry test alone false-positives on ~6 of 360 exotics): the EXTENDING (short) clusters
    // carry an extension weight in the data-driven R channel that tracks distance along the spike (|corr| ≥ 0.4),
    // while the RETRACTING (long) clusters carry none (no data / flat / uncorrelated). Verified: Speed Metal +0.57,
    // Quicksilver Squall −0.52; rejected Festive Lantern, Eternal, Wolven, Angler, Imperious Sun, Safety Monitor.
    const corrR = (list) => {
      if (!mesh.dd) return null;
      const xs = [], ys = [];
      for (const c of list) for (const v of c.verts) {
        if (v * 4 + 3 >= mesh.dd.length) continue;
        xs.push(tmp.set(P[v * 3] - center.x, P[v * 3 + 1] - center.y, P[v * 3 + 2] - center.z).dot(c.dir) - c.lo);
        ys.push(mesh.dd[v * 4]);
      }
      if (xs.length < 10) return null;
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      return syy > 0 && sxx > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    const shortCorr = corrR(longOnUp ? sides : ups), longCorr = corrR(longOnUp ? ups : sides);
    if (shortCorr == null || Math.abs(shortCorr) < 0.4 || (longCorr != null && Math.abs(longCorr) >= 0.15)) {
      dbg('spike morph: geometry fits but no extension-weight signature', shortCorr, longCorr);
      return null;
    }
    // Per vertex (matched to in-game footage of Speed Metal):
    //  RETRACTING (long) clusters: collapse back along the cluster direction toward the base (≈ fully; the small
    //    liquid blobs left behind are separate static geometry).
    //  EXTENDING (short) clusters: grow along each vertex's OWN outward direction (radial from the ring axis) so
    //    the spikes fan out, by the authored data-driven weight (R, normalised; inverted when it runs base→tip),
    //    reaching ~0.8× the retracting spikes' length.
    // Each vertex carries BOTH an extend vector (only the short set uses it) and a retract vector along its own
    // cluster back to the cluster base — both sets pull in between pulses, which is how it looks in game.
    const n = P.length / 3;
    const dir = new Float32Array(n * 3), len = new Float32Array(n), group = new Float32Array(n);
    const retDir = new Float32Array(n * 3), retLen = new Float32Array(n);
    const longLen = Math.max(upLen, sideLen);
    let rMax = 0;
    for (const c of (longOnUp ? sides : ups)) for (const v of c.verts) if (v * 4 < mesh.dd.length) rMax = Math.max(rMax, shortCorr > 0 ? mesh.dd[v * 4] : 255 - mesh.dd[v * 4]);
    for (const c of clusters) {
      const extending = c.onUp !== longOnUp;
      for (const v of c.verts) {
        tmp.set(P[v * 3] - center.x, P[v * 3 + 1] - center.y, P[v * 3 + 2] - center.z);
        const r = tmp.dot(c.dir);
        retDir[v * 3] = c.dir.x; retDir[v * 3 + 1] = c.dir.y; retDir[v * 3 + 2] = c.dir.z;
        retLen[v] = Math.max(0, r - c.lo);
        group[v] = extending ? 1 : -1;
        if (extending) {
          tmp.addScaledVector(axis, -tmp.dot(axis));
          if (tmp.dot(c.dir) <= 0 || tmp.lengthSq() < 1e-14) tmp.copy(c.dir); else tmp.normalize();
          tmp.lerp(c.dir, 0.55).normalize();                  // mostly along the cluster, with a gentle fan
          const raw = v * 4 < mesh.dd.length ? mesh.dd[v * 4] : 0;
          const w = rMax > 0 ? (shortCorr > 0 ? raw : 255 - raw) / rMax : Math.max(0, r - c.lo) / c.len;
          dir[v * 3] = tmp.x; dir[v * 3 + 1] = tmp.y; dir[v * 3 + 2] = tmp.z;
          len[v] = w * longLen * 0.8;
        }
      }
    }
    dbg('spike morph: clusters', clusters.length, 'up len', upLen.toFixed(4), 'side len', sideLen.toFixed(4), 'ratio', ratio.toFixed(2));
    return { dir, len, group, retDir, retLen, ratio };
  }

  /**
   * Effect layer (render stage 7 with a VFX texture): Bungie's own effect shaders are not in the API, so this draws
   * the part's effect texture additively — that texture IS the shape of the effect (wisps, energy core, embers) —
   * tinted by the shell's own glow colour and drifting slowly so it reads as alive rather than a decal.
   * Tint: the dye's emissive colour when it is actually coloured, else the shell icon's dominant colour, else white.
   */
  /**
   * Additive for colour, without adding ALPHA. Destiny's effect textures are opaque black around the art, and
   * plain AdditiveBlending accumulates that alpha — which paints a solid black rectangle wherever the layer sits
   * on a transparent canvas, exactly what the desktop overlay is. Keeping the destination alpha fixes that and
   * looks identical on an opaque background.
   */
  _additiveKeepAlpha(THREE, mat) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    return mat;
  }

  /**
   * Redraw a sprite strip as crisp glowing line art.
   *
   * Bungie's API only serves the MOBILE texture set, so a figure the game draws from a large texture reaches us as
   * 64px of soft, faint, anti-aliased line work. Drawn straight it is blurry; thresholded it falls apart. So the
   * strip is rebuilt once, on load, at CARD_UPSCALE× its size:
   *   1. bicubic upscale, clamped inside each frame so neighbouring poses can't bleed into each other
   *   2. unsharp mask — pushes each texel away from its neighbourhood, so line centres climb and the soft skirt
   *      around them falls back to black: that is what makes the lines read as lines
   *   3. a floor (kills the value-5 border baked around Rhulk) and a compressive tone curve that lifts the faint
   *      work without blowing the denser sprites into a blob
   *   4. a blurred copy added back as bloom, which is how the hologram reads in game
   * Nothing is invented: detail the 64px art never had (armour panels and so on) still isn't there, but the lines
   * it does have come out sharp instead of smeared.
   */
  _renderSprite(THREE, img, frames) {
    const { w, h, data } = img;
    const S = CARD_UPSCALE, W = w * S, H = h * S;
    const fw = w / frames;                               // source frame width, to clamp sampling per frame
    const src = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) src[i] = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255;

    const cubic = (p0, p1, p2, p3, t) => {
      const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
      const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
      const c = -0.5 * p0 + 0.5 * p2;
      return ((a * t + b) * t + c) * t + p1;
    };
    const big = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / S - 0.5, fy = (y + 0.5) / S - 0.5;
        const frame = Math.min(frames - 1, Math.floor(x / (fw * S)));
        const lo = frame * fw, hi = lo + fw - 1;         // never sample the neighbouring pose
        const at = (xx, yy) => src[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(hi, Math.max(lo, xx))];
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const col = [];
        for (let m = -1; m <= 2; m++) col.push(cubic(at(x0 - 1, y0 + m), at(x0, y0 + m), at(x0 + 1, y0 + m), at(x0 + 2, y0 + m), tx));
        big[y * W + x] = Math.max(0, Math.min(1, cubic(col[0], col[1], col[2], col[3], ty)));
      }
    }

    const r = Math.max(1, Math.round(S / 2));
    const line = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            sum += big[yy * W + xx]; n++;
          }
        }
        const here = big[y * W + x];
        let v = Math.max(0, Math.min(1, here + CARD_SHARPEN * (here - sum / n)));
        v = Math.max(0, v - CARD_FLOOR) / (1 - CARD_FLOOR);
        line[y * W + x] = (v / (v + CARD_KNEE)) * CARD_GAIN;
      }
    }

    // bloom: separable box blur, added back — kept inside each frame so one pose can't glow into the next
    const rb = Math.max(1, Math.round(S * 1.1));
    const fwBig = fw * S;
    const tmp = new Float32Array(W * H), glow = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const lo = Math.floor(x / fwBig) * fwBig, hi = lo + fwBig - 1;
      let s = 0, n = 0;
      for (let d = -rb; d <= rb; d++) { const xx = x + d; if (xx < lo || xx > hi) continue; s += line[y * W + xx]; n++; }
      tmp[y * W + x] = s / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let d = -rb; d <= rb; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; s += tmp[yy * W + x]; n++; }
      glow[y * W + x] = s / n;
    }

    const out = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = Math.min(1, line[i] + glow[i] * CARD_BLOOM);
      const k = i * 4;
      out[k] = out[k + 1] = out[k + 2] = Math.round(v * 255);
      out[k + 3] = 255;
    }
    const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;   // already toned; the card shader only tints and adds the hot core
    t.flipY = false;
    // CLAMP, never repeat: a card's UVs sit hard against its frame edge, so once they are slid to show the other
    // frame the edge lands just outside the strip. Wrapping sampled the far end of the strip — Arena's Guardian
    // picked up his own sword tip as a glowing speck beside him.
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    dbg('card sprite rebuilt', w + 'x' + h, '→', W + 'x' + H);
    return t;
  }

  /**
   * Sprite card (see CARD_* above): one frame of a strip drawn additively in the shell's own dye colour.
   * The strip is read straight from the texture — N = how many of the card's own UV spans fit across it, checked
   * against the image being N times wider than tall. Returns the material plus what the animator needs, or null.
   */
  _cardMaterial(THREE, tex, mesh, cached, cardIndex) {
    const name = mesh.textures.find((n) => /_dif$/i.test(n)) || mesh.textures[0];
    const img = cached.images.get(name);
    if (!img) { dbg('card: texture missing', mesh.textures); return null; }
    const frames = Math.max(1, Math.round(1 / (mesh.uvRange?.uSpan || 1)));
    if (frames < 2 || Math.abs(img.w / img.h - frames) > 0.35) {
      dbg('card: not a sprite strip', name, 'frames', frames, img.w + 'x' + img.h);
      return null;
    }
    const base = this._renderSprite(THREE, img, frames);   // crisp glowing line art, rebuilt from the 64px original
    // Its own copy of the texture, so sliding this card's frames doesn't move another card's. No mipmaps: the art
    // is one-pixel line work, and minifying it averages the lines away to nothing (they read as broken outlines).
    const map = base;                       // rebuilt per card already, so no clone needed
    const baseFrame = Math.min(frames - 1, Math.max(0, Math.round(mesh.uvRange.u0 * frames)));
    const altFrame = (baseFrame + 1) % frames;

    // Colour: the textures are greyscale line art; the shell's dyes carry the colour (Arena: slot 0 pure blue for
    // the Guardian, slot 1 crimson for Rhulk). Cards take successive dye slots, normalised to full brightness
    // because an additive layer of a dark tint would barely show.
    const dyes = (cached.dyes || []).filter(Boolean);
    const dye = dyes[cardIndex] || dyes[mesh.cci] || dyes[0];
    const rgb = dye?.material_properties?.primary_albedo_tint?.slice(0, 3) || [0.6, 0.8, 1];
    // Full saturation, because an additive layer of a dark tint barely shows — but keep some of the dye's own
    // brightness, so a shader made of two different greys doesn't render both fighters as the same flat white.
    const mx = Math.max(...rgb, 0.001);
    const level = Math.min(1, 0.45 + 0.55 * mx);
    const tint = new THREE.Color((rgb[0] / mx) * level, (rgb[1] / mx) * level, (rgb[2] / mx) * level);

    const mat = new THREE.MeshBasicMaterial({
      map, color: tint, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this._additiveKeepAlpha(THREE, mat);
    // the hologram layers: a banded texture that scrolls (the rolling lines) and a soft ramp
    const stripeName = mesh.textures.find((n) => /height/i.test(n));
    const rampName = mesh.textures.find((n) => n !== name && n !== stripeName);
    const stripe = stripeName ? tex(stripeName) : null;
    const ramp = rampName ? tex(rampName) : null;
    const uniforms = {
      cardHot: { value: CARD_HOT }, cardTime: { value: 0 },
      cardStripe: { value: stripe }, cardStripeAmt: { value: stripe ? CARD_STRIPE_AMT : 0 },
      cardStripeScale: { value: CARD_STRIPE_SCALE }, cardStripeSpeed: { value: CARD_STRIPE_SPEED },
      cardRamp: { value: ramp }, cardRampAmt: { value: ramp ? CARD_RAMP_AMT : 0 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float cardHot;
          uniform float cardTime; uniform sampler2D cardStripe; uniform float cardStripeAmt;
          uniform float cardStripeScale; uniform float cardStripeSpeed; uniform sampler2D cardRamp; uniform float cardRampAmt;`)
        .replace('#include <map_fragment>', `
          // the sprite arrives already redrawn (crisp lines + bloom) — see _renderSprite
          float cardShape = texture2D(map, vMapUv).r;
          // rolling bands travelling up the figure, and the soft ramp, both in the card's own UV space
          float cardBand = cardStripeAmt > 0.0
            ? texture2D(cardStripe, vec2(vMapUv.x, vMapUv.y * cardStripeScale - cardTime * cardStripeSpeed)).r : 0.0;
          float cardShade = cardRampAmt > 0.0 ? texture2D(cardRamp, vMapUv).r : 1.0;
          float cardLit = cardShape * (1.0 + cardStripeAmt * cardBand) * mix(1.0, cardShade, cardRampAmt);
          // the brightest line cores burn toward white in game instead of staying the dye colour
          vec3 cardCol = diffuse * cardLit + vec3(1.0) * pow(cardShape, 6.0) * cardHot;
          diffuseColor = vec4(cardCol, 1.0);`);
    };
    mat.userData.cardTime = uniforms.cardTime;
    mat.customProgramCacheKey = () => 'ghost-shell-d2-card';

    // Does this card hop? Only if its alternate art is drawn higher inside its cell than the base art is — that is
    // what makes the Guardian leap while the enemy stays put.
    const centreOf = (frame) => {
      const x0 = Math.floor((frame * img.w) / frames), x1 = Math.floor(((frame + 1) * img.w) / frames);
      let sum = 0, weight = 0;
      for (let y = 0; y < img.h; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.w + x) * 4;
          const v = ((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3) * (img.data[i + 3] / 255);
          if (v > 18) { sum += y * v; weight += v; }
        }
      }
      return weight ? sum / weight / img.h : 0.5;        // 0 = top of the cell
    };
    const hop = (centreOf(baseFrame) - centreOf(altFrame)) > CARD_HOP_MIN_SHIFT;
    dbg('card', name, 'frames', frames, 'base', baseFrame, 'hop', hop, 'tint', tint.getHexString());
    return { mat, map, frames, baseFrame, altFrame, hop, time: uniforms.cardTime };
  }

  _vfxMaterial(THREE, tex, names, dyes, iconTint, cci) {
    // An effect binds the thing you see (flames, embers, a plate of sparks) plus a softer texture used as a glow
    // or distortion. Draw the shape ON TOP of the soft one rather than picking one: on Blazing Conqueror that is
    // the difference between tendril flames over a pulsing glow, and the glow alone.
    const name = names.find((n) => VFX_SHAPE_RE.test(n)) || names.find((n) => VFX_TEX_RE.test(n));
    const glowName = names.find((n) => n !== name && VFX_TEX_RE.test(n));
    const map = tex(name);
    const glowMap = glowName ? tex(glowName) : null;
    if (!map) { dbg('vfx: texture missing', names); return null; }
    const tint = new THREE.Color();
    // A shell-specific effect layer is dyed like any other part, so its colour is the emissive of the slot the
    // part actually declares (gear_dye_change_color_index). Guessing a fixed slot instead got e.g. Tech Witch's
    // screen red where the game shows cyan. The shared ghost-eye decal is NOT dyed this way — see _eyeMaterial.
    const emit = (typeof cci === 'number' && cci >= 0 && cci <= 5 && dyes?.length)
      ? this._slotEmissive(dyes, cci) || this._eyeTint(dyes)
      : this._eyeTint(dyes);                             // suit emissive, or the default ghost blue
    const mx = Math.max(...emit), mn = Math.min(...emit);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    // A coloured emissive dye is the shell's real effect colour. Failing that, the item icon's dominant colour —
    // which is the only place the colour survives for the 54 shells whose dyes carry no emissive at all, and
    // gives Blazing Conqueror its purple flames. Neutral white-blue is the last resort.
    // …at full brightness. Emissive dyes are often very dark (Blazing Conqueror's is 0.04, 0, 0.28), and an
    // additive layer of that reads as murky rather than as the colour the effect actually shows in game.
    const lift = (c) => { const m = Math.max(...c, 0.001); return [c[0] / m, c[1] / m, c[2] / m]; };
    if (sat > 0.15) { const t = lift(emit); tint.setRGB(t[0], t[1], t[2]); }
    else if (iconTint) tint.setRGB(iconTint[0], iconTint[1], iconTint[2]);
    else tint.setRGB(0.82, 0.88, 1);
    const uniforms = {
      vfxTime: { value: 0 }, vfxTint: { value: tint }, vfxStrength: { value: VFX_STRENGTH },
      vfxGlow: { value: glowMap }, vfxHasGlow: { value: glowMap ? 1 : 0 }, vfxGlowAmt: { value: VFX_GLOW_AMT },
      vfxRise: { value: VFX_RISE },
    };
    const mat = this._additiveKeepAlpha(THREE, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mat.userData.vfxTime = uniforms.vfxTime;
    mat.userData.vfxStrength = uniforms.vfxStrength;   // sprite-card shells pulse this for the clash spark
    Object.assign(mat, { vfxMap: map, vfxGlowMap: glowMap });   // disposed with the material by the companion
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float vfxTime; uniform vec3 vfxTint; uniform float vfxStrength;
          uniform sampler2D vfxGlow; uniform float vfxHasGlow; uniform float vfxGlowAmt; uniform float vfxRise;`)
        .replace('#include <map_fragment>', `
          // the shape drifts upward (flames rise), sampled twice at different rates so it churns rather than slides
          vec2 vfxUv = vMapUv + vec2(vfxTime * 0.035, -vfxTime * vfxRise);
          float vfxA = texture2D(map, vfxUv).r;
          float vfxB = texture2D(map, vMapUv * 1.7 - vec2(vfxTime * 0.02, vfxTime * vfxRise * 0.6)).r;
          float vfxI = max(vfxA, vfxB * 0.6);
          vfxI *= vfxI;                       // favour the bright features of the effect texture, not its whole area
          // the soft texture sits UNDER it as a slow pulsing glow
          float vfxG = 0.0;
          if (vfxHasGlow > 0.5) {
            vfxG = texture2D(vfxGlow, vMapUv * 0.9 + vec2(vfxTime * 0.01, -vfxTime * 0.015)).r;
            vfxG *= 0.75 + 0.25 * sin(vfxTime * 1.7);
          }
          diffuseColor = vec4(vfxTint * (vfxI * vfxStrength + vfxG * vfxGlowAmt * vfxStrength), 1.0);`);
    };
    mat.customProgramCacheKey = () => 'ghost-shell-d2-vfx';
    dbg('vfx layer', name, 'tint', tint.getHexString());
    return mat;
  }

  /** Dominant saturated colour of the shell's icon — the fallback glow colour for shells whose dyes are neutral. */
  async _iconTint(itemHash) {
    try {
      const def = await this._fetchItemDef(itemHash);
      const icon = def?.displayProperties?.icon;
      if (!icon) return null;
      const res = await fetch(BUNGIE_ROOT + icon);
      if (!res.ok) return null;
      const img = await this._decodeImage(new Uint8Array(await res.arrayBuffer()), null);
      if (!img) return null;
      // Averaging every saturated pixel mixes hues toward white — Blazing Conqueror's purple flames averaged with
      // its grey body came out pale pink. Bin by HUE instead, pick the strongest bin, and average only within it.
      const BINS = 24;
      const weightOf = new Float64Array(BINS), sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS);
      // Item icons sit on a solid rarity-coloured background (gold on Exotics) that would otherwise win the vote —
      // sample a corner and skip anything close to it.
      const corner = [img.data[0] / 255, img.data[1] / 255, img.data[2] / 255];
      const x0 = img.w * 0.2 | 0, x1 = img.w * 0.8 | 0, y0 = img.h * 0.2 | 0, y1 = img.h * 0.8 | 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const k = (y * img.w + x) * 4, R = img.data[k] / 255, G = img.data[k + 1] / 255, B = img.data[k + 2] / 255;
        if (Math.abs(R - corner[0]) + Math.abs(G - corner[1]) + Math.abs(B - corner[2]) < 0.25) continue;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
        const sat = mx > 0 ? d / mx : 0;
        if (sat < 0.25 || mx < 0.15) continue;                   // skip greys and near-black: they carry no hue
        let hue = 0;
        if (d > 0) {
          hue = mx === R ? ((G - B) / d + 6) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
          hue /= 6;
        }
        const bin = Math.min(BINS - 1, Math.floor(hue * BINS));
        const weight = sat * mx;                                  // saturated AND bright pixels dominate
        weightOf[bin] += weight; sumR[bin] += R * weight; sumG[bin] += G * weight; sumB[bin] += B * weight;
      }
      let best = 0;
      for (let i = 1; i < BINS; i++) if (weightOf[i] > weightOf[best]) best = i;
      if (weightOf[best] < 1) return null;
      const out = [sumR[best] / weightOf[best], sumG[best] / weightOf[best], sumB[best] / weightOf[best]];
      const mx = Math.max(...out);
      dbg('icon tint', out.map((v) => v.toFixed(2)), 'hue bin', best, 'of', BINS);
      return mx > 0 ? out.map((v) => Math.min(1, v / mx)) : null;
    } catch (e) { dbg('icon tint failed', e?.message || e); return null; }
  }

  /**
   * Render-stage-1 decal layer. Two kinds, told apart by the decal texture's alpha:
   *  - transparent atlas (e.g. gear_non_plated_decals): drawn over the shell with the texture's own colour + alpha
   *  - opaque texture (e.g. weapon_decal_wear): returns 'gear' — the decal geometry is already cut to shape and is
   *    shaded with the shell's gear shader (dye slots), slightly in front of the body
   */
  _decalMaterial(THREE, tex, images, names, cci = 0, dyes = []) {
    const name = names.find((n) => /_dif$/.test(n) && images.has(n)) || names.find((n) => images.has(n));
    const img = name && images.get(name);
    if (!img) { dbg('decal: texture missing', names); return null; }
    let minA = 255;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < minA) { minA = img.data[i]; if (minA < 250) break; }
    const transparent = minA < 250;
    // the part's gear_dye_change_color_index picks which dye colours it (0/1 = Armor P/S, 2/3 = Cloth, 4/5 = Suit)
    const dye = dyes[Math.floor(cci / 2)] || dyes[0];
    const mp = dye?.material_properties || {};
    const tint = (cci % 2 === 0 ? mp.primary_albedo_tint : mp.secondary_albedo_tint) || [1, 1, 1];
    const mat = new THREE.MeshStandardMaterial({
      map: tex(name, true), depthWrite: !transparent, transparent,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      roughness: 0.55, metalness: 0.15, envMapIntensity: 0.85,
    });
    if (transparent) mat.alphaTest = 0.05;
    // Overlay-style: keep the pattern readable, tinted toward the dye colour rather than multiplied to black
    mat.color.setRGB(Math.min(1, 0.35 + tint[0]), Math.min(1, 0.35 + tint[1]), Math.min(1, 0.35 + tint[2]));
    dbg('decal', name, 'cci', cci, 'transparent', transparent, 'tint', tint.map?.((v) => v.toFixed(2)));
    return mat;
  }

  /** The eye tint = the Suit dye's emissive colour (verified: Speed Metal blue, Visionary teal, Hardlink cyan).
   *  Plain white means "no custom eye colour" → the default Ghost blue. */
  /** The emissive tint of one 0-5 dye slot (even = primary, odd = secondary). */
  _slotEmissive(dyes, slot) {
    const mp = (dyes[Math.floor(slot / 2)] || dyes[0])?.material_properties || {};
    const P = slot % 2 === 0 ? 'primary_' : 'secondary_';
    const t = mp[P + 'emissive_tint_color_and_intensity_bias'] || mp[P + 'emissive_tint_color'];
    return Array.isArray(t) ? t.slice(0, 3) : null;
  }

  _eyeTint(dyes) {
    const mp = (dyes[2] || dyes[0])?.material_properties || {};
    const t = mp.primary_emissive_tint_color_and_intensity_bias || mp.emissive_tint_color_and_intensity_bias || mp.primary_emissive_tint_color;
    if (!Array.isArray(t) || (t[0] > 0.95 && t[1] > 0.95 && t[2] > 0.95)) return EYE_DEFAULT_TINT;
    return t.slice(0, 3);
  }

  /**
   * Additive eye iris: main iris mask (mainglow/heart) + soft bloom (iris_wipe), gated by the atest gradient so
   * `eyeOpen` 0→1 wipes the iris closed→open (dark gradient edges vanish first). MeshBasicMaterial keeps
   * three's skinning/transform chunks for later bone animation.
   */
  _eyeMaterial(THREE, tex, names, dyes) {
    const main = tex(names.find((n) => EYE_MAIN_RE.test(n)));
    if (!main) { dbg('eye: main iris texture missing', names); return null; }
    const wipe = tex(names.find((n) => /iris_wipe/.test(n))) || main;
    const atest = tex(names.find((n) => /atest/.test(n)));
    // The iris is ALWAYS Bungie's shared decal set (the 3056805642_ghost_eye_decal_* textures are the mainglow
    // on all 538 shells), so it is not dyed per part the way a shell's own effect layer is — its colour is the
    // ghost's projection colour, which _eyeTint approximates from the dyes.
    const tint = this._eyeTint(dyes);
    const mat = this._additiveKeepAlpha(THREE, new THREE.MeshBasicMaterial({
      map: main, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    mat.color.setRGB(tint[0], tint[1], tint[2]);
    const uniforms = {
      eyeWipe: { value: wipe }, eyeAtest: { value: atest || main }, eyeHasAtest: { value: atest ? 1 : 0 },
      eyeOpen: { value: 1 }, eyeIntensity: { value: 0.75 },
      // the brightest part of the iris burns toward white like a lit gem instead of staying a flat neon tint —
      // measured against an in-game capture the eye should read rgb(122,192,173), not the raw dye's rgb(46,223,217)
      eyeWhiten: { value: (typeof window !== 'undefined' && window.__GHOST_EYE_WHITEN) ?? EYE_WHITEN },
    };
    mat.userData.eyeUniforms = uniforms;
    Object.assign(mat, { eyeWipe: wipe, eyeAtest: atest });   // disposed with the material by the companion
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D eyeWipe;\nuniform sampler2D eyeAtest;\nuniform float eyeHasAtest;\nuniform float eyeOpen;\nuniform float eyeIntensity;\nuniform float eyeWhiten;')
        .replace('#include <map_fragment>', `
          float irisMain = texture2D(map, vMapUv).r;
          float irisBloom = texture2D(eyeWipe, vMapUv).r;
          float irisGate = eyeHasAtest > 0.5
            ? smoothstep(1.0 - eyeOpen - 0.06, 1.0 - eyeOpen + 0.06, texture2D(eyeAtest, vMapUv).r + 0.06)
            : eyeOpen;
          float irisGlow = (irisMain * irisGate + irisBloom * 0.35 * eyeOpen) * eyeIntensity;
          float irisCore = pow(clamp(irisMain * irisGate, 0.0, 1.0), 2.5);
          vec3 irisCol = mix(diffuseColor.rgb, vec3(1.0), irisCore * eyeWhiten);
          diffuseColor = vec4(irisCol * irisGlow, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'ghost-shell-d2-eye';
    dbg('eye material', names, 'tint', tint);
    return mat;
  }

  /**
   * MeshStandardMaterial patched into the D2 gear dye shader. Falls back to a plain grey metal when the
   * shell's body plate textures are missing. Textures are also set as material properties so the
   * companion's dispose pass (which walks material keys) frees them.
   */
  /**
   * Is this dyeslot plate actually a slot MASK? Bungie's own exporter has a manual "uses dyeslot texture" toggle,
   * because on many shells that plate holds something else (a soft wear/blend map). Thresholding a non-mask at 0.5
   * scatters texels randomly across the six dye slots — that is what made e.g. Clean Lines a pink/teal jumble.
   * A real mask is near-binary per channel, so require most texels to sit at an extreme.
   */
  _dyeslotIsMask(img) {
    if (!img) return false;
    const n = img.w * img.h, step = Math.max(1, Math.floor(n / 4096));
    let binary = 0, total = 0;
    for (let i = 0; i < n; i += step) {
      for (let c = 0; c < 3; c++) { const v = img.data[i * 4 + c]; if (v <= 24 || v >= 232) binary++; total++; }
    }
    const ratio = total ? binary / total : 0;
    dbg('dyeslot mask test', ratio.toFixed(2), ratio >= 0.85 ? '→ used' : '→ ignored (not a mask)');
    return ratio >= 0.85;
  }

  // Per-vertex dye slot fed to the shader. Two sources exist: the vertex normal's slot bits and the part's
  // gear_dye_change_color_index. Bungie's older web loaders use the part index alone, but for these assets that
  // is wrong — driving the slot from it flattens panels to a single dye (measured 0.96 vs 0.66 against in-game
  // screenshots across 24 shells, and visibly black where the game shows colour). The vertex bits are correct;
  // the part index is kept only so the comparison can be re-run with ?slotmode=part.
  _dyeSlots(mesh) {
    const mode = (typeof window !== 'undefined' && window.__GHOST_SLOT_MODE) || 'vertex';
    const bias = (typeof window !== 'undefined' && Number(window.__GHOST_SLOT_BIAS)) || 0;
    if (bias) { const b = new Float32Array(mesh.slots.length); for (let i = 0; i < b.length; i++) b[i] = mesh.slots[i] + bias; return b; }
    if (mode === 'vertex' || !mesh.cciSlots) return mesh.slots;
    const out = new Float32Array(mesh.slots.length);
    for (let i = 0; i < out.length; i++) { const c = mesh.cciSlots[i]; out[i] = c >= 0 ? c : mesh.slots[i]; }
    return out;
  }

  // Is this mesh's dominant dye a metal? Vertex slot bits are 0-based (0 Armor primary … 5 Suit secondary);
  // even slots read the dye's primary_* block, odd its secondary_*, and w of material_params is metalness.
  //
  // NO LONGER USED for the glass/solid decision — it was wrong on 10 of the 14 shells it was checked against,
  // because dye metalness doesn't distinguish a glass canopy from a solid mane. That call now comes from the
  // 'opaque-pane' group in shell-groups.js. Kept because "is this surface metallic" is a genuinely useful test
  // and other rules may want it.
  _dyeIsMetal(mesh, dyes) {
    const slots = mesh.slots;
    if (!slots || !slots.length || !dyes?.length) return false;
    const counts = new Array(6).fill(0);
    for (let i = 0; i < slots.length; i++) counts[Math.min(5, Math.max(0, Math.round(slots[i])))]++;
    let si = 0;
    for (let s = 1; s < 6; s++) if (counts[s] > counts[si]) si = s;
    const mp = (dyes[Math.floor(si / 2)] || dyes[0])?.material_properties || {};
    const params = mp[(si % 2 === 0 ? 'primary_' : 'secondary_') + 'material_params'];
    return Array.isArray(params) && params.length > 3 && params[3] > 0.5;
  }

  _shellMaterial(THREE, tex, plates, dyes, { translucent = false, glass = false, coat = false, images = null } = {}) {
    const diffuse = tex(plates?.diffuse), gearstack = tex(plates?.gearstack);
    if (!diffuse || !gearstack) {
      dbg('missing body plate textures → plain material', plates);
      return new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.4 });
    }
    const normal = tex(plates.normal), dyeslot = tex(plates.dyeslot);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: 0.85 });
    if (normal) { mat.normalMap = normal; mat.normalScale = new THREE.Vector2(1, -1); }
    if (translucent) {
      // render-stage-7 pieces: same dye logic, but see-through + lit from within by the slot's emissive dye tint
      Object.assign(mat, { transparent: true, depthWrite: false, side: THREE.DoubleSide });
      mat.defines = { ...(mat.defines || {}), SHELL_TRANSLUCENT: '' };
    }
    if (coat) {
      // lacquered solid surface (clear-coat / cubemap parts): opaque, but smoother and more reflective
      Object.assign(mat, { envMapIntensity: 1.3 });
      mat.defines = { ...(mat.defines || {}), SHELL_COAT: '' };
    }
    if (glass) {
      // canopies: mostly clear, picking up reflections and edge sheen rather than showing the plate art
      Object.assign(mat, { transparent: true, depthWrite: false, side: THREE.FrontSide, envMapIntensity: 1.1 });
      mat.defines = { ...(mat.defines || {}), SHELL_GLASS: '' };
    }

    const v3 = (a, d) => new THREE.Vector3(...((Array.isArray(a) ? a : d).slice(0, 3)));
    const v4 = (a, d) => new THREE.Vector4(...((Array.isArray(a) ? a : d).slice(0, 4)));
    const u = {
      shellDiffuse: { value: diffuse }, shellGearstack: { value: gearstack },
      shellDyeslot: { value: dyeslot || gearstack }, shellHasDyeslot: { value: dyeslot ? 1 : 0 },
      shellDetailXform: { value: [] }, shellHasDetail: { value: [] },
      shellDetailNrmXform: { value: [] }, shellHasDetailNrm: { value: [] },
      shellAlbedo: { value: [] }, shellWornAlbedo: { value: [] }, shellWearRemap: { value: [] },
      shellParams: { value: [] }, shellWornParams: { value: [] }, shellAdvParams: { value: [] },
      shellRoughRemap: { value: [] }, shellWornRoughRemap: { value: [] }, shellEmissive: { value: [] }, shellEmitGate: { value: [] },
      shellGlowPulse: { value: 1 },
      shellEmitGamma: { value: (typeof window !== 'undefined' && window.__GHOST_EMIT_GAMMA) || EMIT_GAMMA },
    };
    for (let d = 0; d < 3; d++) {
      const dye = dyes[d] || dyes[0];
      const detail = tex(dye?.textures?.diffuse?.name);
      u['shellDetail' + d] = { value: detail || diffuse };
      if (detail) mat['shellDetail' + d] = detail;
      u.shellHasDetail.value.push(detail ? 1 : 0);
      u.shellDetailXform.value.push(v4(dye?.material_properties?.detail_diffuse_transform, [1, 1, 0, 0]));
      // detail NORMAL: the fine surface grain (carbon fibre, speckle, brushing) Bungie layers over the plate normal
      const detailN = tex(dye?.textures?.normal?.name);
      u['shellDetailNrm' + d] = { value: detailN || normal || diffuse };
      if (detailN) mat['shellDetailNrm' + d] = detailN;
      u.shellHasDetailNrm.value.push(detailN && normal ? 1 : 0);
      u.shellDetailNrmXform.value.push(v4(dye?.material_properties?.detail_normal_transform, [1, 1, 0, 0]));
    }
    for (let s = 0; s < 6; s++) {
      const mp = (dyes[Math.floor(s / 2)] || dyes[0])?.material_properties || {};
      const P = s % 2 === 0 ? 'primary_' : 'secondary_';
      u.shellAlbedo.value.push(v3(mp[P + 'albedo_tint'], [0.5, 0.5, 0.5]));
      u.shellWornAlbedo.value.push(v3(mp[P + 'worn_albedo_tint'], mp[P + 'albedo_tint'] || [0.5, 0.5, 0.5]));
      u.shellWearRemap.value.push(v4(mp[P + 'wear_remap'], [1, 0, 0, 1]));               // default → always "fresh"
      u.shellParams.value.push(v4(mp[P + 'material_params'], [0, 0, 0, 0]));
      u.shellWornParams.value.push(v4(mp[P + 'worn_material_parameters'], mp[P + 'material_params'] || [0, 0, 0, 0]));
      u.shellAdvParams.value.push(v4(mp[P + 'material_advanced_params'], [0, 0, 0, 0]));
      u.shellRoughRemap.value.push(v4(mp[P + 'roughness_remap'], [0, 1, 0, 1]));
      u.shellWornRoughRemap.value.push(v4(mp[P + 'worn_roughness_remap'], mp[P + 'roughness_remap'] || [0, 1, 0, 1]));
      const emitTint = v3(mp[P + 'emissive_tint_color_and_intensity_bias'] || mp[P + 'emissive_tint_color'], [0, 0, 0]);
      // Bungie lets this tint run far above 1 (values up to ~15) because in game it feeds an HDR bloom pass.
      // We have no bloom, so an uncapped tint just clips to a flat blown-out colour. Keep the hue, cap the level.
      const emitMax = (typeof window !== 'undefined' && window.__GHOST_EMIT_MAX) || 2.0;
      const mxT = Math.max(emitTint.x, emitTint.y, emitTint.z);
      if (mxT > emitMax) emitTint.multiplyScalar(emitMax / mxT);

      u.shellEmissive.value.push(emitTint);
      // saturation of the emissive tint: 0 for a neutral placeholder, ~1 for a real glow colour
      const mxE = Math.max(emitTint.x, emitTint.y, emitTint.z), mnE = Math.min(emitTint.x, emitTint.y, emitTint.z);
      u.shellEmitGate.value.push(mxE > 0 ? (mxE - mnE) / mxE : 0);
    }
    Object.assign(mat, { shellDiffuse: diffuse, shellGearstack: gearstack, shellDyeslot: dyeslot });
    // spike extend/retract (active only when _buildGroup adds the SHELL_MORPH define + attributes)
    u.shellMorphK = { value: new THREE.Vector4(0, 0, 0, 0) };   // x: short extend, y: long retract, z: short retract
    mat.userData.morphUniform = u.shellMorphK;
    // spinning rotors (see _rotorSpin); only bound when the mesh carries the attributes
    u.shellRotorAngle = { value: 0 };
    mat.userData.rotorUniform = u.shellRotorAngle;
    // data-driven animation drive (see _ddAnim); only bound when the mesh carries the attributes
    u.shellDdK = { value: new THREE.Vector3(0, 0, 0) };
    u.shellDdSeq = { value: new THREE.Vector3(0, 0, 0) };
    u.shellDdHead = { value: new THREE.Vector3(0, 0, 0) };
    mat.userData.ddUniforms = { k: u.shellDdK, seq: u.shellDdSeq, head: u.shellDdHead };
    mat.userData.glowUniform = u.shellGlowPulse;
    mat.userData.shell = true;   // marks materials that carry the dye block (used by the debug harness)
    mat.userData.shellUniforms = u;   // debug harness can zero individual dye terms to attribute a colour

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + SHELL_VERTEX_PARS)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDyeSlot = dyeSlot;\nvShellUv = uv;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef SHELL_MORPH
  // short set travels out along its fan; both sets pull back toward their cluster base
  float shellRetract = morphGroup > 0.5 ? shellMorphK.z : (morphGroup < -0.5 ? shellMorphK.y : 0.0);
  transformed += morphDir * morphLen * (morphGroup > 0.5 ? shellMorphK.x : 0.0);
  transformed -= morphRetDir * morphRetLen * shellRetract;
#endif
#ifdef SHELL_ROTOR
  // spin this vertex about its own rotor's hub and axis (Rodrigues); rotorDir carries the direction, 0 = not a rotor
  if (abs(rotorDir) > 0.5) {
    float rotA = shellRotorAngle * rotorDir;
    vec3 rotRel = transformed - rotorHub;
    vec3 rotAx = normalize(rotorAxis);
    transformed = rotorHub + rotRel * cos(rotA) + cross(rotAx, rotRel) * sin(rotA)
                + rotAx * dot(rotAx, rotRel) * (1.0 - cos(rotA));
  }
#endif
#ifdef SHELL_DDANIM
  float ddD = ddAmt.x * shellDdDrive(shellDdK.x, shellDdSeq.x, shellDdHead.x, ddPhase.x)
            + ddAmt.y * shellDdDrive(shellDdK.y, shellDdSeq.y, shellDdHead.y, ddPhase.y)
            + ddAmt.z * shellDdDrive(shellDdK.z, shellDdSeq.z, shellDdHead.z, ddPhase.z);
  transformed += ddDir * ddD;
#endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + SHELL_FRAGMENT_PARS)
        .replace('#include <map_fragment>', SHELL_ALBEDO)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(shellRoughness, 0.04, 1.0);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(shellMetalness, 0.0, 1.0);')
        .replace('#include <normal_fragment_maps>', SHELL_NORMAL)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += shellEmit;
#ifdef SHELL_GLASS
// clear in the middle, brighter at grazing angles (needs the shaded normal, so it happens here)
float shellFresnel = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.2);
diffuseColor.a = clamp(0.06 + 0.55 * shellFresnel, 0.05, 0.75);
#endif`)
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= shellAO;\nreflectedLight.indirectSpecular *= shellAO;');
    };
    mat.customProgramCacheKey = () => 'ghost-shell-d2-gear';
    return mat;
  }

  /**
   * Build the equipped Ghost shell as a THREE.Group, or null to fall back to the bundled GLB.
   * @param {*} THREE the three.js module the companion already loaded.
   */
  async loadEquippedShell(THREE) {
    try {
      const ghost = this.getEquippedGhost();
      const hash = ghost?.itemHash;
      if (!hash) { dbg('no equipped ghost (not logged in / no profile yet)'); return null; }
      const cacheKey = `${hash}:${ghost.shaderHash || 0}`;

      let cached = this._shellCache.get(cacheKey);
      if (!cached) {
        const entry = await this._getGearEntry(hash);
        const content = (entry?.content || []).find((c) => Array.isArray(c.geometry) && c.geometry.length);
        if (!content) { dbg('no geometry content for', hash); return null; }

        const gear = entry.gear?.[0] ? await this._fetchMetadata(entry.gear[0]) : null;
        const { dyes, shaderContent } = await this._resolveDyes(hash, gear, ghost.shaderHash);
        dbg('dyes by slot', dyes.map((d) => d && d.slot_type_index), 'shader', ghost.shaderHash);

        // each geometry container is self-contained: its buffers + an embedded render_metadata.js
        const meshes = [];
        const needed = new Set();                 // inner texture names to fetch
        const plateDefs = new Map();              // plate image key → { key, def }
        for (const d of dyes) { for (const k of ['diffuse', 'normal']) { const n = d?.textures?.[k]?.name; if (n) needed.add(n); } }
        await Promise.all(content.geometry.map(async (fileName) => {
          try {
            const tgxm = this._parseTGXM(await this._fetchGeometry(fileName));
            if (!tgxm) return;
            const metaName = Object.keys(tgxm.files).find((n) => /render_metadata/i.test(n));
            if (!metaName) { dbg('container has no render_metadata.js', fileName); return; }
            const metadata = JSON.parse(this._bufferText(this._bufferBytes(tgxm, metaName)));
            const buffers = {};
            for (const n in tgxm.files) buffers[n] = this._bufferBytes(tgxm, n);
            for (const rm of (metadata.render_model?.render_meshes || [])) rm._buffers = buffers;
            const defs = this._plateDefs(metadata);
            let plates = null;
            if (defs) {
              plates = {};
              for (const key in defs) {
                const imgKey = `plate:${key}:${defs[key].reference_id || fileName}`;
                plates[key] = imgKey;
                plateDefs.set(imgKey, { key, def: defs[key] });
                for (const pl of defs[key].texture_placements) needed.add(pl.texture_tag_name);
              }
            }
            dbg('plates', fileName, defs && Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.texture_placements.length])));
            for (const d of this._decodeMeshes(metadata)) {
              if (d.kind === 'eye' || d.kind === 'decal' || d.kind === 'vfx' || d.kind === 'card') for (const n of d.textures) needed.add(n);
              meshes.push({ ...d, plates });
            }
          } catch (e) { dbg('geometry file failed', fileName, e?.message || e); }
        }));
        if (!meshes.length) { dbg('decoded 0 meshes for', hash); return null; }

        // shader detail textures live in the SHADER's texture containers, so search those too
        const images = await this._loadTextures([content, shaderContent], needed);
        for (const [imgKey, { key, def }] of plateDefs) {
          const plate = this._stitchPlate(key, def, images);
          if (plate) images.set(imgKey, plate);
          else dbg('plate stitch failed', imgKey);
        }
        // keep only what materials sample directly: stitched plates, dye detail textures, eye + decal textures
        const keep = new Set(dyes.map((d) => d?.textures?.diffuse?.name).filter(Boolean));
        for (const d of dyes) { const n = d?.textures?.normal?.name; if (n) keep.add(n); }
        for (const mm of meshes) if (mm.kind === 'eye' || mm.kind === 'decal' || mm.kind === 'vfx' || mm.kind === 'card') mm.textures.forEach((n) => keep.add(n));
        for (const [name] of images) { if (!name.startsWith('plate:') && !keep.has(name)) images.delete(name); }
        // Where does an effect layer get its colour? From an emissive dye when the shell has one. Every shell with
        // an effect layer that was scanned (54 of 580) has NO emissive dye at all, so the fallback matters: take
        // the dominant colour of the item icon, which is what the effect reads as in game (Blazing Conqueror's
        // purple tendril flames). The old test looked at _eyeTint, which answers with the default ghost blue when
        // there is no emissive — so it never fired, and every effect came out blue.
        const needsTint = meshes.some((m) => m.kind === 'vfx');
        const emissive = dyes.some((d) => {
          const mp = d?.material_properties || {};
          return ['primary_emissive_tint', 'secondary_emissive_tint']
            .some((k) => Array.isArray(mp[k]) && mp[k].slice(0, 3).some((v) => v > 0.02));
        });
        const vfxTint = needsTint && !emissive ? await this._iconTint(hash) : null;
        cached = { meshes, dyes, images, vfxTint, hash };   // hash: shell-groups.js decisions are per shell
        this._shellCache.set(cacheKey, cached);
      }

      const group = this._buildGroup(THREE, cached);
      dbg('built shell model', hash, 'meshes:', group.children.length);
      return group.children.length ? group : null;
    } catch (e) {
      console.warn('[ghost-shell] loadEquippedShell failed:', e?.message || e);
      return null;
    }
  }
}

export const ghostShellSource = new GhostShellSource();
export default ghostShellSource;
