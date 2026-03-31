use http_range::HttpRange;
use percent_encoding::percent_decode;
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    collections::HashMap,
    collections::HashSet,
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
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
    http::{header, Method, Request, Response, StatusCode},
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};
use walkdir::WalkDir;

const LIBRARY_FILE: &str = "library.json";
const SETTINGS_FILE: &str = "settings.json";
const LIBRARY_SCAN_PROGRESS_EVENT: &str = "library-scan-progress";
const PLAYBACK_FILE_PROTOCOL: &str = "playback";
const PLAYBACK_DECODE_CACHE_DIR: &str = "playback-cache";
const WAV_HEADER_SIZE: usize = 44;
const PLAYBACK_MAX_RANGE_LEN: u64 = 1000 * 1024;

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
struct LibrarySyncResult {
    library: LibraryData,
    scanned_files: usize,
    added_files: usize,
    updated_files: usize,
    removed_files: usize,
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum LibrarySyncTarget {
    File(PathBuf),
    Directory(PathBuf),
}

#[derive(Debug, Clone)]
struct AlbumArtCacheEntry {
    directory_modified_at: Option<u64>,
    art_path: Option<String>,
}

type AlbumArtCache = HashMap<PathBuf, AlbumArtCacheEntry>;

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

fn playback_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app_data_dir(app)?.join(PLAYBACK_DECODE_CACHE_DIR);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn empty_library() -> LibraryData {
    LibraryData {
        tracks: Vec::new(),
        scanned_at: None,
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn path_modified_at(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
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

fn scan_album_art_directory(path: &Path) -> Option<String> {
    fs::read_dir(path)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let is_file = entry.file_type().ok()?.is_file();
            (is_file && supported_art_file(&path)).then_some(path)
        })
        .min_by(|a, b| {
            art_priority(a)
                .cmp(&art_priority(b))
                .then_with(|| a.file_name().cmp(&b.file_name()))
        })
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn find_album_art(path: &Path, album_art_cache: &mut AlbumArtCache) -> Option<String> {
    let parent = path.parent()?;
    let directory_modified_at = path_modified_at(parent);

    if let Some(cached_entry) = album_art_cache.get(parent) {
        if cached_entry.directory_modified_at == directory_modified_at {
            return cached_entry.art_path.clone();
        }
    }

    let art_path = scan_album_art_directory(parent);
    album_art_cache.insert(
        parent.to_path_buf(),
        AlbumArtCacheEntry {
            directory_modified_at,
            art_path: art_path.clone(),
        },
    );

    art_path
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

fn fallback_track(path: &Path, album_art_cache: &mut AlbumArtCache) -> Result<Track, String> {
    fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_at = path_modified_at(path).unwrap_or_default();

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
        art_path: find_album_art(path, album_art_cache),
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

fn inspect_audio_file(path: &Path, album_art_cache: &mut AlbumArtCache) -> Result<Track, String> {
    let mut track = fallback_track(path, album_art_cache)?;
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

fn build_wav_header(
    data_size: u32,
    sample_rate: u32,
    channel_count: u16,
) -> Result<Vec<u8>, String> {
    if channel_count == 0 {
        return Err("Decoded audio has no channels.".into());
    }

    let bits_per_sample = 16u16;
    let bytes_per_sample = u32::from(bits_per_sample / 8);
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

    let mut wav = Vec::with_capacity(WAV_HEADER_SIZE);
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

    Ok(wav)
}

#[cfg(test)]
fn encode_wav_from_pcm_i16(
    samples: &[i16],
    sample_rate: u32,
    channel_count: u16,
) -> Result<Vec<u8>, String> {
    let bytes_per_sample = 2u32;
    let data_size = (samples.len() as u32)
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| "Decoded audio is too large to encode as WAV.".to_string())?;
    let mut wav = build_wav_header(data_size, sample_rate, channel_count)?;

    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(wav)
}

fn decode_audio_to_wav_file(path: &Path, output_path: &Path) -> Result<(), String> {
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
    let mut output = File::create(output_path).map_err(|error| error.to_string())?;
    output
        .write_all(&vec![0u8; WAV_HEADER_SIZE])
        .map_err(|error| error.to_string())?;
    let mut data_size = 0u64;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(
                    "The audio decoder requested a reset while decoding playback data.".into(),
                )
            }
            Err(error) => return Err(error.to_string()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(
                    "The audio decoder requested a reset while decoding playback data.".into(),
                )
            }
            Err(error) => return Err(error.to_string()),
        };

        sample_rate = decoded.spec().rate;
        channel_count = decoded.spec().channels.count() as u16;

        let mut sample_buffer =
            SampleBuffer::<i16>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buffer.copy_interleaved_ref(decoded);
        let chunk_size = (sample_buffer.samples().len() as u64)
            .checked_mul(2)
            .ok_or_else(|| "Decoded audio is too large to encode as WAV.".to_string())?;
        data_size = data_size
            .checked_add(chunk_size)
            .ok_or_else(|| "Decoded audio exceeded WAV container size limits.".to_string())?;

        for sample in sample_buffer.samples() {
            output
                .write_all(&sample.to_le_bytes())
                .map_err(|error| error.to_string())?;
        }
    }

    if data_size == 0 {
        return Err("The audio file did not produce any decoded PCM samples.".into());
    }

    let data_size = u32::try_from(data_size)
        .map_err(|_| "Decoded audio exceeded WAV container size limits.".to_string())?;
    let header = build_wav_header(data_size, sample_rate, channel_count)?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    output
        .write_all(&header)
        .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

fn playback_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn playback_response_builder(request: &Request<Vec<u8>>) -> tauri::http::response::Builder {
    let mut builder = Response::builder();

    if let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        builder = builder
            .header("Access-Control-Allow-Origin", origin)
            .header(header::VARY, "Origin");
    } else {
        builder = builder.header("Access-Control-Allow-Origin", "*");
    }

    builder
}

fn playback_error_response(
    request: &Request<Vec<u8>>,
    status: StatusCode,
    message: &str,
) -> Response<Vec<u8>> {
    playback_response_builder(request)
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("playback error response should build")
}

fn range_not_satisfiable_response(request: &Request<Vec<u8>>, len: u64) -> Response<Vec<u8>> {
    playback_response_builder(request)
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .expect("range response should build")
}

fn decode_playback_request_path(request: &Request<Vec<u8>>) -> Result<PathBuf, String> {
    let encoded_path = request
        .uri()
        .path()
        .strip_prefix('/')
        .unwrap_or_else(|| request.uri().path());
    let decoded = percent_decode(encoded_path.as_bytes())
        .decode_utf8()
        .map_err(|error| error.to_string())?;

    Ok(PathBuf::from(decoded.into_owned()))
}

fn serve_file_for_playback(
    request: Request<Vec<u8>>,
    path: &Path,
    content_type: &str,
) -> Response<Vec<u8>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return playback_error_response(
                &request,
                StatusCode::NOT_FOUND,
                "Playback source was not found.",
            );
        }
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return playback_error_response(
                &request,
                StatusCode::FORBIDDEN,
                "Playback source could not be opened due to file permissions.",
            );
        }
        Err(error) => {
            return playback_error_response(
                &request,
                StatusCode::INTERNAL_SERVER_ERROR,
                &error.to_string(),
            );
        }
    };

    let len = match file.seek(SeekFrom::End(0)) {
        Ok(len) => len,
        Err(error) => {
            return playback_error_response(
                &request,
                StatusCode::INTERNAL_SERVER_ERROR,
                &error.to_string(),
            );
        }
    };

    if let Err(error) = file.seek(SeekFrom::Start(0)) {
        return playback_error_response(
            &request,
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        );
    }

    let mut response =
        playback_response_builder(&request).header(header::CONTENT_TYPE, content_type);

    if let Some(range_header) = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        response = response
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");

        let ranges = match HttpRange::parse(range_header, len) {
            Ok(ranges) if ranges.len() == 1 => ranges,
            Ok(_) | Err(_) => return range_not_satisfiable_response(&request, len),
        };
        let range = ranges[0];
        let start = range.start;
        let end = start
            + (range.length - 1)
                .min(len.saturating_sub(start))
                .min(PLAYBACK_MAX_RANGE_LEN - 1);
        let bytes_to_read = end + 1 - start;
        let mut buf = Vec::with_capacity(bytes_to_read as usize);

        if let Err(error) = file.seek(SeekFrom::Start(start)) {
            return playback_error_response(
                &request,
                StatusCode::INTERNAL_SERVER_ERROR,
                &error.to_string(),
            );
        }

        if let Err(error) = file.take(bytes_to_read).read_to_end(&mut buf) {
            return playback_error_response(
                &request,
                StatusCode::INTERNAL_SERVER_ERROR,
                &error.to_string(),
            );
        }

        return response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, bytes_to_read)
            .body(buf)
            .expect("playback range response should build");
    }

    if request.method() == Method::HEAD {
        return response
            .header(header::CONTENT_LENGTH, len)
            .body(Vec::new())
            .expect("playback HEAD response should build");
    }

    let mut buf = Vec::with_capacity(len as usize);
    if let Err(error) = file.read_to_end(&mut buf) {
        return playback_error_response(
            &request,
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        );
    }

    response
        .header(header::CONTENT_LENGTH, len)
        .body(buf)
        .expect("playback response should build")
}

