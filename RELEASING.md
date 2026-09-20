# Releasing DeskGhost

DeskGhost updates itself from GitHub Releases. An installed copy asks

```
https://github.com/sickontuesdays/deskghost/releases/latest/download/latest.json
```

whether there is a newer version, and if so offers it. The user presses the button or nothing happens —
see "How updating behaves" below.

## The signing key — the one thing that must not leak

Every update is signed with a minisign key. A copy of DeskGhost refuses any update that isn't signed by the
matching key, which is what stops someone serving a fake "update" from a lookalike URL.

| | |
|---|---|
| **Private key** | `%USERPROFILE%\.tauri\deskghost.key` — deliberately **outside** this folder, so it can never be committed |
| **Its password** | `%USERPROFILE%\.tauri\deskghost.key.password.txt` |
| **Public key** | `%USERPROFILE%\.tauri\deskghost.key.pub`, also pasted into `src-tauri/tauri.conf.json` as `plugins.updater.pubkey` (public by design — it belongs in the app) |
| **In CI** | GitHub → repo → Settings → Secrets and variables → Actions: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

**Back both files up somewhere you won't lose them** — a password manager, or an encrypted drive. If the private
key is lost, every copy already installed can never be updated again: you'd have to publish a new version with a
new public key and get everyone to install it by hand.

GitHub secrets are write-only: once set, nobody (including you) can read them back out of the web UI, only
overwrite them. So the copy in `%USERPROFILE%\.tauri` is the real backup.

If the key is ever exposed, generate a new pair, put the new public key in `tauri.conf.json`, and ship a normal
update signed with the *old* key that carries the new public key. Everyone who takes that update moves to the new
key; anyone who doesn't is stranded, so don't lose it in the first place.

`.gitignore` blocks `*.key`, `*.key.password.txt` and `.tauri/` as a second line of defence.

## Shipping a version

1. Bump the version in **all three** places — they must match:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Write the release notes in `CHANGELOG.md`. The workflow copies that top section into `latest.json`, so it is
   **literally what people read in the update card inside the app** — keep it plain-language. Editing the draft
   release's text on GitHub afterwards does *not* change it; `latest.json` is written at build time.
3. Commit, then tag and push:
   ```bash
   git commit -am "0.3.0"
   git tag v0.3.0
   git push && git push origin v0.3.0
   ```
4. The **Release** workflow builds on a Windows runner, signs the installer, and creates a **draft** release with
   `DeskGhost_0.3.0_x64-setup.exe`, its signature, and `latest.json`.
5. Check the draft, edit the notes, and **publish** it. Publishing is what actually ships the update — installed
   copies see nothing until then.

Never reuse or go backwards in a version number: the updater compares semver, and a copy on 0.3.0 will ignore
anything that isn't higher.

### If a release is bad

There is no rollback. Fix it and publish a **higher** version — 0.3.1 — as quickly as you can. Anyone who already
took the bad one gets the fix through the same update prompt. (You can un-publish the bad release so nobody new
downloads it, but copies that already updated stay where they are until the next version.)

## Verified working — 2026-09-20

The whole path was tested for real: 0.3.0 installed from its published release, 0.3.1 published, and the update
taken from inside the app. What happened:

- The badge and offer appeared; nothing moved until the button was pressed.
- **No SmartScreen prompt during the in-app update**, even though the installer is unsigned. The updater fetches
  the file itself, so it doesn't carry the "downloaded from the internet" mark that triggers the warning. The
  warning only applies to the *first* manual install.
- It installed **over** the existing copy — one entry in Windows' installed-apps list, same install location,
  no uninstall step needed.
- The applied shell, settings and downloaded models all survived, and the Ghost came back on its own.
- The changelog notes read fine in the update card.

## How updating behaves, and why

Deliberately opt-in at every step:

- On start, DeskGhost asks the endpoint whether there's a newer version. It **only** raises an "Update available"
  badge and shows an offer in Settings.
- Nothing is downloaded or installed until the user presses **Download and install**.
- The whole check can be turned off: Settings → "Look for updates when DeskGhost starts". Off means no contact
  with the update server at all unless "Check now" is pressed.
- The NSIS installer runs in `passive` mode: a progress window, no questions, then the app reopens. Because the
  install is per-user, there is no UAC prompt.
- Settings and downloaded shells survive an update.

This is described to users in the app, under **About & Terms → Updates**, including what a check sends and that
updates are signature-verified.

## Code signing is a different thing

The updater signature protects the *update channel*. It does nothing about the SmartScreen "unrecognised app"
warning people see the first time they run the installer — that needs an Authenticode certificate (a few hundred
dollars a year, or free via SignPath for open-source projects). Worth revisiting only if the warning turns out to
put people off installing.
