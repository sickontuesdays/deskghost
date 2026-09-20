//! The overlay: a transparent, borderless, always-on-top, click-through window covering one monitor, which the
//! Ghost is drawn into. Because it ignores the mouse, it never receives mouse events itself — a small thread
//! reads the global cursor position and relays it to the page as `cursor` events (the page turns them back into
//! `mousemove`, which is what the companion code listens for).
//!
//! The window is only shown while it has something to do:
//!   - hidden while the Ghost is turned off (frees the screen-sized compositor surfaces, ~100+ MB of GPU memory)
//!   - hidden while a fullscreen app or game is in front on the same monitor (on by default), so it never sits on
//!     top of a game — a window over a fullscreen game stops Windows from using its fast direct-to-display path,
//!     which can cost frame rate and add input lag. The page is told to pause rendering while hidden.
//! Showing never activates the window, so it can't steal focus.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "overlay";

struct State {
    hwnd: isize,            // the overlay's native window handle
    ghost_on: bool,         // the page's Ghost mode isn't 'off'
    hide_fullscreen: bool,  // user setting
    fullscreen: bool,       // a fullscreen app is in front on the overlay's monitor
    shown: bool,            // what we last applied
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State { hwnd: 0, ghost_on: true, hide_fullscreen: true, fullscreen: false, shown: false }))
}

// ---------------------------------------------------------------- settings (overlay.json)

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("overlay.json"))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Value {
    settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_setting<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) {
    let mut s = load_settings(app);
    s[key] = value;
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, s.to_string());
    }
}

fn saved_monitor<R: Runtime>(app: &AppHandle<R>) -> usize {
    load_settings(app)["monitor"].as_u64().unwrap_or(0) as usize
}

// ---------------------------------------------------------------- monitors

/// Monitors in a stable order: primary first, then left-to-right.
fn monitors<R: Runtime>(app: &AppHandle<R>) -> Vec<Monitor> {
    let mut list = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    list.sort_by_key(|m| (Some(*m.position()) != primary, m.position().x, m.position().y));
    list
}

/// Cover the monitor, minus one pixel of height: a topmost borderless window that exactly covers a screen makes
/// Windows treat it as a fullscreen app (the taskbar drops behind it and notifications get suppressed).
fn fit_to<R: Runtime>(win: &WebviewWindow<R>, m: &Monitor) {
    let pos = *m.position();
    let size = *m.size();
    let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = win.set_size(PhysicalSize::new(size.width, size.height.saturating_sub(1)));
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("DeskGhost overlay")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(800.0, 600.0)
        .build()?;
    let list = monitors(app);
    if let Some(m) = list.get(saved_monitor(app)).or_else(|| list.first()) {
        fit_to(&win, m);
    }
    win.set_ignore_cursor_events(true)?;
    {
        let mut s = state().lock().unwrap();
        #[cfg(windows)]
        {
            s.hwnd = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        }
        s.hide_fullscreen = load_settings(app)["hideFullscreen"].as_bool().unwrap_or(true);
    }
    apply(app);
    start_cursor_relay(app.clone());
    start_fullscreen_watch(app.clone());
    Ok(())
}

// ---------------------------------------------------------------- visibility

/// Show or hide the overlay to match the state; tells the page to pause/resume rendering on a change.
fn apply<R: Runtime>(app: &AppHandle<R>) {
    let (want, hwnd, changed) = {
        let mut s = state().lock().unwrap();
        let want = s.ghost_on && !(s.hide_fullscreen && s.fullscreen);
        let changed = want != s.shown;
        s.shown = want;
        (want, s.hwnd, changed)
    };
    if !changed && want {
        return;
    }
    show_window(app, hwnd, want);
    if changed {
        let _ = app.emit_to(LABEL, "overlay-suspended", !want);
    }
}

#[cfg(windows)]
fn show_window<R: Runtime>(_app: &AppHandle<R>, hwnd: isize, show: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
    if hwnd != 0 {
        // SAFETY: hwnd is our own overlay window's handle; ShowWindow just changes its visibility
        unsafe { ShowWindow(hwnd as _, if show { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }
}

#[cfg(not(windows))]
fn show_window<R: Runtime>(app: &AppHandle<R>, _hwnd: isize, show: bool) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = if show { w.show() } else { w.hide() };
    }
}

/// The page reports whether the Ghost is on (any mode but 'off').
#[tauri::command]
pub fn set_ghost_on(app: AppHandle, on: bool) {
    state().lock().unwrap().ghost_on = on;
    apply(&app);
}

#[derive(Serialize)]
pub struct OverlayPrefs {
    hide_fullscreen: bool,
}

#[tauri::command]
pub fn get_overlay_prefs() -> OverlayPrefs {
    OverlayPrefs { hide_fullscreen: state().lock().unwrap().hide_fullscreen }
}

#[tauri::command]
pub fn set_hide_fullscreen(app: AppHandle, on: bool) {
    state().lock().unwrap().hide_fullscreen = on;
    save_setting(&app, "hideFullscreen", json!(on));
    apply(&app);
}

#[derive(Serialize)]
pub struct MonitorInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
    current: bool,
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let current = saved_monitor(&app);
    monitors(&app)
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)),
            width: m.size().width,
            height: m.size().height,
            primary: Some(*m.position()) == primary,
            current: i == current,
        })
        .collect()
}