fn decoded_playback_cache_path(app: &AppHandle, source_path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
    let modified_at = path_modified_at(source_path).unwrap_or_default();

    let mut hasher = DefaultHasher::new();
    source_path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_at.hash(&mut hasher);

    Ok(playback_cache_dir(app)?.join(format!("{:016x}.wav", hasher.finish())))
}

fn ensure_decoded_playback_file(app: &AppHandle, source_path: &Path) -> Result<PathBuf, String> {
    let cache_path = decoded_playback_cache_path(app, source_path)?;
    if cache_path.exists() {
        return Ok(cache_path);
    }

    let temporary_path = cache_path.with_extension(format!("wav.part-{}", current_timestamp_ms()));
    let decode_result = decode_audio_to_wav_file(source_path, &temporary_path);

    if let Err(error) = decode_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    match fs::rename(&temporary_path, &cache_path) {
        Ok(()) => Ok(cache_path),
        Err(_) if cache_path.exists() => {
            let _ = fs::remove_file(&temporary_path);
            Ok(cache_path)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(error.to_string())
        }
    }
}

fn resolve_prepared_playback_cache_path(
    app: &AppHandle,
    requested_path: &Path,
) -> Result<PathBuf, String> {
    let cache_dir = playback_cache_dir(app)?;
    let canonical_cache_dir = fs::canonicalize(&cache_dir).map_err(|error| error.to_string())?;
    let canonical_requested_path =
        fs::canonicalize(requested_path).map_err(|error| error.to_string())?;

    if !canonical_requested_path.starts_with(&canonical_cache_dir) {
        return Err("Prepared playback audio must be read from the app playback cache.".into());
    }

    Ok(canonical_requested_path)
}

