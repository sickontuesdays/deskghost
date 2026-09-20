# DeskGhost, anti-cheat and game terms of service — 2026-09-19

Question: could DeskGhost get someone banned from Destiny 2 or another game?

Short answer: the ban risk is very low, because DeskGhost is not an in-game overlay in the sense anti-cheat cares
about. It never touches the game. The one real-world concern was performance, and the app now steps aside from
fullscreen games automatically.

## The distinction anti-cheat actually makes

Anti-cheat systems care about **code running inside the game's process**: DLL injection, API hooking, reading or
writing game memory, or faking input. That is how cheats work, and also how "in-game overlays" such as Discord's
or Steam's draw inside the game — which is why those sometimes get blocked or break.

A **separate top-level window that Windows composites over the game** requires none of that. It is what OBS's
preview, wallpaper apps, chat windows and notification popups are.

DeskGhost is firmly in the second category. Every Windows API it calls, from a complete scan of its source:

```
DwmGetWindowAttribute  EnumWindows  GetClassNameW  GetCurrentProcessId  GetCursorPos
GetMonitorInfoW  GetWindowLongW  GetWindowRect  GetWindowThreadProcessId
IsIconic  IsWindowVisible  MonitorFromWindow  ShowWindow
```

All of those are read-only queries about windows and monitors, plus showing/hiding its **own** window. There is no
`SetWindowsHookEx`, `CreateRemoteThread`, `ReadProcessMemory`, `WriteProcessMemory`, `VirtualAllocEx`,
`OpenProcess`, `SendInput`, `LoadLibrary`, no driver, and no Direct3D hooking anywhere in the app. It reads the
global cursor position (the same call a thousand ordinary apps make) and draws its own window. It does not read
the game, write to it, automate anything, or give the player any information about the game.

## What the vendors say

**Bungie** (Destiny 2) states plainly: *"Bungie will not ban or restrict players for using common third-party
applications such as Discord, XSplit, OBS, RTSS or other apps"*, while reserving the right to act if such apps are
used to violate the Code of Conduct or licence agreement. Bungie separately notes it *resists attempts by
third-party applications to insert code into the game client*, which can make injected overlays malfunction —
a compatibility matter, not a ban. DeskGhost inserts nothing.

**BattlEye** (Destiny 2's anti-cheat) says: *"Generally we only ever ban for the use of actual cheats/hacks or
components of such hacks which are designed to intentionally bypass BE's protection"*, and that *"non-cheat
overlays and visual enhancement tools like Reshade or SweetFX are generally supported unless desired otherwise by
the game developers."*

**Riot Vanguard** (Valorant, League) is the strictest mainstream anti-cheat and has no allow-list. Its published
guidance is that overlays and tools using official APIs keep working, while **external tools that read game memory
do not**. DeskGhost reads no memory and ships no driver, so there is nothing for Vanguard to object to — though on
a Vanguard-protected game the Ghost also simply hides, since those run fullscreen.

**Easy Anti-Cheat and similar systems** follow the same pattern: injected overlays are policed, separate windows
are not.

## Why hiding matters (and what it does not fix)

Hiding during fullscreen games was added for **performance**, not for anti-cheat: any window on top of a
fullscreen game stops Windows using its fast direct-to-display path, which can cost frame rate and add input lag.
Since the overlay window is hidden outright while a fullscreen app is in front on that monitor, and its rendering
is suspended, there is nothing over the game at all.

Being hidden does not change the anti-cheat picture, because DeskGhost never interacted with the game in the first
place. It also does not stop the app from running, and no mainstream anti-cheat bans people for unrelated programs
being open.

## Residual risks, stated honestly

- **Windowed and borderless-windowed play on the Ghost's monitor.** Auto-hide triggers on a window covering the
  whole monitor. If someone plays in a smaller window, the Ghost can still drift over it. That is still only
  Windows drawing one window above another — the same as a chat window — but it can be visually distracting.
- **No vendor guarantees.** No game company promises never to act against any given third-party program. The
  statements above are Bungie's and BattlEye's own published positions, not a guarantee, and policies change.
- **Kicks versus bans.** BattlEye notes it may *kick* (not ban) for specific programs such as macro tools.
  DeskGhost sends no input and automates nothing, so it does not fall in that category.
- **Competitive/tournament rules** are stricter than ordinary play. Anyone playing in an organised competition
  should follow that event's rules about what may run on the PC.

## Bottom line for sharing with the clan

DeskGhost draws a picture on your desktop. It does not read, modify, hook, or inject into any game, gives no
in-game advantage or information, and hides itself while fullscreen games are running. For Destiny 2 specifically,
Bungie's published policy is that common third-party apps are not grounds for a ban, and BattlEye bans for actual
cheats.

## Sources

- Bungie — Game Account Restrictions and Banning Policies: https://safety.bungie.net/hc/en-us/articles/42308518654100-Bungie-Game-Account-Restrictions-and-Banning-Policies
- Bungie Help — Destiny 2 PC and Third-Party Application Feature Compatibility: https://help.bungie.net/hc/en-us/articles/360049199891-Destiny-2-PC-and-Third-Party-Application-Feature-Compatibility
- Bungie Help — BattlEye Anti-Cheat Support Guide: https://help.bungie.net/hc/en-us/articles/4404072197140-BattlEye-Anti-Cheat-Support-Guide
- BattlEye FAQ: https://www.battleye.com/support/faq/
- Riot Games — Vanguard FAQ for third-party applications: https://www.riotgames.com/en/DevRel/vanguard-faq
