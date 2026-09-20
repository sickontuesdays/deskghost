# DeskGhost changelog

## 0.3.1 — 2026-09-20

A check that updating actually works, end to end.

There are no changes to the program itself. 0.3.0 was the first version able to update itself, and the only
honest way to confirm that machinery works — the check, the offer, the signature check, the install, and your
settings and downloaded shells surviving it — is to publish a real version and take the update.

If you are reading this in the update card inside DeskGhost, most of it already worked.

## 0.3.0 — 2026-09-20

DeskGhost can now tell you when a new version is out, so a copy you downloaded once doesn't go stale.

**Updates**
- New **DeskGhost updates** section in Settings: shows your version, a "Check now" button, and — when there is a
  newer version — what changed and a **Download and install** button.
- An "Update available" badge appears in the title bar so you don't have to go looking.
- **Nothing installs on its own.** A check only tells you; the download and install happen when you press the
  button. You can dismiss the offer, and "Look for updates when DeskGhost starts" can be switched off entirely,
  after which DeskGhost never contacts the update server unless you ask it to.
- Every update is signed, and your copy verifies the signature before installing. A tampered or wrong-source
  download is refused.
- Your settings and downloaded shells are kept across an update.
- About & Terms gained an **Updates** section covering all of the above, what a check sends, and the matching
  terms; the privacy points now mention the version check.
- Settings → Item list: "Check for updates" is now called "Check for new items", so it isn't confused with
  program updates.

## 0.2.0 — 2026-09-19

The first version worth sharing widely. Install it over 0.1.0; your picked shell, settings and downloads are kept.

**Ghost**
- Fixed misplaced and undersized eyes on 169 shells. Shells whose eye comes from a separate model file (the
  Couriers, Buoy, Contender's, Cottontail, Trusty, Tastemaker and many more) had the eye shrunken and floating in
  front of, under or behind the shell. Positions are now read as Bungie stores them.
- Added a **Turn Ghost off / on** button under "Put on desktop"; it stays in sync with the tray and Settings.

**Games and performance**
- The Ghost now **hides while a fullscreen app or game is in front** on its monitor, and stops rendering. A window
  on top of a fullscreen game costs frame rate and adds input lag. On by default; Settings can turn it off.
- The overlay window is now hidden entirely while the Ghost is off, instead of sitting there invisible.
- Only the shell on screen keeps its textures in memory (previously every shell applied stayed loaded).

**New About & Terms tab**
- How the program works, what it does and doesn't do to games, anti-cheat information, and a warning that playing
  in a window (rather than fullscreen) can still let the Ghost wander over the game.
- Plain-language terms of use, plus website and Discord links in the top-right.

**Security and robustness** (see `research/audit-2026-09-19.md`)
- Content Security Policy locking the app to its own files and the local Bungie proxy.
- Strict path checking on that proxy, with tests.
- Setup can't run twice at once and cleans up leftover temporary files.
- Uninstalling removes the "start with Windows" entry.
- Fixed a freeze when the main window was opened while no Ghost had been picked yet.

## 0.1.0 — 2026-09-19

First build: pick any Ghost shell and shader, 3D preview, desktop overlay with wandering/idle animations, tray
menu, settings, and a first-run setup that builds the shell list from Bungie's public manifest.