#[tauri::command]
pub fn set_monitor(app: AppHandle, index: usize) -> Result<(), String> {
    let list = monitors(&app);
    let m = list.get(index).ok_or("no such monitor")?;
    let win = app.get_webview_window(LABEL).ok_or("overlay not running")?;
    fit_to(&win, m);
    save_setting(&app, "monitor", json!(index));
    Ok(())
}

// ---------------------------------------------------------------- Win32 queries

#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos only writes into the POINT we pass
    (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}

/// Is a fullscreen app (a caption-less window covering the whole monitor — games, F11 browsers, video players)
/// present on the same monitor as the overlay?
///
/// Deliberately NOT limited to the foreground window: a game stays fullscreen while it briefly loses focus (a
/// notification, alt-tabbing to Discord, a background console), and popping the Ghost back on top of it then is
/// exactly what we are avoiding. Skipped: our own windows, the desktop and taskbar, minimised and DWM-cloaked
/// windows, anything with a title bar, and layered windows — which is what other transparent overlays (Discord,
/// GeForce Experience, and DeskGhost itself) are.
#[cfg(windows)]
fn fullscreen_on_monitor(overlay: isize) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_LAYERED,
    };

    struct Ctx {
        monitor: isize,
        mon_rect: RECT,
        found: bool,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut Ctx we passed to EnumWindows, alive for the whole call
        let ctx = unsafe { &mut *(lparam as *mut Ctx) };
        unsafe {
            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == GetCurrentProcessId() {
                return 1;
            }
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if (style & WS_CAPTION) == WS_CAPTION || (ex & WS_EX_LAYERED) != 0 {
                return 1;
            }
            let mut cls = [0u16; 64];
            let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32).max(0) as usize;
            if matches!(
                String::from_utf16_lossy(&cls[..n]).as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow"
            ) {
                return 1;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            ) == 0
                && cloaked != 0
            {
                return 1;
            }
            if MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) as isize != ctx.monitor {
                return 1;
            }
            let mut r: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut r) == 0 {
                return 1;
            }
            let m = ctx.mon_rect;
            if r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom {
                ctx.found = true;
                return 0; // stop enumerating
            }
        }
        1
    }

    if overlay == 0 {
        return false;
    }
    // SAFETY: plain Win32 queries; `ctx` outlives the EnumWindows call it is passed to
    unsafe {
        let mon = MonitorFromWindow(overlay as _, MONITOR_DEFAULTTONEAREST);
        if mon.is_null() {
            return false;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return false;
        }
        let mut ctx = Ctx { monitor: mon as isize, mon_rect: mi.rcMonitor, found: false };
        EnumWindows(Some(visit), &mut ctx as *mut Ctx as LPARAM);
        ctx.found
    }
}

#[cfg(not(windows))]
fn fullscreen_on_monitor(_overlay: isize) -> bool {
    false
}

// ---------------------------------------------------------------- background threads

/// Every ~16ms: if the cursor moved and the overlay is showing, send its position in the overlay's CSS pixels.
fn start_cursor_relay<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            if !state().lock().unwrap().shown {
                last = None;
                continue;
            }
            let Some(win) = app.get_webview_window(LABEL) else { continue };
            let Some(p) = cursor_pos() else { continue };
            if last == Some(p) {
                continue;
            }
            last = Some(p);
            let (Ok(origin), Ok(scale)) = (win.inner_position(), win.scale_factor()) else { continue };
            let x = (p.0 - origin.x) as f64 / scale;
            let y = (p.1 - origin.y) as f64 / scale;
            let _ = app.emit_to(LABEL, "cursor", (x, y));
        }
    });
}

/// Twice a second: hide the overlay while a fullscreen app is in front on its monitor.
fn start_fullscreen_watch<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let (hwnd, was) = {
            let s = state().lock().unwrap();
            (s.hwnd, s.fullscreen)
        };
        let now = fullscreen_on_monitor(hwnd);
        if now != was {
            state().lock().unwrap().fullscreen = now;
            apply(&app);
        }
    });
}
