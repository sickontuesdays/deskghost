# DeskGhost — system requirements

DeskGhost is a small Rust app that draws a Destiny 2 Ghost shell on your desktop using WebView2 (the browser
engine built into Windows) for 3D rendering.

## Minimum

| | |
|---|---|
| **OS** | Windows 10 64-bit or Windows 11. Windows 7 and 8.1 are **not** supported — WebView2 stopped supporting them at version 109 |
| **CPU** | Any 64-bit (x64) processor. ARM PCs (Snapdragon X, etc.) are untested; they would run it through x64 emulation |
| **RAM** | 4 GB (DeskGhost uses ~250–310 MB, most of it the WebView2 engine) |
| **Graphics** | Any GPU with working hardware acceleration and WebGL 2 — integrated graphics (Intel HD 500-series or newer, AMD Vega, Apple-era equivalents) is fine |
| **WebView2 Runtime** | Preinstalled on Windows 11 and on most up-to-date Windows 10 PCs. If missing, the installer downloads it (needs internet during install) |
| **Disk** | ~150 MB: app 6 MB, item list 2.3 MB, icons 7 MB, WebView2 profile ~36 MB, plus ~1 MB per shell or shader you try |
| **Internet** | Required on first run (~45 MB one-time setup) and the first time you use each shell/shader. Everything already downloaded works offline |
| **Display** | Any resolution. Multi-monitor works; the Ghost lives on one monitor you choose |
| **Permissions** | None special. Installs per-user, no administrator rights |

## Recommended

| | |
|---|---|
| **OS** | Windows 11, or Windows 10 22H2 |
| **RAM** | 8 GB or more, especially if you game while it runs |
| **Graphics** | Any dedicated GPU, or modern integrated graphics |
| **Disk** | 1 GB free if you plan to try lots of shells (all 580 shells plus all shaders would be several hundred MB) |
| **Settings** | The defaults (30 fps, 108 px). 60 fps costs about 50% more CPU for a slightly smoother Ghost |

## What it actually uses (measured)

Measured on the release build: Windows 11, i9-12900K, RTX 5070, 2560×1440 display.

| State | CPU | GPU | RAM |
|---|---|---|---|
| Ghost on, defaults (30 fps, 108 px) | 7% of one core (0.3% of a 24-thread CPU) | 0.5% | ~285 MB |
| Ghost on, 60 fps at 200 px | 11% of one core (0.5%) | 0.8% | ~306 MB |
| Ghost off, or hidden behind a fullscreen game | 0.1% of one core | 0% | ~250 MB |

CPU use is a share of **one** core, so on an older or slower CPU expect a bigger share of that core — a quad-core
laptop might see 20–30% of one core at default settings. If that matters (on battery, for example), lower the
frame-rate cap in Settings, use "Wake on mouse" so it sleeps when you aren't moving the mouse, or turn it off.

## Notes for laptops

- The Ghost renders continuously while visible, which will shorten battery life. "Wake on mouse" mode stops all
  rendering a few seconds after you stop moving the mouse.
- Leave "Hide during fullscreen games and videos" on (the default). It stops the Ghost rendering entirely while a
  fullscreen app is in front.

## Not tested

- Installing on a PC that does not already have WebView2.
- Windows on ARM.
- Windows Server or Windows 10 LTSC editions.
- Anything below 8 GB RAM, or a PC with no hardware GPU acceleration (software rendering would be slow).
