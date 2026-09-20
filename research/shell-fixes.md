# Shell rendering fixes — porting log

Every fix made to the shell renderer in DeskGhost, with where the data came from and how it was verified, so the
whole batch can be ported back to the Sick on Tuesdays site in one pass later.

**The renderer is shared.** `DeskGhost/src/ghost/ghost-shell-source.js` is a port of the site's
`sick-on-tuesday/js/ghost/ghost-shell-source.js`; `reference/js-ghost/` holds the snapshot the port was made from.
To port: diff each fix below into the site file. Fixes are self-contained and marked with the constants/functions
they touch.

**Porting status**

| # | Fix | Shells affected | In DeskGhost | In the site |
|---|---|---|---|---|
| 1 | Eye position/size (double-applied vertex scale) | 169 | ✅ | ✅ (applied at the user's request 2026-09-19) |
| 2 | Additive layers no longer add alpha | all with eye/VFX/card layers | ✅ | ⬜ |
| 3 | Arena Shell's duelling fighters (sprite cards) | 1 (generic rule) | ✅ | ⬜ |
| 4 | Peaceful Shell's propellers don't spin | 1 so far (generic rule) | ✅ | ⬜ |
| 5 | Glass panes forced solid by a bad global rule | 26 (10 confirmed wrong) | ✅ | ⬜ |
| 6 | Effect layers barely visible, wrong texture, wrong colour | 54 | ✅ | ⬜ |

**Earmarked:** come back to Arena's fighters after the other shells — techniques found there may improve them.

---

## 1. Eye in the wrong place and the wrong size — 169 shells

**Symptom:** the eye sphere floated in front of / under / behind the shell, and was too small. Worst cases: the
five Courier shells (4.4 body-lengths away), Buoy, Contender's, Cottontail, Trusty, Tastemaker.

**Cause:** `_decodeMeshes` multiplied each vertex by the mesh's `position_scale` and added `position_offset`, but
the stored floats are already final coordinates — those two fields merely *describe* the bounds (verified: a file's
raw centre equals its `position_offset`, its raw extent is ±`position_scale`). Within one file this is invisible
(uniform shrink + shift), but a shell whose eye comes from a **different region file** gets a different scale, so
the eye ends up shrunken and displaced by the body file's offset.

**Where the data lives:** each shell's `region_index_sets` in its gear asset entry maps regions to model files —
region 20 = shell body, region 21 = Bungie's standard eye core (built at the model origin), region 22 = empty on
mobile. Self-contained shells (Speed Metal etc.) carry their eye inside region 20 and were never affected.

**Fix:** use the float positions as stored (`ghost-shell-source.js`, `_decodeMeshes`, ~line 663).

**Verified:** re-decoded all 580 shells — worst region-21 eye offset dropped 4.41 → 0.24 body-lengths, and the
standard eye now measures the same 0.0628 on nearly every shell instead of varying 0.0015–0.0059 with each file's
scale. Previews of Buoy, Cottontail, City Courier, Contender's, Painted Eye correct. Spike detection unchanged
(Speed Metal 2.47, Quicksilver Squall 2.22). Full list: `research/eye-misaligned-shells.tsv`.

**Note for porting:** model coordinates are now 10–30× larger than before. Everything in the renderer works in
relative units, so nothing else needed changing — but new code must stay scale-relative.

---

## 2. Additive layers turned transparent backgrounds black

**Symptom:** on a transparent canvas (the desktop overlay), eye/VFX/sprite layers painted a solid black rectangle.
Most visible on Arena Shell's spark quad.

**Cause:** Destiny's effect textures are **opaque black** around the art. `THREE.AdditiveBlending` adds alpha as
well as colour, so those opaque-black texels accumulate alpha and make the canvas opaque where the quad sits.

**Fix:** new `_additiveKeepAlpha()` helper — CustomBlending with `blendSrc/blendDst = One` (additive colour) and
`blendSrcAlpha = Zero, blendDstAlpha = One` (destination alpha untouched). Applied to `_cardMaterial`,
`_vfxMaterial` and `_eyeMaterial`.

**Verified:** Arena Shell's black rectangle gone in the picker preview and on the desktop overlay. Looks identical
on opaque backgrounds, so the site (which renders over a page) sees no visual change — but port it anyway for
consistency.

---

## 3. Arena Shell — the duelling Guardian and Rhulk

**Shell:** Arena Shell, hash `2609270227`.

**Symptom:** a flat squarish panel above the shell, mostly green with some blue, instead of the animated
Guardian-vs-Rhulk duel.

**Cause:** the two fighter quads are stage-7 parts carrying the data-driven flag (`0x2000`), so the decoder grouped
them with "solid translucent bodies" (Lunar's moon, IX's tendrils) and painted them with the shell's body texture
plate — hence the green/blue smear.

**Where the data lives** (all inside the shell's own files, no extra downloads):

| What | Where |
|---|---|
| Guardian sprite strip | texture `2748596038_ghost_exotic_v960_charity_tournament_fighters_hunter_dif`, 128×64 = two 64×64 poses |
| Rhulk sprite strip | texture `2748596038_ghost_exotic_v960_charity_tournament_fighters_rhulk_dif`, 128×64 |
| Clash spark | texture `4185895630_spark_flare_01`, on stage-7 part 33 (already handled as a VFX layer) |
| The cards | `render_metadata.js` in geometry `7bdca7c39d985628de83c02422afd83b.tgxm`: stage-7 parts 21 (Guardian) and 25 (Rhulk), flags `0x6015`, LOD 0 |
| Colours | the shell's own dyes: slot 0 primary albedo = pure blue (Guardian), slot 1 = crimson (Rhulk). The sprites are greyscale line art |

Each card's UVs cover **half** its texture (u 0.492–0.991 = frame 1). The game animates by sliding the UVs; there
is no animation data in the file (the part has no data-driven vertex buffer), so the motion lives in Bungie's own
shader and had to be measured.

**Timing** — measured frame by frame from in-game footage (`Screen Recording 2026-09-19 200506.mp4`, 30 fps;
steady stretch frames 178–537; pose changes at frames 191, 209, 251, 269, 310, 329):

| | |
|---|---|
| Loop | 60 frames = **2.00 s** |
| Base frame (the strike/clash, the UVs as authored) | 42 frames = **1.40 s** |
| Alternate frame (the leap) | 18 frames = **0.60 s** |
| Guardian's hop during the leap | up over ~5 frames (0.17 s), hold ~11, down over 2–3 frames (0.08 s); ≈25% of the card's height |
| Clash spark | fires when the base frame returns (the impact): bright ~5 frames, gone by 9 (0.30 s) |

Rhulk does not move vertically — and the data agrees: the Guardian's leap frame is drawn 9.5% higher inside its
cell, Rhulk's two frames are level (measured from the textures).

**The fighters are holograms, and each card binds THREE textures — all three matter:**

| Texture | What it is | How it's used |
|---|---|---|
| `…fighters_<hunter\|rhulk>_dif` | the figure, 128×64 greyscale line art, alpha solid | the shape |
| `4159691100_exo_destruct_gradient_a_height` | horizontal white bands on black | scrolled up the card = the rolling/pulsing lines |
| `2653586342_verb_varied_gradient_dif` | soft bottom-up ramp | available, currently unused (see below) |

Checked: the sprite's R, G and B are identical (a greyscale image, not three packed layers), its alpha is solid
255, and of the shell's 23 textures only those two contain figures. **There is no separate outline layer.**

**Why the art can't simply be drawn as-is:** Bungie's API only serves the **mobile** texture set, so a figure the
game draws from a large texture reaches us as 64×64 of soft, faint anti-aliased line work. Drawn straight it is
blurry; thresholded it falls apart.

**`_renderSprite()` rebuilds the strip once on load** (nothing is shipped — it is derived from Bungie's own
texture on the user's machine, same as every other shell file):
1. bicubic upscale ×`CARD_UPSCALE`, clamped inside each frame so neighbouring poses can't bleed together
2. unsharp mask (`CARD_SHARPEN`) — line centres climb, the soft skirt falls back to black
3. floor (`CARD_FLOOR`, also kills the value-5 border baked around Rhulk that otherwise draws a box) and a
   compressive curve (`CARD_KNEE`, `CARD_GAIN`) that lifts faint work without blobbing the denser sprites
4. a blurred copy added back as bloom (`CARD_BLOOM`) — how the hologram reads in game

Detail the 64px art never had still isn't there, but its lines come out sharp instead of smeared. Values that
matched the reference best: `UPSCALE 4, SHARPEN 2.2, FLOOR 0.05, KNEE 0.12, GAIN 1.6, BLOOM 0.6`, plus in-shader
`HOT 0.7` (white-hot core on the brightest lines) and `STRIPE_AMT 0.6 / SCALE 1.6 / SPEED 0.22` (rolling bands).
`RAMP_AMT 0` — the soft ramp is black at the top, so shading the figure with it eats the upper body; off until its
real use is known.

**Frame-edge bleed (fixed).** A card's UVs sit hard against its frame's edge, so as soon as they are slid to show
the other frame the edge lands just outside the strip. With `RepeatWrapping` that sampled the far end of the strip
and Arena's Guardian picked up his own sword tip as a glowing speck beside him. The rebuilt sprite is
`ClampToEdgeWrapping`, and the bloom blur is kept inside each frame so one pose can't glow into the next.

**Shaders still apply.** The rebuild only touches the shape; colour comes from the dye slots at material-build
time, so an applied shader recolours the fighters through the normal dye path (verified: no shader → blue/pink,
Angel's Gleam → red/blue, a grey shader → two greys). Tints are pushed to full saturation, because an additive
layer of a dark tint barely shows, but keep part of the dye's own brightness so a shader of two different greys
doesn't flatten both fighters to the same white.

**Fix (generic, not shell-specific):**
- `_decodeMeshes`: a data-driven stage-7 part with its own static texture whose UVs cover only part of that texture
  (uSpan 0.1–0.85, vSpan > 0.6) is a **sprite card** → new kind `card`, one mesh per card. Everything else
  data-driven stays `translucent`.
- `_cardMaterial()`: frames = round(1 / uSpan), cross-checked against the image being that many times wider than
  tall; per-card texture clone so each card's frames slide independently; additive-keep-alpha; tint = successive
  dye slots' primary albedo, normalised to full brightness; hop enabled only when the alternate frame's art is
  drawn ≥4% higher in its cell than the base frame's.
- `group.userData.cards.set(t)` runs the loop (constants `CARD_*` at the top of the file); driven each frame from
  `ghost-companion.js` `_updateRig` and from the picker preview (`preview.js`).

**Why this is safe for other shells:** scanned all 580 — 26 others have data-driven stage-7 parts with their own
textures, but those are noise/gradient effects whose UVs cover the **whole** texture, so the rule doesn't fire on
them. Arena is the only shell with a partial-UV card.

**Verified:** picker preview shows both poses alternating with the Guardian hopping, tinted blue and crimson as
in-game; desktop overlay shows the same with no black rectangle. Compared against the reference video frames.

---

## 4. Peaceful Shell — the propellers don't spin

**Shell:** Peaceful Shell, hash `95483422` (internally "search_n_rescue" — the model is a quadcopter drone).

**Symptom:** the four rotors sat still.

**Where the data lives:** geometry `374cdf54222eb3ce4476e8ea1a70a361.tgxm`, body stage-0 parts 0 and 16, flags
`0x6005` (the `0x2000` bit = the part reads the mesh's `data_driven_vertex_buffer`). No textures involved — this
is pure vertex animation, and as always Bungie ships the per-vertex masks but not the motion, which lives in their
own shader.

The two flat plates sit on top of the shell (z +0.051, y ±0.056), each 0.0043 thin against 0.16 long. Each plate's
mask channels split it into **two** groups, at x +0.043 and −0.049 — so four rotors in total, front and back on
each side: a quadcopter. Each group's blades reach out to radius 0.084 about its own hub, and the thin axis is Z,
so they turn about the vertical.

**Fix (generic, `_rotorSpin()`):** a data-driven part that is a flat plate, whose animation masks split it into
blade-like groups (each reaching further out than it is wide, and well beyond the plate's thickness), is a
propeller assembly. Every mask group becomes its own rotor turning about its own hub and the plate's normal —
distinct masks mean independently driven pieces, which is exactly how this shell ends up with four.

Directions follow a real quadcopter: adjacent rotors counter-rotate, so diagonally opposite ones match. That falls
straight out of the sign of the product of each hub's offsets from the assembly centre in the rotor plane.
Verified: front-left and back-right counter-clockwise, front-right and back-left clockwise, 1,744 vertices each
way. Speed is `ROTOR_RPS` (3.0 turns/second) — fast, but short of blurring the blades together, which is how the
user describes it in game.

**Rendering:** `SHELL_ROTOR` define + `rotorHub` / `rotorAxis` / `rotorDir` attributes on the body mesh, and a
`shellRotorAngle` uniform; the vertex shader rotates each vertex about its own rotor (Rodrigues). Driven from
`group.userData.rotor.set(t)` in `ghost-companion.js` and `preview.js`. Takes precedence over the general
data-driven animation for that mesh, but not over the hand-verified spike morph (Speed Metal).

**Verified:** parked the Ghost, stepped the rotor angle, and compared frames — blades turn, in the directions
above. Not yet checked against in-game footage for exact speed.


---

## 5. Glass panes rendered as solid metal

**Symptom:** shells with glass domes, canopies, lenses and windows rendered them as opaque surfaces.

**Cause:** a rule in the renderer (`_dyeIsMetal`, present in the website's copy too) treated any stage-7 pane
whose dominant dye is metallic as a lacquered solid. Dye metalness does not distinguish a glass canopy from a
solid mane, so it got most of them wrong.

**Scan:** 74 of 580 shells have a stage-7 pane; the rule forced 26 of them solid. Each was rendered with the pane
highlighted (`tools/pane-shots.js`) and compared against its item icon:

| Verdict | Count | Examples |
|---|---|---|
| Should be glass — rule wrong | 10 | Clean Lines (canopy), Hard Light (lens), E99 (whole egg), ROV (window), Andromeda, Retrophoto, Phantasmal, Eco-Ethical, Hareball (ears), Deep Whisper (wisps) |
| Correctly solid | 4 | Wintry Neigh-bor (mane), Wish-Maker (ribbons), Belle Air (pods), Exquisite Point (cap) |
| Small panes, not yet checked | 12 | 45–300 tris, mostly lens covers; glass by default |

**Fix:** panes are glass by default; the exceptions live in the `opaque-pane` group in `src/ghost/shell-groups.js`
(see `research/shell-groups.md`). `_dyeIsMetal` is kept but no longer decides this.

**Verified:** Clean Lines shows a clear canopy over its body again, ROV's window shows the eye inside, E99 and
Hard Light are glass; Wintry Neigh-bor's mane and Wish-Maker's ribbons stay solid.

**Porting note:** this one removes behaviour that exists in the site's file today. Port `shell-groups.js` with it.


---

## 6. Effect layers — flames, embers, smoke (54 shells)

**Example:** Blazing Conqueror (`3850767909`, internally "heartshadow") should have purple flames at the tips of
its tendrils. We drew a faint pulsing glow instead.

**Where the data lives:** the effect is a stage-7 VFX part — 705 tris wrapping the shell — carrying two textures:
`2895888787_fire_plate_med` (the flames) and `327503503_cloudy_swirl_1_dif` (a soft swirl). No animation data: as
always the motion lives in Bungie's shader, so ours approximates it.

**Four things were wrong:**

| Problem | Fix |
|---|---|
| We sampled the *first* matching texture — the swirl — so the flame shape never appeared | `VFX_SHAPE_RE` prefers the shape texture (fire/flame/ember/spark/smoke/lightning/`_plate`); the other texture becomes the glow |
| The soft texture was the only thing drawn, reading as a pulsing glow | Both are drawn: shape on top, soft one **under** it as a slow pulsing glow (`VFX_GLOW_AMT`) |
| Effects were nearly invisible at strength 0.28 | `VFX_STRENGTH` 0.75, and the shape drifts upward (`VFX_RISE`) so flames rise |
| Colour came out murky indigo, and the icon fallback picked gold | Emissive dyes are lifted to full brightness (Blazing's is 0.04, 0, 0.28 — very dark); `_iconTint` now bins by HUE and skips the icon's rarity-coloured background instead of averaging everything toward white |

**Scan first (all 580):** 54 shells have effect layers; 14 of them change which texture they sample. Sampled
before/after on Blazing Conqueror, Fire Victorious, Plasma, Crystalline, Star Map, Sanctum Plate.

**Verified:** Blazing Conqueror now shows purple flames at the tendril tips that change shape frame to frame,
matching its icon. Captured with `tools/preview-clip.js`, which grabs a sequence of preview frames with the angle
pinned — single screenshots can land between animation phases and miss the effect entirely.

**Still open:** effect *styles* differ (flames rise, electricity flickers, clouds drift) and are currently all
driven the same way. That is the next thing to group — see `effect-layers` in shell-groups.js.

**In-game reference (2026-09-20):** `research/effect-animation-reference.md` — frame-by-frame measurements from
the user's Blazing Conqueror recording. Colour is right; the *motion* is not yet (surge ~1.5 s, flicker ~0.2 s,
tongues tear off, and the cloudy texture may belong inside the crystal rather than behind the flames).
