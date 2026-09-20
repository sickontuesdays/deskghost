/**
 * Shell groups — which shells share a trait.
 *
 * The renderer works from Bungie's data wherever a rule can be derived from it (sprite strips, rotor plates, dye
 * colours). This file is for the rest: things the data does not distinguish, where a decision has been checked
 * against the item icon or in game, shell by shell.
 *
 * A shell can be in as many groups as apply — a shell with glass may also have its own animation style — so
 * anything that changes colours, animation or materials should ask for the group it cares about and leave every
 * other shell alone. That is the point of this file: no more global rules that quietly reshape 500 shells.
 *
 *   groupOf('opaque-pane')          → { hash: 'why', … }
 *   inGroup('opaque-pane', hash)    → boolean
 *   groupsFor(hash)                 → ['opaque-pane', …]
 *
 * Adding a shell: put it in the group with a one-line reason, and say how it was checked. Keep
 * research/shell-groups.md in step.
 */

export const SHELL_GROUPS = {
  /**
   * Stage-7 panes that are NOT see-through: the part sits in the transparent stage, but in game it reads as a
   * solid surface (hair, fabric, a lacquered cap). Everything else with a pane renders as glass.
   * Checked against the item icons with the pane highlighted (tools/pane-shots.js), 2026-09-19.
   */
  'opaque-pane': {
    2505678743: "Wintry Neigh-bor — the pane is the unicorn's mane, not a canopy",
    3862768196: 'Wish-Maker — ribbons between the petals',
    2222909943: 'Belle Air — the side pods',
    1118186959: 'Exquisite Point — the small cap on top',
  },

  /**
   * Panes confirmed see-through against the icons. Glass is the default, so this group is documentation — it
   * records what was actually verified, and is the sample to re-check when the glass material changes.
   */
  'glass-pane-verified': {
    1649523396: 'Clean Lines — front canopy, body visible through it',
    1013853354: 'Hard Light — big front lens',
    2222909937: 'E99 — the whole egg body is a clear shell',
    408388875: 'ROV — front window, eye visible inside',
    3161505828: 'Andromeda — canopy over the lens',
    4069675199: 'Retrophoto — camera lens',
    634549439: 'Phantasmal — iridescent visor',
    1118186958: 'Eco-Ethical — tinted front visor',
  },

  /**
   * Panes that are soft translucent shapes rather than glass — they may want the translucent path (lit, emissive)
   * instead of the glass path (clear, fresnel edge). Currently still rendered as glass; not yet compared in game.
   */
  'soft-translucent-pane': {
    732682038: 'Hareball — the bunny ears, translucent and glowing',
    2001163202: 'Deep Whisper — the white wisps around the shell',
  },

  /**
   * Small panes (45–300 triangles, mostly lens covers) that have not been checked against the icons. They render
   * as glass by default; the difference at this size is slight.
   */
  'pane-unverified': {
    1820763748: 'Anisotropic', 2716406907: 'Crimson', 4117442486: 'Gallant Ward', 1490733289: 'Hydrofoil',
    3361254700: 'Modded', 2749628923: "Disciple's", 2098788836: 'Grillmaster', 1511744862: 'Cygnus',
    1554105351: 'Horus', 210874516: 'Final', 1033916546: 'Supernova', 408388874: 'Maglev',
  },

  /**
   * Shells with an effect layer (stage-7 VFX part): flames, embers, smoke, electricity, drifting cloud. All 54
   * are driven by the same material today — shape texture over a soft under-glow, drifting upward. Their styles
   * differ though, so this is the group to split when per-style motion is added.
   * Listed by their effect's shape texture, biggest layers first. Full scan: vfx-scan.json in the session notes.
   */
  'effect-layers': {
    3850767909: 'Blazing Conqueror — purple tendril flames (fire_plate_med + cloudy swirl)',
    227918505: 'Sanctum Plate — electricity_noise, the largest effect layer of any shell',
    1558857470: 'Star Map — smoke_soft_wispy_plate',
    527607309: 'Plasma — electricity',
    76764721: 'Crystalline — perlin plate',
    1558857469: 'Fire Victorious — spark embers',
    // …49 more shells carry one; see research/shell-fixes.md #6
  },

  /**
   * Shells whose stage-7 quads are sprite strips the game flips through (see _renderSprite / CARD_* in
   * ghost-shell-source.js). Detected from geometry, so this list is documentation — but it is the group to render
   * and compare whenever the card shader, its timing or its tone curve changes.
   */
  'sprite-cards': {
    2609270227: 'Arena — duelling Guardian and Rhulk, two-frame strips + clash spark',
  },

  /**
   * Shells with spinning rotors (see _rotorSpin). Also geometry-detected; listed for the same reason.
   */
  rotors: {
    95483422: 'Peaceful — quadcopter, four rotors, adjacent ones counter-rotating',
  },

  /**
   * Shells whose liquid-metal spikes extend and retract (see _spikeMorph). Timing was measured from in-game
   * footage; these are the two the detector matches.
   */
  'spike-morph': {
    2313814566: 'Speed Metal',
    1033916549: 'Quicksilver Squall',
  },
};

/** The shells in a group, as { hash: reason }. */
export function groupOf(group) {
  return SHELL_GROUPS[group] || {};
}

/** Is this shell in that group? */
export function inGroup(group, hash) {
  return Object.prototype.hasOwnProperty.call(SHELL_GROUPS[group] || {}, String(hash >>> 0));
}

/** Every group this shell belongs to. */
export function groupsFor(hash) {
  const key = String(hash >>> 0);
  return Object.keys(SHELL_GROUPS).filter((g) => Object.prototype.hasOwnProperty.call(SHELL_GROUPS[g], key));
}
