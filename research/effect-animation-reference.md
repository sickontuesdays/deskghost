# Effect animation reference — what "animation effect" actually means

Source: `Screen Recording 2026-09-20 003640.mp4` (1368×1018, 30 fps, 910 frames, 30.33 s), supplied by the user
after my earlier reading of "animation effect" was wrong. It shows **Blazing Conqueror Shell** in an in-game
inspect view, slowly turning, with the effect running the whole time.

Frames extracted at full rate and measured over frames 400–520 (a 4 s window) on one tendril tip.

## What the recording shows

The effect is **not** a static flame shape whose brightness pulses. It is a continuously moving flame:

* Tongues of flame **form at the base, travel upward, thin out, tear off and dissipate** above the crystal. No
  two frames have the same silhouette — the shape changes every frame, not every cycle.
* The flame **wraps the crystal on all sides** — it is a sleeve around the cube, not a billboard behind it —
  and rises to roughly 1.5–2× the crystal's height above it.
* **Hot core, cool tips:** near-white/hot pink where it meets the crystal, fading to violet at the tips. Additive
  over whatever is behind it.
* The **crystal itself is a separate animated thing**: translucent, lit from within, with a bright cloudy pattern
  drifting inside it. That is almost certainly where `327503503_cloudy_swirl_1_dif` belongs — *inside the
  crystal*, not as the under-glow behind the flames the way we currently draw it.
* The metal has small purple emissive detail strips (the "WW" marks on the arms) and the eye has its own
  glowing sigil — both steady, not part of the flame.

## Measured motion

| Quantity | Measurement |
|---|---|
| Flame silhouette area | swings 2374 → 4525 px (±30 % about the mean) |
| Flame top edge | moves over 20 rows of an 85-row crop, i.e. height varies ~25 % |
| Slow cycle | autocorrelation peak at **44–45 frames ≈ 1.47–1.50 s** — the main breathe/surge period |
| Fast flicker | secondary peaks at **5–7 frames ≈ 0.17–0.23 s** — the tongue-level turbulence |

So the target is a two-rate motion: a ~1.5 s surge riding under a ~0.2 s flicker, with the texture scrolling
upward continuously underneath both.

## What this means for our renderer

Today `_vfxMaterial` composites a shape texture over a soft under-glow and drifts the shape upward by `VFX_RISE`.
That gets the colour and the rise right, but it is one steady scroll — it does not surge or flicker, and it has no
tear-off at the top. The gap between our render and the recording is *motion*, not colour.

Next session, in order:

1. **Check which mesh part each texture is bound to** on Blazing Conqueror. If `cloudy_swirl` belongs to the
   crystal rather than the flame, the under-glow layer we added is on the wrong surface and should move.
2. Add the two-rate motion to the fire/ember styles in the `effect-layers` group: continuous upward scroll,
   ~1.5 s amplitude surge, ~0.2 s flicker on top, and a vertical fade so tongues thin out and vanish near the
   top of the part rather than ending flat.
3. Keep it scoped by style — electricity and drifting cloud should not inherit the fire motion. That is the split
   `effect-layers` was created to hold.

Verification, as before: `tools/preview-clip.js` for a pinned-angle sequence, compared against this recording
frame for frame — never a single screenshot.
