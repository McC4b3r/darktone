use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    fs::File,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Instant,
    time::UNIX_EPOCH,
};
use symphonia::{
    core::{
        audio::SampleBuffer,
        codecs::{DecoderOptions, CODEC_TYPE_NULL},
        errors::Error as SymphoniaError,
        formats::FormatOptions,
        io::{MediaSourceStream, MediaSourceStreamOptions},
        meta::{MetadataOptions, StandardTagKey, Value},
        probe::Hint,
    },
    default::{get_codecs, get_probe},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};
use walkdir::WalkDir;

const LIBRARY_FILE: &str = "library.json";
const SETTINGS_FILE: &str = "settings.json";
const LIBRARY_SCAN_PROGRESS_EVENT: &str = "library-scan-progress";

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
    release_year: Option<u32>,
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
    unsupported_files: usize,
    unreadable_entries: usize,
    unreadable_audio_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LibraryScanPhase {
    Discovering,
    Scanning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryScanProgress {
    phase: LibraryScanPhase,
    current: usize,
    total: Option<usize>,
    current_folder: Option<String>,
    folders_completed: usize,
    folder_count: usize,
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

fn parse_release_year(value: &str) -> Option<u32> {
    let digits = value
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();

    if digits.len() < 4 {
        return None;
    }

    digits.get(0..4)?.parse::<u32>().ok()
}

fn open_audio_format(path: &Path) -> Result<symphonia::core::probe::ProbeResult, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let source = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|ext| ext.to_str()) {
        hint.with_extension(extension);
    }

    get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())
}

fn fallback_track(path: &Path) -> Result<Track, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
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

    Ok(Track {
        id: full_path.clone(),
        path: full_path,
        art_path: find_album_art(path),
        filename: filename.clone(),
        title: path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&filename)
            .to_string(),
        artist: path
            .parent()
            .and_then(|parent| parent.parent())
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Unknown Artist")
            .to_string(),
        album: path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Unknown Album")
            .to_string(),
        release_year: None,
        track_number: None,
        duration_ms: 0,
        format: format_name,
        modified_at,
    })
}

fn inspect_audio_file(path: &Path) -> Result<Track, String> {
    let mut track = fallback_track(path)?;
    let probe = open_audio_format(path)?;

    let mut format = probe.format;

    if let Some(metadata_revision) = format.metadata().current() {
        for tag in metadata_revision.tags() {
            let Some(text) = value_to_string(&tag.value) else {
                continue;
            };

            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => track.title = text,
                Some(StandardTagKey::Artist) => track.artist = text,
                Some(StandardTagKey::Album) => track.album = text,
                Some(StandardTagKey::ReleaseDate)
                | Some(StandardTagKey::OriginalDate)
                | Some(StandardTagKey::Date) => {
                    track.release_year = parse_release_year(&text).or(track.release_year)
                }
                Some(StandardTagKey::TrackNumber) => track.track_number = parse_track_number(&text),
                _ => {}
            }
        }
    }

    track.duration_ms = format
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

    let _ = get_codecs();
    Ok(track)
}

fn encode_wav_from_pcm_i16(samples: &[i16], sample_rate: u32, channel_count: u16) -> Result<Vec<u8>, String> {
    if channel_count == 0 {
        return Err("Decoded audio has no channels.".into());
    }

    let bits_per_sample = 16u16;
    let bytes_per_sample = u32::from(bits_per_sample / 8);
    let data_size = (samples.len() as u32)
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| "Decoded audio is too large to encode as WAV.".to_string())?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(channel_count))
        .and_then(|value| value.checked_mul(bytes_per_sample))
        .ok_or_else(|| "Decoded audio byte rate overflowed WAV limits.".to_string())?;
    let block_align = channel_count
        .checked_mul(bits_per_sample / 8)
        .ok_or_else(|| "Decoded audio block alignment overflowed WAV limits.".to_string())?;
    let riff_size = 36u32
        .checked_add(data_size)
        .ok_or_else(|| "Decoded audio exceeded WAV container size limits.".to_string())?;

    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channel_count.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());

    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(wav)
}

fn decode_audio_to_wav_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let probe = open_audio_format(path)?;
    let mut format = probe.format;

    let track = format
        .default_track()
        .ok_or_else(|| "The audio file does not contain a playable default track.".to_string())?;

    if track.codec_params.codec == CODEC_TYPE_NULL {
        return Err("The audio file uses an unsupported codec.".into());
    }

    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| error.to_string())?;
    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut channel_count = track
        .codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .unwrap_or(0);
    let mut pcm_samples = Vec::<i16>::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("The audio decoder requested a reset while decoding playback data.".into())
            }
            Err(error) => return Err(error.to_string()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("The audio decoder requested a reset while decoding playback data.".into())
            }
            Err(error) => return Err(error.to_string()),
        };

        sample_rate = decoded.spec().rate;
        channel_count = decoded.spec().channels.count() as u16;

        let mut sample_buffer = SampleBuffer::<i16>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buffer.copy_interleaved_ref(decoded);
        pcm_samples.extend_from_slice(sample_buffer.samples());
    }

    if pcm_samples.is_empty() {
        return Err("The audio file did not produce any decoded PCM samples.".into());
    }

    encode_wav_from_pcm_i16(&pcm_samples, sample_rate, channel_count)
}

