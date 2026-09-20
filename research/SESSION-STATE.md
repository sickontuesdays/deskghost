# Where we are — end of session, 2026-09-20

## Built and working

DeskGhost v0.2.0, a Tauri 2 (Rust + WebView2) desktop app that floats a Destiny 2 Ghost shell on the desktop.
2.7 MB installer, single file, shareable. Nothing from Bungie ships inside it — the catalog is built on first run
from the public manifest and models are downloaded on pick and cached.

* Ghost / Settings / About & Terms tabs, plus Website and Discord buttons on the right of the tab bar.
* Transparent click-through always-on-top overlay, global cursor relay, tray icon, autostart, power-off button.
* Auto-hide when a fullscreen app is on the same monitor (scans all windows on that monitor, verified by
  screenshot, not by reading the code).
* Audited: no memory leaks, 0 Rust advisories, low CPU/RAM. `research/audit-2026-09-19.md`,
  `research/anticheat-and-tos.md`, `SYSTEM-REQUIREMENTS.md`.

## Shell fixes done so far

All logged in `research/shell-fixes.md` with where the data came from, so the whole batch can be ported to the
website in one pass later.

1. **Eye placement** — 169 shells had the eye in the wrong place/size; positions were having the scale and offset
   applied twice. (This one was also applied to the site, at your request.)
2. **Additive that keeps alpha** — stops black rectangles on the transparent overlay.
3. **Arena sprite cards** — the duelling Guardian and Rhulk, timed from your recording; upscale + unsharp +
   tone curve, clamped UVs (killed the glowing speck by the Guardian).
4. **Peaceful rotors** — four rotors, adjacent ones counter-rotating like a real quadcopter, just under blur speed.
5. **Glass panes** — undid the global "metallic dye means solid" rule that had quietly removed glass across the
   collection; panes are glass by default now with exceptions in a group.
6. **Effect layers** — 54 shells with flames/embers/smoke/electricity: right texture, under-glow, brightness,
   upward drift, hue-binned icon tint. Blazing Conqueror shows purple tendril flames again.

**Shell groups** (`src/ghost/shell-groups.js`, `research/shell-groups.md`) — the mechanism that keeps changes off
the 500 shells they don't belong to. Groups may overlap. Any change that can't be derived from Bungie's data goes
in a group with a reason and how it was checked, not in a global rule.

## Last thing done tonight

Analysed `Screen Recording 2026-09-20 003640.mp4` and wrote `research/effect-animation-reference.md`. The short
version: our flames have the right colour but the wrong *motion*. In game they surge on a ~1.5 s cycle with a
~0.2 s flicker on top, tongues tear off and dissipate above the crystal, the flame wraps the crystal as a sleeve,
and the crystal has its own cloudy pattern drifting inside it — which suggests the under-glow texture we added
behind the flames may actually belong on the crystal instead.

## Next session, in order

1. Check which mesh part each texture is bound to on Blazing Conqueror (is `cloudy_swirl` the crystal's?).
2. Give the fire/ember style its two-rate motion — scroll + 1.5 s surge + 0.2 s flicker + fade-out at the top —
   scoped so electricity and cloud styles don't inherit it.
3. Split `effect-layers` into per-style groups as those styles get their own motion.
4. Revisit the Arena fighters (earmarked — good enough for now, not final).
5. Check the 12 `pane-unverified` small panes, and decide whether `soft-translucent-pane` (Hareball, Deep
   Whisper) should use the translucent path instead of glass.
6. Port the whole batch of shell fixes to the website — one pass, only when you ask for it.
7. Clean release build + version bump when you want a new shareable installer. **The copy running now is a test
   build** with debug hooks and the remote-debugging port open.

## Working rules established

* The website is not to be touched unless you explicitly ask — another session works in there.
* No global changes without first scanning all 580 shells for blast radius, then rendering before/after and
  comparing against the item icon or in-game footage.
* Verify visually — screenshots and clips — not by trusting the code.
* Animated effects need `tools/preview-clip.js` (a pinned-angle sequence); a single screenshot lands between
  phases and misses the effect.
* Clean up after every test session: the overlay goes back to Always / size 300 and the test window gets closed.
