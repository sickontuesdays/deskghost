# Shell groups — scoping changes to the shells they belong to

**The problem this solves.** Early fixes were global rules applied to all 580 shells. One of them — "a stage-7
pane whose dye is metallic is a solid surface, not glass" — turned out to be wrong on 10 of the 14 shells it was
checked against, and quietly removed the glass from canopies, lenses and windows across the whole collection.
A rule that can't be derived reliably from Bungie's data shouldn't be applied to every shell.

**The rule now.** Derive from the data whenever the data actually distinguishes the cases (a sprite strip is a
strip; a flat mask-split plate is a rotor; dyes carry the colours). When it doesn't, decide per shell and record
it in `src/ghost/shell-groups.js`, with the reason and how it was checked.

## How to use it

```js
import { inGroup, groupsFor, groupOf } from './shell-groups.js';

inGroup('opaque-pane', hash)   // should this shell's pane be solid instead of glass?
groupsFor(hash)                // every group this shell is in
groupOf('sprite-cards')        // { hash: reason, … } — the shells to re-check after a change
```

**Groups overlap on purpose.** A shell with glass may also have its own animation style. Anything touching
colours, animation or materials should ask for the group it cares about, so every other shell is left alone.

## Current groups

| Group | Shells | What it means |
|---|---|---|
| `opaque-pane` | 4 | Stage-7 pane that is NOT see-through: Wintry Neigh-bor's mane, Wish-Maker's ribbons, Belle Air's pods, Exquisite Point's cap. Everything else with a pane renders as glass |
| `glass-pane-verified` | 8 | Panes confirmed see-through against the icons — the sample to re-check whenever the glass material changes |
| `soft-translucent-pane` | 2 | Hareball's ears, Deep Whisper's wisps: translucent shapes rather than glass. Still drawn as glass; may want the translucent path |
| `pane-unverified` | 12 | Small panes (45–300 tris, mostly lens covers) not yet checked. Glass by default |
| `sprite-cards` | 1 | Arena's duelling fighters — re-render these when the card shader, timing or tone curve changes |
| `rotors` | 1 | Peaceful's quadcopter rotors |
| `spike-morph` | 2 | Speed Metal, Quicksilver Squall — the liquid-metal spike swap |

The last three are detected from geometry, so those lists are documentation rather than switches: they say which
shells to look at after a change to that feature.

## How a shell gets classified

`tools/pane-shots.js <outDir> <hash…>` renders shells in the picker with their stage-7 panes painted magenta and
the preview pinned front-facing, so it's obvious which surface the decision is about. Put that next to the item
icon (already cached under `%LOCALAPPDATA%\com.sickontuesdays.deskghost\bungie\…\icons`) and the answer is usually
plain: a canopy shows the body through it, a mane doesn't.

Checking against the icon is enough for a surface that is obviously clear or obviously solid. For anything
subtler — how translucent, what colour, how fast something moves — in-game footage is the reference, as it was for
Arena's fighters and Peaceful's rotors.

## Before making a change that isn't scoped to a group

1. Scan all 580 shells for how many the change would touch (`scan-glass.mjs` in the session scratchpad is the
   pattern: decode every shell, count what the rule would flip).
2. Render a sample before and after, and compare against the icons or footage.
3. Only then apply — and if the answer varies shell by shell, it belongs in a group here, not in a global rule.
