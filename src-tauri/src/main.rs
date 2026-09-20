// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod catalog;
mod overlay;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN: &str = "main";

/// Show the picker/settings window, creating it if needed. It is destroyed when closed (freeing its preview's
/// GPU context); the app keeps running in the tray with the overlay.
fn open_main(app: &AppHandle) {
    open_main_at(app, None);
}

/// Open the main window on a given tab ("ghost" or "settings").
fn open_main_at(app: &AppHandle, tab: Option<&str>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(tab) = tab {
            let _ = app.emit_to(MAIN, "open-tab", tab);
        }
        return;
    }
    // a fresh window isn't listening yet, so the tab goes in the URL instead of an event
    let url = match tab {
        Some(tab) => format!("app.html#{tab}"),
        None => "app.html".into(),
    };
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App(url.into()))
        .title("DeskGhost")
        .inner_size(1180.0, 780.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("could not open the main window: {e}");
    }
}

// async: building a window inside a synchronous command deadlocks on Windows
#[tauri::command]
async fn show_main(app: AppHandle) {
    open_main(&app);
}

/// The links the About tab offers. An allow-list, so this command can only ever open these two pages.
const EXTERNAL_LINKS: [&str; 2] = ["https://www.sickontuesdays.com", "https://discord.gg/RHqRfumhrz"];

/// Open one of those links in the user's default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !EXTERNAL_LINKS.contains(&url.as_str()) {
        return Err("not an allowed link".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let (op, file) = (wide("open"), wide(&url));
        // SAFETY: both strings are null-terminated and live until the call returns; the URL is from the list above
        let rc = unsafe {
            ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL as i32)
        };
        // ShellExecuteW returns a value > 32 on success
        if (rc as isize) <= 32 {
            return Err("Windows could not open the link".into());
        }
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let choose = MenuItem::with_id(app, "choose", "Choose Ghost…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide Ghost", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DeskGhost", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&choose, &toggle, &settings, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("deskghost")
        .tooltip("DeskGhost")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "choose" => open_main(app),
            "settings" => open_main_at(app, Some("settings")),
            "toggle" => {
                let _ = app.emit_to(overlay::LABEL, "ghost-cmd", serde_json::json!({ "cmd": "toggle" }));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                open_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // a second launch just brings up the existing app's window
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_main(app)))
        // program updates: checked and installed only when the user asks (see the Updates card in Settings)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // http://bungie.localhost/<path> → disk cache, or https://www.bungie.net/<path> once
        .register_asynchronous_uri_scheme_protocol("bungie", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(cache::serve(app, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            show_main,
            open_external,
            catalog::get_catalog,
            catalog::run_setup,
            catalog::check_update,
            overlay::list_monitors,
            overlay::set_monitor,
            overlay::set_ghost_on,
            overlay::get_overlay_prefs,
            overlay::set_hide_fullscreen,
            cache::cache_size,
            cache::clear_model_cache,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            catalog::clean_stale_work_dirs(); // safe: single-instance guarantees no other run is using them
            overlay::create(&handle)?;
            build_tray(&handle)?;
            // first run (no catalog yet) → open the window so setup can run; the overlay also asks for it
            // when no Ghost has been picked yet
            if !catalog::catalog_exists(&handle) {
                open_main(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DeskGhost");
}