fn playback_protocol_response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match decode_playback_request_path(&request) {
        Ok(path) => serve_file_for_playback(request, &path, playback_mime_type(&path)),
        Err(error) => playback_error_response(&request, StatusCode::BAD_REQUEST, &error),
    }
}

fn emit_scan_progress(app: &AppHandle, progress: LibraryScanProgress) {
    let _ = app.emit(LIBRARY_SCAN_PROGRESS_EVENT, progress);
}

fn inspect_track_with_fallback(
    path: &Path,
    album_art_cache: &mut AlbumArtCache,
) -> Result<Track, String> {
    inspect_audio_file(path, album_art_cache).or_else(|_| fallback_track(path, album_art_cache))
}

fn load_library_or_default(app: &AppHandle) -> Result<LibraryData, String> {
    let path = library_path(app)?;
    if !path.exists() {
        return Ok(empty_library());
    }

    read_json(&path)
}

fn sync_target_path(target: &LibrarySyncTarget) -> &Path {
    match target {
        LibrarySyncTarget::File(path) | LibrarySyncTarget::Directory(path) => path,
    }
}

fn sync_target_depth(target: &LibrarySyncTarget) -> usize {
    sync_target_path(target).components().count()
}

fn sync_target_key(target: &LibrarySyncTarget) -> String {
    match target {
        LibrarySyncTarget::File(path) => format!("file:{}", path.to_string_lossy()),
        LibrarySyncTarget::Directory(path) => format!("dir:{}", path.to_string_lossy()),
    }
}

