//! The item catalog: every Ghost shell and shader, built on the user's machine from Bungie's public manifest.
//!
//! Nothing from Bungie ships with the app. On first run (or when the user rebuilds) this downloads the public
//! world-content SQLite (~37 MB zipped) and gear-asset SQLite (~8 MB), pulls out the shells + shaders, writes a
//! small `catalog.json`, prefetches the icons into the disk cache, and deletes the big databases again.
//!
//! catalog.json:
//!   { version, builtAt, items: { "<hash>": { kind: "shell"|"shader", name, icon, tier, tierName, flavor, index,
//!                                           translationBlock: { defaultDyes, lockedDyes, customDyes },
//!                                           gear: <DestinyGearAssetsDefinition json> } } }
//! `gear` is exactly what the web renderer (ghost-shell-source.js) used to read from the gear DB, and
//! `translationBlock` is what it used to fetch from the site API for shader dye channels.

use std::collections::{BTreeSet, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use futures::StreamExt;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::cache::{self, BUNGIE};

const MANIFEST_URL: &str = "https://www.bungie.net/Platform/Destiny2/Manifest/";
const GHOST_BUCKET: u64 = 4023194814;
const ITEM_TYPE_GHOST: u64 = 24;

fn catalog_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("catalog.json"))
}

pub fn catalog_exists<R: Runtime>(app: &AppHandle<R>) -> bool {
    catalog_path(app).map(|p| p.exists()).unwrap_or(false)
}

#[derive(Clone, Serialize)]
struct Progress {
    stage: &'static str,
    message: String,
    done: u64,
    total: u64,
}

fn progress<R: Runtime>(app: &AppHandle<R>, stage: &'static str, message: impl Into<String>, done: u64, total: u64) {
    let _ = app.emit("setup-progress", Progress { stage, message: message.into(), done, total });
}

