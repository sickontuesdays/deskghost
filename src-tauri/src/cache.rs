//! Disk cache in front of Bungie's public content server.
//!
//! The web side never talks to bungie.net directly: it requests `http://bungie.localhost/<path>` (the `bungie`
//! URI scheme registered in main.rs) and this module answers from `<cache dir>/bungie/<path>`, downloading
//! `https://www.bungie.net/<path>` once on a miss. Only `/common/destiny2_content/...` paths are allowed — that
//! is where all public game content lives (geometry, textures, dye files, icons), and none of it needs an API key.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

pub const BUNGIE: &str = "https://www.bungie.net";
const ALLOWED_PREFIX: &str = "/common/destiny2_content/";

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("DeskGhost/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("http client")
    })
}

pub fn cache_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("DeskGhost"))
        .join("bungie")
}

/// True for a path we are willing to fetch and store: public content only, no traversal tricks. Bungie's content
/// paths are plain lowercase/hex names, so anything outside a strict character set (percent-escapes, backslashes,
/// drive colons, Windows device names) is refused rather than interpreted.
fn allowed(path: &str) -> bool {
    path.starts_with(ALLOWED_PREFIX)
        && path.len() < 512
        && !path.contains("..")
        && !path.contains("//")
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'))
        && path.split('/').all(|seg| {
            let stem = seg.split('.').next().unwrap_or("").to_ascii_lowercase();
            !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                && !(stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.as_bytes()[3].is_ascii_digit())
        })
}

/// The bytes at `path` (a bungie.net path such as `/common/destiny2_content/icons/x.jpg`), from the disk cache
/// or downloaded and cached.
pub async fn fetch_cached<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<Vec<u8>, String> {
    if !allowed(path) {
        return Err(format!("not a Bungie content path: {path}"));
    }
    let file = cache_root(app).join(path.trim_start_matches('/'));
    if let Ok(bytes) = tokio::fs::read(&file).await {
        return Ok(bytes);
    }
    let url = format!("{BUNGIE}{path}");
    let resp = client().get(&url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("{url}: {e}"))?.to_vec();
    if let Some(dir) = file.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    // write to a temp name then rename, so a crash mid-write never leaves a truncated file in the cache
    let tmp = file.with_extension("part");
    if tokio::fs::write(&tmp, &bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, &file).await;
    }
    Ok(bytes)
}

fn content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".js") || lower.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

/// Handler for the `bungie` URI scheme.
pub async fn serve<R: Runtime>(app: AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let (status, ctype, body) = match fetch_cached(&app, &path).await {
        Ok(bytes) => (StatusCode::OK, content_type(&path), bytes),
        Err(e) => {
            let status = if allowed(&path) { StatusCode::BAD_GATEWAY } else { StatusCode::FORBIDDEN };
            (status, "text/plain", e.into_bytes())
        }
    };
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "max-age=31536000, immutable")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Bytes used by downloaded shells, shaders and icons.
#[tauri::command]
pub async fn cache_size(app: AppHandle) -> u64 {
    let root = cache_root(&app);
    tauri::async_runtime::spawn_blocking(move || dir_size(&root)).await.unwrap_or(0)
}

/// Delete every downloaded shell/shader file but keep the icons (so the picker still works offline).
#[tauri::command]
pub async fn clear_model_cache(app: AppHandle) -> Result<(), String> {
    let geometry = cache_root(&app).join("common/destiny2_content/geometry");
    match tokio::fs::remove_dir_all(&geometry).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn content_paths_only() {
        assert!(allowed("/common/destiny2_content/icons/a1b2c3.jpg"));
        assert!(allowed("/common/destiny2_content/geometry/platform/mobile/geometry/2d83f4681ce3bb73305136d6304fbd07.tgxm"));
        assert!(allowed("/common/destiny2_content/geometry/gear/ec72cf9ba446fd940e2134544bcd711d.js"));
        for bad in [
            "/Platform/Destiny2/Manifest/",
            "/common/destiny2_content/../../etc/passwd",
            "/common/destiny2_content/%2e%2e/%2e%2e/x",
            r"/common/destiny2_content/icons/..\..\x",
            "/common/destiny2_content/icons/C:/Windows/x",
            "/common/destiny2_content//icons/x",
            "/common/destiny2_content/icons/CON",
            "/common/destiny2_content/icons/nul.txt",
            "/common/destiny2_content/icons/com1.png",
            "/common/destiny2_content/icons/a b.png",
        ] {
            assert!(!allowed(bad), "should refuse {bad}");
        }
    }
}