fn sync_target_covers(existing: &LibrarySyncTarget, candidate: &LibrarySyncTarget) -> bool {
    match existing {
        LibrarySyncTarget::Directory(path) => sync_target_path(candidate).starts_with(path),
        LibrarySyncTarget::File(path) => {
            matches!(candidate, LibrarySyncTarget::File(candidate_path) if candidate_path == path)
        }
    }
}

fn track_matches_target(track: &Track, target: &LibrarySyncTarget) -> bool {
    let track_path = Path::new(&track.path);

    match target {
        LibrarySyncTarget::File(path) => track_path == path,
        LibrarySyncTarget::Directory(path) => track_path.starts_with(path),
    }
}

fn collect_sync_targets(
    changed_paths: &[String],
    existing_tracks: &[Track],
) -> Vec<LibrarySyncTarget> {
    let mut targets = Vec::new();
    let mut seen_targets = HashSet::new();

    for changed_path in changed_paths {
        let path = PathBuf::from(changed_path);
        let target = if path.exists() && path.is_dir() {
            Some(LibrarySyncTarget::Directory(path))
        } else if supported_file(&path) {
            Some(LibrarySyncTarget::File(path))
        } else if supported_art_file(&path) {
            path.parent()
                .map(|parent| LibrarySyncTarget::Directory(parent.to_path_buf()))
        } else if existing_tracks
            .iter()
            .any(|track| Path::new(&track.path).starts_with(&path))
        {
            Some(LibrarySyncTarget::Directory(path))
        } else if existing_tracks
            .iter()
            .any(|track| Path::new(&track.path) == path)
        {
            Some(LibrarySyncTarget::File(path))
        } else {
            None
        };

        if let Some(target) = target {
            let key = sync_target_key(&target);
            if seen_targets.insert(key) {
                targets.push(target);
            }
        }
    }

    targets.sort_by(|left, right| {
        match (left, right) {
            (LibrarySyncTarget::Directory(_), LibrarySyncTarget::File(_)) => {
                std::cmp::Ordering::Less
            }
            (LibrarySyncTarget::File(_), LibrarySyncTarget::Directory(_)) => {
                std::cmp::Ordering::Greater
            }
            _ => std::cmp::Ordering::Equal,
        }
        .then_with(|| sync_target_depth(left).cmp(&sync_target_depth(right)))
        .then_with(|| sync_target_path(left).cmp(sync_target_path(right)))
    });

    let mut collapsed = Vec::new();
    for target in targets {
        if collapsed
            .iter()
            .any(|existing| sync_target_covers(existing, &target))
        {
            continue;
        }

        collapsed.push(target);
    }

    collapsed
}

fn scan_sync_file(
    path: &Path,
    seen_paths: &mut HashSet<PathBuf>,
    synced_tracks: &mut HashMap<String, Track>,
    album_art_cache: &mut AlbumArtCache,
    scanned_files: &mut usize,
    unreadable_audio_files: &mut usize,
) {
    if !path.exists() || !path.is_file() || !supported_file(path) {
        return;
    }

    let dedupe_key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen_paths.insert(dedupe_key) {
        return;
    }

    match inspect_track_with_fallback(path, album_art_cache) {
        Ok(track) => {
            *scanned_files += 1;
            synced_tracks.insert(track.path.clone(), track);
        }
        Err(_) => {
            *unreadable_audio_files += 1;
        }
    }
}

fn scan_sync_directory(
    path: &Path,
    seen_paths: &mut HashSet<PathBuf>,
    synced_tracks: &mut HashMap<String, Track>,
    album_art_cache: &mut AlbumArtCache,
    scanned_files: &mut usize,
    unreadable_entries: &mut usize,
    unreadable_audio_files: &mut usize,
) {
    if !path.exists() || !path.is_dir() {
        return;
    }

    for entry in WalkDir::new(path).follow_links(true).into_iter() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                *unreadable_entries += 1;
                continue;
            }
        };

        if !entry.file_type().is_file() || !supported_file(entry.path()) {
            continue;
        }

        scan_sync_file(
            entry.path(),
            seen_paths,
            synced_tracks,
            album_art_cache,
            scanned_files,
            unreadable_audio_files,
        );
    }
}