/// The catalog as raw JSON bytes (the page parses it), or an empty response if it has not been built.
#[tauri::command]
pub async fn get_catalog(app: AppHandle) -> tauri::ipc::Response {
    let bytes = match catalog_path(&app) {
        Ok(p) => tokio::fs::read(p).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    tauri::ipc::Response::new(bytes)
}

/// Bungie's current manifest version, or an error if Bungie can't be reached.
async fn manifest() -> Result<Value, String> {
    let resp = cache::client().get(MANIFEST_URL).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Bungie manifest: HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if v["ErrorCode"].as_i64() != Some(1) {
        return Err(format!("Bungie manifest: {}", v["Message"].as_str().unwrap_or("error")));
    }
    Ok(v["Response"].clone())
}

/// Some(new version) when Bungie has published a newer manifest than the one the catalog was built from.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let path = catalog_path(&app)?;
    let current: Value = serde_json::from_slice(&tokio::fs::read(&path).await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let latest = manifest().await?;
    let latest_version = latest["version"].as_str().unwrap_or_default().to_string();
    Ok((current["version"].as_str() != Some(latest_version.as_str())).then_some(latest_version))
}

/// Download `path` from bungie.net into `dest`, reporting progress as it goes.
async fn download<R: Runtime>(app: &AppHandle<R>, path: &str, dest: &Path, label: &str) -> Result<(), String> {
    let url = format!("{BUNGIE}{path}");
    let mut resp = cache::client().get(&url).send().await.map_err(|e| format!("{label}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{label}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut done = 0u64;
    let mut last = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{label}: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last > 512 * 1024 || done == total {
            last = done;
            progress(app, "download", format!("Downloading {label}"), done, total);
        }
    }
    Ok(())
}

/// Bungie's `.content` files are a ZIP (or occasionally gzip) around a single SQLite file.
fn unwrap_sqlite(src: &Path, dest: &Path) -> Result<(), String> {
    let mut head = [0u8; 2];
    std::fs::File::open(src).and_then(|mut f| f.read_exact(&mut head)).map_err(|e| e.to_string())?;
    let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    match head {
        [0x50, 0x4b] => {
            let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            let idx = (0..zip.len())
                .find(|&i| zip.by_index(i).map(|f| f.is_file()).unwrap_or(false))
                .ok_or("empty archive")?;
            let mut entry = zip.by_index(idx).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        [0x1f, 0x8b] => {
            std::io::copy(&mut flate2::read::GzDecoder::new(file), &mut out).map_err(|e| e.to_string())?;
        }
        _ => {
            drop(out);
            std::fs::copy(src, dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn row_text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8(t.to_vec()).ok(),
        _ => None,
    }
}

fn gear_entry(gear: &Connection, hash: u64) -> Option<Value> {
    let signed = hash as u32 as i32 as i64;
    let mut stmt = gear.prepare_cached("SELECT json FROM DestinyGearAssetsDefinition WHERE id = ?1 OR id = ?2").ok()?;
    let text: String = stmt.query_row([signed, hash as i64], |r| Ok(row_text(r.get_ref(0)?))).ok()??;
    serde_json::from_str(&text).ok()
}

fn has_geometry(gear: &Value) -> bool {
    gear["content"]
        .as_array()
        .map(|c| c.iter().any(|x| x["geometry"].as_array().map_or(false, |g| !g.is_empty())))
        .unwrap_or(false)
}

/// Only the dye-channel lists the renderer uses (the full translationBlock also carries arrangements etc.).
fn slim_translation(tb: &Value) -> Value {
    let mut m = Map::new();
    for k in ["defaultDyes", "lockedDyes", "customDyes"] {
        if let Some(v) = tb.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    Value::Object(m)
}

/// Pull every shell + shader out of the two databases. Duplicate re-issues (same name, same model/dyes) are
/// collapsed to one entry. Returns the `items` map and counts.
fn extract(world: &Path, gear_db: &Path) -> Result<(Map<String, Value>, usize, usize), String> {
    let ro = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let world = Connection::open_with_flags(world, ro).map_err(|e| e.to_string())?;
    let gear = Connection::open_with_flags(gear_db, ro).map_err(|e| e.to_string())?;

    let mut stmt = world.prepare("SELECT json FROM DestinyInventoryItemDefinition").map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut items = Map::new();
    let mut seen = HashSet::new();
    let (mut shells, mut shaders) = (0usize, 0usize);
    let bucket = GHOST_BUCKET.to_string();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let Some(text) = row.get_ref(0).ok().and_then(row_text) else { continue };
        // cheap pre-filter before parsing ~all items in the game
        if !text.contains(&bucket) && !text.contains("\"shader\"") {
            continue;
        }
        let Ok(def) = serde_json::from_str::<Value>(&text) else { continue };
        if def["redacted"].as_bool() == Some(true) {
            continue;
        }
        let is_shell = def["inventory"]["bucketTypeHash"].as_u64() == Some(GHOST_BUCKET)
            && def["itemType"].as_u64() == Some(ITEM_TYPE_GHOST);
        let is_shader = def["plug"]["plugCategoryIdentifier"].as_str() == Some("shader")
            && def["translationBlock"]["customDyes"].as_array().map_or(false, |d| !d.is_empty());
        if !is_shell && !is_shader {
            continue;
        }
        let name = def["displayProperties"]["name"].as_str().unwrap_or("").trim().to_string();
        let Some(hash) = def["hash"].as_u64() else { continue };
        if name.is_empty() || name.eq_ignore_ascii_case("classified") {
            continue;
        }
        let Some(gear_json) = gear_entry(&gear, hash) else { continue };
        if is_shell && !has_geometry(&gear_json) {
            continue;
        }
        if gear_json["gear"].as_array().map_or(true, |g| g.is_empty()) {
            continue;
        }
        let tb = slim_translation(&def["translationBlock"]);
        let dedupe = if is_shell {
            format!("shell|{name}|{}|{}", gear_json["content"][0]["geometry"], gear_json["gear"])
        } else {
            format!("shader|{name}|{}", tb["customDyes"])
        };
        if !seen.insert(dedupe) {
            continue;
        }
        if is_shell { shells += 1 } else { shaders += 1 }
        items.insert(
            hash.to_string(),
            json!({
                "kind": if is_shell { "shell" } else { "shader" },
                "name": name,
                "icon": def["displayProperties"]["icon"],
                "tier": def["inventory"]["tierType"],
                "tierName": def["inventory"]["tierTypeName"],
                "flavor": def["flavorText"],
                "index": def["index"],
                "translationBlock": tb,
                "gear": gear_json,
            }),
        );
    }
    Ok((items, shells, shaders))
}

#[derive(Serialize)]
pub struct SetupResult {
    shells: usize,
    shaders: usize,
    icons_failed: usize,
    version: String,
}

static SETUP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const WORK_PREFIX: &str = "deskghost-setup-";

/// Remove setup work folders left in %TEMP% by a run that crashed or was killed (they hold ~150 MB of databases).
pub fn clean_stale_work_dirs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with(WORK_PREFIX) && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Build (or rebuild) the catalog and prefetch every icon. Emits `setup-progress` events throughout.
/// Only one run at a time: a second call while one is in progress is refused.
#[tauri::command]
pub async fn run_setup(app: AppHandle) -> Result<SetupResult, String> {
    use std::sync::atomic::Ordering;
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("setup is already running".into());
    }
    let result = run_setup_inner(app).await;
    SETUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn run_setup_inner(app: AppHandle) -> Result<SetupResult, String> {
    progress(&app, "manifest", "Contacting Bungie", 0, 0);
    let man = manifest().await?;
    let version = man["version"].as_str().unwrap_or_default().to_string();
    let world_path = man["mobileWorldContentPaths"]["en"].as_str().ok_or("manifest has no world content")?.to_string();
    let gear_path = man["mobileGearAssetDataBases"]
        .as_array()
        .and_then(|a| a.iter().max_by_key(|d| d["version"].as_i64().unwrap_or(0)))
        .and_then(|d| d["path"].as_str())
        .ok_or("manifest has no gear asset database")?
        .to_string();

    let work = std::env::temp_dir().join(format!("{WORK_PREFIX}{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = build_in(&app, &work, &version, &world_path, &gear_path).await;
    let _ = std::fs::remove_dir_all(&work); // the big databases are never kept
    let (shells, shaders, icons) = result?;

    // icons, so the picker can show every shell and shader (cached like any other Bungie file)
    let total = icons.len() as u64;
    let mut done = 0u64;
    let mut failed = 0usize;
    let mut fetches = futures::stream::iter(icons.into_iter().map(|icon| {
        let app = app.clone();
        async move { cache::fetch_cached(&app, &icon).await.is_ok() }
    }))
    .buffer_unordered(12);
    while let Some(ok) = fetches.next().await {
        done += 1;
        if !ok {
            failed += 1;
        }
        if done % 8 == 0 || done == total {
            progress(&app, "icons", "Downloading icons", done, total);
        }
    }
    progress(&app, "done", "Ready", 1, 1);
    let _ = app.emit("catalog-updated", ());
    Ok(SetupResult { shells, shaders, icons_failed: failed, version })
}

async fn build_in<R: Runtime>(
    app: &AppHandle<R>,
    work: &Path,
    version: &str,
    world_path: &str,
    gear_path: &str,
) -> Result<(usize, usize, Vec<String>), String> {
    let (world_zip, gear_zip) = (work.join("world.content"), work.join("gear.content"));
    download(app, world_path, &world_zip, "the item list").await?;
    download(app, gear_path, &gear_zip, "the gear asset list").await?;

    progress(app, "extract", "Finding every Ghost shell and shader", 0, 0);
    let work = work.to_path_buf();
    let (items, shells, shaders) = tauri::async_runtime::spawn_blocking(move || {
        let (world_db, gear_db) = (work.join("world.sqlite"), work.join("gear.sqlite"));
        unwrap_sqlite(&work.join("world.content"), &world_db)?;
        unwrap_sqlite(&work.join("gear.content"), &gear_db)?;
        extract(&world_db, &gear_db)
    })
    .await
    .map_err(|e| e.to_string())??;
    if shells == 0 {
        return Err("no Ghost shells found in Bungie's manifest".into());
    }

    let icons: Vec<String> = items
        .values()
        .filter_map(|v| v["icon"].as_str().map(str::to_string))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let catalog = json!({ "version": version, "builtAt": built_at, "items": items });
    let path = catalog_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, serde_json::to_vec(&catalog).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok((shells, shaders, icons))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real unzip + extraction on Bungie's databases. Download the two `.content` files (paths from
    /// the /Manifest/ response) and run:
    ///   set DESKGHOST_TEST_DATA=<folder with world.content + gear.content> && cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn extract_real_manifest() {
        let dir = PathBuf::from(std::env::var("DESKGHOST_TEST_DATA").expect("DESKGHOST_TEST_DATA"));
        let (world, gear) = (dir.join("world.sqlite"), dir.join("gear.sqlite"));
        unwrap_sqlite(&dir.join("world.content"), &world).unwrap();
        unwrap_sqlite(&dir.join("gear.content"), &gear).unwrap();
        let t = std::time::Instant::now();
        let (items, shells, shaders) = extract(&world, &gear).unwrap();
        println!("shells {shells}, shaders {shaders} in {:?}", t.elapsed());
        let size = serde_json::to_vec(&items).unwrap().len();
        println!("catalog items json: {:.1} MB", size as f64 / 1048576.0);
        for hash in ["2313814566", "1649523396", "4109206892", "4283023982"] {
            let it = &items[hash];
            println!("{hash}: {} / {} / gear files {}", it["name"], it["tierName"], it["gear"]["gear"]);
        }
        std::fs::write(dir.join("catalog-test.json"), serde_json::to_vec(&items).unwrap()).unwrap();
        assert!(shells > 300 && shaders > 300);
    }
}
