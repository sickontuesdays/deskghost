# DeskGhost

A Destiny 2 Ghost that floats around your Windows desktop. Pick any Ghost shell (and optionally a shader) and
it wanders your screen on a transparent, click-through overlay: it glances at your cursor, idles, scans, spins,
and transmats around.

Built with [Tauri 2](https://tauri.app): a small Rust app that uses Windows' built-in WebView2 to run the same
three.js Ghost renderer as the Sick on Tuesdays website.

## No Bungie files ship with the app

Nothing from Bungie is bundled. Everything is downloaded from Bungie's public content servers (no login, no API
key) and cached on the user's PC:

| When | What | Size |
|---|---|---|
| First run | Bungie's public item database + gear asset database, used to build the local shell/shader list, then deleted | ~45 MB download, ~2.3 MB kept |
| First run | Every shell and shader icon, so the picker can show them | ~1,270 icons |
| Picking a shell or shader | That item's model, textures and dye files | ~1–2 MB each |

Cache locations:
- Item list: `%APPDATA%\com.sickontuesdays.deskghost\catalog.json`
- Downloaded files: `%LOCALAPPDATA%\com.sickontuesdays.deskghost\bungie\`

## Layout

```
src/                     web side (served by Tauri; no bundler)
  overlay.html/.js       the transparent overlay window that hosts the Ghost
  app.html/.js/.css      main window: first-run setup, Ghost picker, settings
  preview.js             3D preview in the picker
  shared.js              catalog + saved-pick helpers
  ghost/                 PORTED from sick-on-tuesday/js/ghost (see "Syncing" below)
  vendor/                three.js + fflate (copied from sick-on-tuesday/lib/vendor)
src-tauri/               Rust side
  src/main.rs            windows, tray menu, command registration, `bungie` URL scheme
  src/overlay.rs         overlay window (click-through, always on top, per monitor) + cursor relay
  src/cache.rs           http://bungie.localhost/<path> → disk cache or www.bungie.net
  src/catalog.rs         first-run catalog builder (+ an ignored test against real data)
reference/js-ghost/      untouched snapshot of the website's ghost files the port was made from
tools/                   make-icon.js (app icon), cdp.js (drive the running app for testing)
```

## Develop

Requirements: Rust (MSVC toolchain), Node 18+, WebView2 (built into Windows 11).

```
npm install
npm run dev        # run the app
npm run build      # release build + installer → src-tauri/target/release/bundle/nsis/
```

Web files are bundled into the exe at build time, so rebuild after editing anything in `src/`.

**Testing a running build:** start it with `set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`,
then use `node tools/cdp.js list | eval | shot | logs` to inspect or drive the `app` and `overlay` pages.

**Catalog test on real data:** download the two `.content` databases named in
`https://www.bungie.net/Platform/Destiny2/Manifest/` (`mobileWorldContentPaths.en` → `world.content`,
the newest `mobileGearAssetDataBases` → `gear.content`) into a folder, then from `src-tauri`:
`set DESKGHOST_TEST_DATA=<folder>` and `cargo test --release -- --ignored --nocapture`.

## Syncing with the website's Ghost

`src/ghost/ghost-companion.js` and `src/ghost/ghost-shell-source.js` are ports of the website's files. Each
starts with a "DESKGHOST PORT" comment listing exactly what differs:

- the shell comes from the user's pick, not the Bungie profile
- gear entries and item definitions come from the local catalog, not sql.js or the site API
- Bungie files are fetched via `http://bungie.localhost` (the caching proxy)
- no soccer-shell GLB, no profile polling, no site-action hooks; a "panel scan" can happen anywhere on the desktop

To bring over later website changes, diff the website's current files against `reference/js-ghost/` (the
snapshot the port was made from) and apply the same changes to `src/ghost/`, then refresh `reference/`.