#[tauri::command]
async fn scan_library(app: AppHandle, folders: Vec<String>) -> Result<LibraryScanResult, String> {
    let progress_app = app.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut tracks = Vec::new();
        let mut candidate_files = Vec::new();
        let mut seen_paths = HashSet::new();
        let mut album_art_cache = AlbumArtCache::new();
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

                if candidate_files.len() == 1
                    || candidate_files.len() % 50 == 0
                    || last_progress_emit.elapsed().as_millis() >= 120
                {
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
            match inspect_audio_file(&path, &mut album_art_cache) {
                Ok(track) => {
                    scanned_files += 1;
                    tracks.push(track);
                }
                Err(_) => match fallback_track(&path, &mut album_art_cache) {
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
            if processed == 1
                || processed == total_candidates
                || processed % 25 == 0
                || last_progress_emit.elapsed().as_millis() >= 120
            {
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
            scanned_at: Some(current_timestamp_ms()),
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
async fn sync_library_changes(
    app: AppHandle,
    changed_paths: Vec<String>,
) -> Result<LibrarySyncResult, String> {
    let existing_library = load_library_or_default(&app)?;
    let output = tauri::async_runtime::spawn_blocking(move || {
        let targets = collect_sync_targets(&changed_paths, &existing_library.tracks);

        if targets.is_empty() {
            return Ok::<LibrarySyncResult, String>(LibrarySyncResult {
                library: existing_library,
                scanned_files: 0,
                added_files: 0,
                updated_files: 0,
                removed_files: 0,
                unreadable_entries: 0,
                unreadable_audio_files: 0,
            });
        }

        let previous_track_paths = existing_library
            .tracks
            .iter()
            .map(|track| track.path.clone())
            .collect::<HashSet<_>>();
        let affected_track_paths = existing_library
            .tracks
            .iter()
            .filter(|track| {
                targets
                    .iter()
                    .any(|target| track_matches_target(track, target))
            })
            .map(|track| track.path.clone())
            .collect::<HashSet<_>>();

        let mut next_tracks = existing_library
            .tracks
            .into_iter()
            .filter(|track| !affected_track_paths.contains(&track.path))
            .collect::<Vec<_>>();
        let mut synced_tracks = HashMap::new();
        let mut seen_paths = HashSet::new();
        let mut album_art_cache = AlbumArtCache::new();
        let mut scanned_files = 0usize;
        let mut unreadable_entries = 0usize;
        let mut unreadable_audio_files = 0usize;

        for target in &targets {
            match target {
                LibrarySyncTarget::File(path) => scan_sync_file(
                    path,
                    &mut seen_paths,
                    &mut synced_tracks,
                    &mut album_art_cache,
                    &mut scanned_files,
                    &mut unreadable_audio_files,
                ),
                LibrarySyncTarget::Directory(path) => scan_sync_directory(
                    path,
                    &mut seen_paths,
                    &mut synced_tracks,
                    &mut album_art_cache,
                    &mut scanned_files,
                    &mut unreadable_entries,
                    &mut unreadable_audio_files,
                ),
            }
        }

        let synced_track_paths = synced_tracks.keys().cloned().collect::<HashSet<_>>();
        let added_files = synced_track_paths.difference(&previous_track_paths).count();
        let updated_files = synced_track_paths
            .intersection(&previous_track_paths)
            .count();
        let removed_files = affected_track_paths.difference(&synced_track_paths).count();

        next_tracks.extend(synced_tracks.into_values());
        next_tracks.sort_by(|a, b| a.path.cmp(&b.path));

        Ok::<LibrarySyncResult, String>(LibrarySyncResult {
            library: LibraryData {
                tracks: next_tracks,
                scanned_at: Some(current_timestamp_ms()),
            },
            scanned_files,
            added_files,
            updated_files,
            removed_files,
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
    load_library_or_default(&app)
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
fn prepare_decoded_audio_for_playback(app: AppHandle, path: String) -> Result<String, String> {
    let decoded_path = ensure_decoded_playback_file(&app, Path::new(&path))?;
    Ok(decoded_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_prepared_playback_audio_bytes(app: AppHandle, path: String) -> Result<Vec<u8>, String> {
    let resolved_path = resolve_prepared_playback_cache_path(&app, Path::new(&path))?;
    fs::read(resolved_path).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(
            PLAYBACK_FILE_PROTOCOL,
            |_ctx, request, responder| {
                std::thread::spawn(move || {
                    responder.respond(playback_protocol_response(request));
                });
            },
        )
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
            sync_library_changes,
            load_library,
            save_settings,
            load_settings,
            prepare_decoded_audio_for_playback,
            read_prepared_playback_audio_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        decode_playback_request_path, encode_wav_from_pcm_i16, find_album_art, AlbumArtCache,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::http::Request;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "darktone-player-{name}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_test_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent directory should be created");
        }

        fs::write(path, b"test").expect("test file should be written");
    }

    #[test]
    fn encodes_pcm_i16_as_valid_wav() {
        let wav = encode_wav_from_pcm_i16(&[0, 1024, -1024, 32767], 48_000, 2)
            .expect("wav encoding should succeed");

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().expect("sample rate bytes")),
            48_000
        );
        assert_eq!(
            u16::from_le_bytes(wav[22..24].try_into().expect("channel count bytes")),
            2
        );
        assert_eq!(
            u16::from_le_bytes(wav[34..36].try_into().expect("bit depth bytes")),
            16
        );
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().expect("data size bytes")),
            8
        );
        assert_eq!(wav.len(), 52);
        assert_eq!(&wav[44..52], &[0, 0, 0, 4, 0, 252, 255, 127]);
    }

    #[test]
    fn rejects_zero_channel_audio() {
        let error =
            encode_wav_from_pcm_i16(&[1, 2], 44_100, 0).expect_err("zero channels must fail");
        assert!(error.contains("no channels"));
    }

    #[test]
    fn album_art_prefers_cover_over_other_images() {
        let temp_dir = TestDir::new("album-art-priority");
        let album_dir = temp_dir.path().join("artist/album");
        let track_path = album_dir.join("song.mp3");
        let preferred_art_path = album_dir.join("cover.png");

        write_test_file(&track_path);
        write_test_file(&album_dir.join("folder.jpg"));
        write_test_file(&album_dir.join("zzz.jpg"));
        write_test_file(&preferred_art_path);

        let mut album_art_cache = AlbumArtCache::new();
        let art_path = find_album_art(&track_path, &mut album_art_cache);

        assert_eq!(
            art_path,
            Some(preferred_art_path.to_string_lossy().to_string())
        );
    }

    #[test]
    fn album_art_cache_refreshes_when_directory_changes() {
        let temp_dir = TestDir::new("album-art-cache-refresh");
        let album_dir = temp_dir.path().join("artist/album");
        let track_path = album_dir.join("song.mp3");
        let preferred_art_path = album_dir.join("cover.jpg");

        write_test_file(&track_path);

        let mut album_art_cache = AlbumArtCache::new();
        assert_eq!(find_album_art(&track_path, &mut album_art_cache), None);

        thread::sleep(Duration::from_millis(1100));
        write_test_file(&preferred_art_path);

        assert_eq!(
            find_album_art(&track_path, &mut album_art_cache),
            Some(preferred_art_path.to_string_lossy().to_string())
        );
    }

    #[test]
    fn decode_playback_request_path_handles_windows_custom_protocol_urls() {
        let request = Request::builder()
            .uri("http://playback.localhost/C%3A%5CMusic%5CArtist%5CTrack.mp3")
            .body(Vec::new())
            .expect("request should build");

        let decoded = decode_playback_request_path(&request).expect("playback path should decode");

        assert_eq!(decoded, PathBuf::from(r"C:\Music\Artist\Track.mp3"));
    }
}