fn emit_scan_progress(app: &AppHandle, progress: LibraryScanProgress) {
    let _ = app.emit(LIBRARY_SCAN_PROGRESS_EVENT, progress);
}

#[tauri::command]
async fn scan_library(app: AppHandle, folders: Vec<String>) -> Result<LibraryScanResult, String> {
    let progress_app = app.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut tracks = Vec::new();
        let mut candidate_files = Vec::new();
        let mut seen_paths = HashSet::new();
        let mut scanned_files = 0usize;
        let mut skipped_files = 0usize;
        let mut unsupported_files = 0usize;
        let mut unreadable_entries = 0usize;
        let mut unreadable_audio_files = 0usize;
        let folder_count = folders.len();
        let mut last_progress_emit = Instant::now();

        for (folder_index, folder) in folders.iter().enumerate() {
            for entry in WalkDir::new(folder).follow_links(true).into_iter() {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        skipped_files += 1;
                        unreadable_entries += 1;
                        continue;
                    }
                };

                if !entry.file_type().is_file() {
                    continue;
                }

                let path = entry.path();
                if !supported_file(path) {
                    skipped_files += 1;
                    unsupported_files += 1;
                    continue;
                }

                let dedupe_key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                if !seen_paths.insert(dedupe_key) {
                    continue;
                }

                candidate_files.push(path.to_path_buf());

                if candidate_files.len() == 1 || candidate_files.len() % 50 == 0 || last_progress_emit.elapsed().as_millis() >= 120 {
                    emit_scan_progress(
                        &progress_app,
                        LibraryScanProgress {
                            phase: LibraryScanPhase::Discovering,
                            current: candidate_files.len(),
                            total: None,
                            current_folder: Some(folder.clone()),
                            folders_completed: folder_index,
                            folder_count,
                        },
                    );
                    last_progress_emit = Instant::now();
                }
            }

            emit_scan_progress(
                &progress_app,
                LibraryScanProgress {
                    phase: LibraryScanPhase::Discovering,
                    current: candidate_files.len(),
                    total: None,
                    current_folder: Some(folder.clone()),
                    folders_completed: folder_index + 1,
                    folder_count,
                },
            );
        }

        let total_candidates = candidate_files.len();
        emit_scan_progress(
            &progress_app,
            LibraryScanProgress {
                phase: LibraryScanPhase::Scanning,
                current: 0,
                total: Some(total_candidates),
                current_folder: None,
                folders_completed: folder_count,
                folder_count,
            },
        );

        last_progress_emit = Instant::now();

        for (index, path) in candidate_files.into_iter().enumerate() {
            match inspect_audio_file(&path) {
                Ok(track) => {
                    scanned_files += 1;
                    tracks.push(track);
                }
                Err(_) => match fallback_track(&path) {
                    Ok(track) => {
                        scanned_files += 1;
                        tracks.push(track);
                    }
                    Err(_) => {
                        skipped_files += 1;
                        unreadable_audio_files += 1;
                    }
                },
            }

            let processed = index + 1;
            if processed == 1 || processed == total_candidates || processed % 25 == 0 || last_progress_emit.elapsed().as_millis() >= 120 {
                emit_scan_progress(
                    &progress_app,
                    LibraryScanProgress {
                        phase: LibraryScanPhase::Scanning,
                        current: processed,
                        total: Some(total_candidates),
                        current_folder: path
                            .parent()
                            .map(|parent| parent.to_string_lossy().to_string()),
                        folders_completed: folder_count,
                        folder_count,
                    },
                );
                last_progress_emit = Instant::now();
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
            unsupported_files,
            unreadable_entries,
            unreadable_audio_files,
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

#[tauri::command]
fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn decode_audio_for_playback(path: String) -> Result<Vec<u8>, String> {
    decode_audio_to_wav_bytes(Path::new(&path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let open = MenuItem::with_id(app, "file_open", "Open", true, Some("CmdOrCtrl+O"))?;
            let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
            let file_menu = Submenu::with_items(app, "File", true, &[&open, &quit])?;
            let menu = Menu::with_items(app, &[&file_menu])?;
            app.set_menu(menu)?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "file_open" {
                let _ = app.emit("menu-open", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            load_library,
            save_settings,
            load_settings,
            read_audio_file,
            decode_audio_for_playback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::encode_wav_from_pcm_i16;

    #[test]
    fn encodes_pcm_i16_as_valid_wav() {
        let wav = encode_wav_from_pcm_i16(&[0, 1024, -1024, 32767], 48_000, 2).expect("wav encoding should succeed");

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().expect("sample rate bytes")), 48_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().expect("channel count bytes")), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().expect("bit depth bytes")), 16);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().expect("data size bytes")), 8);
        assert_eq!(wav.len(), 52);
        assert_eq!(&wav[44..52], &[0, 0, 0, 4, 0, 252, 255, 127]);
    }

    #[test]
    fn rejects_zero_channel_audio() {
        let error = encode_wav_from_pcm_i16(&[1, 2], 44_100, 0).expect_err("zero channels must fail");
        assert!(error.contains("no channels"));
    }
}
