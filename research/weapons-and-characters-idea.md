# Weapons and characters — what would be possible

**Status: idea only, parked 2026-09-20 at the user's request.** Would be a separate build, not part of DeskGhost.
Do not act on this unless the user brings it up again.

## Weapons and armour pieces — very likely feasible

The Ghost pipeline is not Ghost-specific. `catalog.rs` filters on two conditions (bucket is Ghost, item type is
Ghost); everything after that is generic gear handling — gear asset DB lookup, TGXM containers,
`render_metadata.js`, mesh decode, dyes. Weapons and armour are gear items in the same database, so widening the
filter should be most of the work, and shaders/ornaments would likely apply through the same dye channels.

**Unverified assumption to check first:** that weapon entries in the gear asset DB actually carry geometry rather
than being icon-only. `has_geometry()` already exists for this; pointing the extractor at a few known weapon
hashes would settle it in ~20 minutes.

## A full Guardian — blocked by missing data

Three things Bungie does not publish:

1. **The body mesh.** Armour is built to fit a character, but the body underneath — head, hands, the shape the
   armour hangs on — isn't in the gear asset DB. Stacking helmet/chest/gauntlets/legs/mark gives a floating
   armour arrangement with gaps at the neck and wrists and no face or hands.
2. **The skeleton.** Armour geometry is skinned (it has bone weights) but the skeleton those weights refer to
   isn't published, so the mesh can't be posed at all.
3. **Animations.** None ship — same as Ghost shells. The difference is that a Ghost is a rigid prop, so
   hand-authored bobbing reads as correct; a human figure standing frozen reads as broken.

Realistic best case is a static armour mannequin with visible holes. Not worth building.

## Practical catches if weapons were ever done

- **Catalog size:** ~580 shells vs a couple of thousand weapons plus several thousand armour pieces. Icon
  prefetch goes from ~1,270 to 10,000+, and the icon cache from ~7 MB to maybe 50–60 MB. Wants category filters
  in the picker rather than one grid.
- **Shape on screen:** a Ghost is a ball and reads fine at 108 px wandering about. A sniper rifle at that size is
  a smear. Weapons want to be larger and to behave differently — slow inspect-style rotation in a corner rather
  than wandering.
- **The motion is the actual work.** The Ghost's personality is its wander/idle/scan/transmat logic, none of
  which transfers to a rifle. Rendering is the easy half; the behaviour would have to be designed from scratch.

## Why this argues for finishing the shells first

It is one renderer. Every shell fix — glass, effect layers, dye handling, eye placement — would land on weapons
and armour too, because they go through the same code.
