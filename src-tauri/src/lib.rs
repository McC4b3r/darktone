use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    fs::File,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use symphonia::{
    core::{
        formats::FormatOptions,
        io::{MediaSourceStream, MediaSourceStreamOptions},
        meta::{MetadataOptions, StandardTagKey, Value},
        probe::Hint,
    },
    default::{get_codecs, get_probe},
};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const LIBRARY_FILE: &str = "library.json";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    id: String,
    path: String,
    art_path: Option<String>,
    filename: String,
    title: String,
    artist: String,
    album: String,
    track_number: Option<u32>,
    duration_ms: u64,
    format: String,
    modified_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    tracks: Vec<Track>,
    scanned_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryScanResult {
    library: LibraryData,
    scanned_files: usize,
    skipped_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    music_folders: Vec<String>,
    volume: f64,
    muted: bool,
    repeat_mode: String,
    shuffle: bool,
    queue_track_ids: Vec<String>,
    current_track_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            music_folders: Vec::new(),
            volume: 0.8,
            muted: false,
            repeat_mode: "all".into(),
            shuffle: false,
            queue_track_ids: Vec::new(),
            current_track_id: None,
        }
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn read_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LIBRARY_FILE))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(SETTINGS_FILE))
}

fn supported_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            let lowered = extension.to_ascii_lowercase();
            lowered == "mp3" || lowered == "wav" || lowered == "flac"
        })
        .unwrap_or(false)
}

fn supported_art_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp"
            )
        })
        .unwrap_or(false)
}

fn art_priority(path: &Path) -> usize {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match filename.as_str() {
        "cover.jpg" | "cover.jpeg" | "cover.png" | "cover.webp" => 0,
        "folder.jpg" | "folder.jpeg" | "folder.png" | "folder.webp" => 1,
        "front.jpg" | "front.jpeg" | "front.png" | "front.webp" => 2,
        _ => 3,
    }
}

fn find_album_art(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let mut art_files = fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| candidate.is_file() && supported_art_file(candidate))
        .collect::<Vec<_>>();

    art_files.sort_by(|a, b| {
        art_priority(a)
            .cmp(&art_priority(b))
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });

    art_files
        .into_iter()
        .next()
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string()),
        Value::UnsignedInt(number) => Some(number.to_string()),
        Value::SignedInt(number) => Some(number.to_string()),
        Value::Float(number) => Some(number.to_string()),
        Value::Boolean(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn parse_track_number(value: &str) -> Option<u32> {
    value
        .split('/')
        .next()
        .and_then(|segment| segment.trim().parse::<u32>().ok())
}

fn inspect_audio_file(path: &Path) -> Result<Track, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();

    let source = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|ext| ext.to_str()) {
        hint.with_extension(extension);
    }

    let probe = get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;

    let mut format = probe.format;
    let mut title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Unknown Track")
        .to_string();
    let mut artist = "Unknown Artist".to_string();
    let mut album = "Unknown Album".to_string();
    let mut track_number = None;

    if let Some(metadata_revision) = format.metadata().current() {
        for tag in metadata_revision.tags() {
            let Some(text) = value_to_string(&tag.value) else {
                continue;
            };

            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => title = text,
                Some(StandardTagKey::Artist) => artist = text,
                Some(StandardTagKey::Album) => album = text,
                Some(StandardTagKey::TrackNumber) => track_number = parse_track_number(&text),
                _ => {}
            }
        }
    }

    let duration_ms = format
        .default_track()
        .and_then(|track| {
            track
                .codec_params
                .time_base
                .zip(track.codec_params.n_frames)
                .map(|(time_base, n_frames)| {
                    let time = time_base.calc_time(n_frames);
                    (time.seconds * 1000) + (time.frac * 1000.0) as u64
                })
        })
        .unwrap_or_default();

    let format_name = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let full_path = path.to_string_lossy().to_string();

    let track = Track {
        id: full_path.clone(),
        path: full_path,
        art_path: find_album_art(path),
        filename,
        title,
        artist,
        album,
        track_number,
        duration_ms,
        format: format_name,
        modified_at,
    };

    let _ = get_codecs();
    Ok(track)
}

#[tauri::command]
async fn scan_library(app: AppHandle, folders: Vec<String>) -> Result<LibraryScanResult, String> {
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut tracks = Vec::new();
        let mut seen_paths = HashSet::new();
        let mut scanned_files = 0usize;
        let mut skipped_files = 0usize;

        for folder in folders {
            for entry in WalkDir::new(folder)
                .follow_links(true)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
            {
                let path = entry.path();
                if !supported_file(path) {
                    skipped_files += 1;
                    continue;
                }

                 let dedupe_key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                 if !seen_paths.insert(dedupe_key) {
                    continue;
                 }

                match inspect_audio_file(path) {
                    Ok(track) => {
                        scanned_files += 1;
                        tracks.push(track);
                    }
                    Err(_) => {
                        skipped_files += 1;
                    }
                }
            }
        }

        tracks.sort_by(|a, b| a.path.cmp(&b.path));

        let library = LibraryData {
            tracks,
            scanned_at: Some(
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default(),
            ),
        };

        Ok::<LibraryScanResult, String>(LibraryScanResult {
            library,
            scanned_files,
            skipped_files,
        })
    })
    .await
    .map_err(|error| error.to_string())??;

    write_json(&library_path(&app)?, &output.library)?;

    Ok(output)
}

#[tauri::command]
fn load_library(app: AppHandle) -> Result<LibraryData, String> {
    let path = library_path(&app)?;
    if !path.exists() {
        return Ok(LibraryData {
            tracks: Vec::new(),
            scanned_at: None,
        });
    }

    read_json(&path)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    write_json(&settings_path(&app)?, &settings)
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    read_json(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            load_library,
            save_settings,
            load_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
