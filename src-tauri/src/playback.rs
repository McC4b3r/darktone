use super::{NativePlaybackLogOptions, PlaybackDiagnostics, PlaybackLogLevel};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::ErrorKind,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use symphonia::{
    core::{
        audio::SampleBuffer,
        codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL},
        errors::Error as SymphoniaError,
        formats::{FormatReader, SeekMode, SeekTo},
        units::{Time, TimeBase},
    },
    default::get_codecs,
};
use tauri::ipc::Channel;

const DEFAULT_OUTPUT_CHANNELS: u16 = 2;
const SOURCE_BUFFER_TRIM_FRAMES: u64 = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSessionMetadata {
    pub session_id: u64,
    pub sample_rate: u32,
    pub channel_count: u16,
    pub source_sample_rate: u32,
    pub source_channel_count: u16,
    pub duration_seconds: f64,
    pub current_time_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFrameChunk {
    pub session_id: u64,
    pub sample_rate: u32,
    pub channel_count: u16,
    pub frames: usize,
    pub samples: Vec<f32>,
    pub end_of_stream: bool,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFrameChunkMeta {
    pub session_id: u64,
    pub sample_rate: u32,
    pub channel_count: u16,
    pub frames: usize,
    pub end_of_stream: bool,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSeekResult {
    pub session_id: u64,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Clone)]
pub struct PlaybackSessionManager {
    diagnostics: PlaybackDiagnostics,
    inner: Arc<PlaybackSessionManagerInner>,
}

#[derive(Default)]
struct PlaybackSessionManagerInner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, PlaybackSession>>,
}

impl PlaybackSessionManager {
    pub fn new(diagnostics: PlaybackDiagnostics) -> Self {
        Self {
            diagnostics,
            inner: Arc::new(PlaybackSessionManagerInner::default()),
        }
    }

    pub fn open_session(
        &self,
        path: &Path,
        output_sample_rate: u32,
        output_channel_count: Option<u16>,
        operation_token: Option<u64>,
    ) -> Result<PlaybackSessionMetadata, String> {
        if output_sample_rate == 0 {
            return Err("Playback output sample rate must be greater than zero.".into());
        }

        let open_started_at = Instant::now();
        self.diagnostics.append_native(
            "native-open-requested",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                operation_token,
                details: Some(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "outputSampleRate": output_sample_rate,
                    "outputChannelCount": output_channel_count.unwrap_or(DEFAULT_OUTPUT_CHANNELS),
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        let session_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let session = match PlaybackSession::open(
            path,
            output_sample_rate,
            output_channel_count.unwrap_or(DEFAULT_OUTPUT_CHANNELS),
        ) {
            Ok(session) => session,
            Err(error) => {
                self.diagnostics.append_native(
                    "native-open-failed",
                    NativePlaybackLogOptions {
                        level: Some(PlaybackLogLevel::Error),
                        session_id: Some(session_id),
                        operation_token,
                        duration_ms: Some(open_started_at.elapsed().as_millis() as u64),
                        details: Some(serde_json::json!({
                            "path": path.to_string_lossy(),
                            "outputSampleRate": output_sample_rate,
                            "outputChannelCount": output_channel_count.unwrap_or(DEFAULT_OUTPUT_CHANNELS),
                            "message": error,
                        })),
                        ..NativePlaybackLogOptions::default()
                    },
                );
                return Err(error);
            }
        };
        let metadata = session.metadata(session_id);

        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Playback session manager is unavailable.".to_string())?;
        sessions.insert(session_id, session);

        self.diagnostics.append_native(
            "native-open-finished",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                operation_token,
                actual_seconds: Some(metadata.current_time_seconds),
                duration_ms: Some(open_started_at.elapsed().as_millis() as u64),
                details: Some(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "durationSeconds": metadata.duration_seconds,
                    "sampleRate": metadata.sample_rate,
                    "channelCount": metadata.channel_count,
                    "sourceSampleRate": metadata.source_sample_rate,
                    "sourceChannelCount": metadata.source_channel_count,
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        Ok(metadata)
    }

    pub fn read_frames(
        &self,
        session_id: u64,
        frame_count: usize,
        operation_token: Option<u64>,
    ) -> Result<PlaybackFrameChunk, String> {
        let lock_wait_started_at = Instant::now();
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Playback session manager is unavailable.".to_string())?;
        let lock_wait_ms = lock_wait_started_at.elapsed().as_millis() as u64;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("Playback session {session_id} was not found."))?;

        self.diagnostics.append_native(
            "native-read-requested",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                operation_token,
                duration_ms: Some(lock_wait_ms),
                details: Some(serde_json::json!({
                    "frameCount": frame_count,
                    "lockWaitMs": lock_wait_ms,
                    "state": session.diagnostic_state(),
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        let read_started_at = Instant::now();
        let outcome =
            session.read_frames(session_id, frame_count, operation_token, &self.diagnostics);

        match &outcome {
            Ok(chunk) => self.diagnostics.append_native(
                "native-read-finished",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Info),
                    session_id: Some(session_id),
                    operation_token,
                    actual_seconds: Some(chunk.current_time_seconds),
                    duration_ms: Some(read_started_at.elapsed().as_millis() as u64),
                    details: Some(serde_json::json!({
                        "frameCount": frame_count,
                        "frames": chunk.frames,
                        "endOfStream": chunk.end_of_stream,
                        "lockWaitMs": lock_wait_ms,
                        "state": session.diagnostic_state(),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            ),
            Err(error) => self.diagnostics.append_native(
                "native-read-failed",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Error),
                    session_id: Some(session_id),
                    operation_token,
                    duration_ms: Some(read_started_at.elapsed().as_millis() as u64),
                    details: Some(serde_json::json!({
                        "frameCount": frame_count,
                        "lockWaitMs": lock_wait_ms,
                        "message": error,
                        "state": session.diagnostic_state(),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            ),
        }

        outcome
    }

    pub fn seek_session(
        &self,
        session_id: u64,
        seconds: f64,
        operation_token: Option<u64>,
    ) -> Result<PlaybackSeekResult, String> {
        let lock_wait_started_at = Instant::now();
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "Playback session manager is unavailable.".to_string())?;
        let lock_wait_ms = lock_wait_started_at.elapsed().as_millis() as u64;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("Playback session {session_id} was not found."))?;

        self.diagnostics.append_native(
            "native-seek-requested",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                operation_token,
                requested_seconds: Some(seconds),
                duration_ms: Some(lock_wait_ms),
                details: Some(serde_json::json!({
                    "lockWaitMs": lock_wait_ms,
                    "state": session.diagnostic_state(),
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        let seek_started_at = Instant::now();
        let outcome = session.seek(session_id, seconds, operation_token, &self.diagnostics);

        match &outcome {
            Ok(result) => self.diagnostics.append_native(
                "native-seek-finished",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Info),
                    session_id: Some(session_id),
                    operation_token,
                    requested_seconds: Some(seconds),
                    actual_seconds: Some(result.current_time_seconds),
                    duration_ms: Some(seek_started_at.elapsed().as_millis() as u64),
                    details: Some(serde_json::json!({
                        "durationSeconds": result.duration_seconds,
                        "lockWaitMs": lock_wait_ms,
                        "state": session.diagnostic_state(),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            ),
            Err(error) => self.diagnostics.append_native(
                "native-seek-failed",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Error),
                    session_id: Some(session_id),
                    operation_token,
                    requested_seconds: Some(seconds),
                    duration_ms: Some(seek_started_at.elapsed().as_millis() as u64),
                    details: Some(serde_json::json!({
                        "lockWaitMs": lock_wait_ms,
                        "message": error,
                        "state": session.diagnostic_state(),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            ),
        }

        outcome
    }

    pub fn read_frames_v2(
        &self,
        session_id: u64,
        frame_count: usize,
        on_samples_channel: Channel<Vec<u8>>,
        operation_token: Option<u64>,
    ) -> Result<PlaybackFrameChunkMeta, String> {
        let chunk = self.read_frames(session_id, frame_count, operation_token)?;
        let meta = PlaybackFrameChunkMeta::from(&chunk);
        on_samples_channel
            .send(encode_samples_f32le(&chunk.samples))
            .map_err(|error| error.to_string())?;
        Ok(meta)
    }

    pub fn close_session(&self, session_id: u64) {
        self.diagnostics.append_native(
            "native-close-requested",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                ..NativePlaybackLogOptions::default()
            },
        );

        let lock_wait_started_at = Instant::now();
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            let lock_wait_ms = lock_wait_started_at.elapsed().as_millis() as u64;
            let removed = sessions.remove(&session_id);
            self.diagnostics.append_native(
                "native-close-finished",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Info),
                    session_id: Some(session_id),
                    duration_ms: Some(lock_wait_ms),
                    details: Some(serde_json::json!({
                        "lockWaitMs": lock_wait_ms,
                        "sessionFound": removed.is_some(),
                        "state": removed.as_ref().map(PlaybackSession::diagnostic_state),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            );
        }
    }
}

impl Default for PlaybackSessionManager {
    fn default() -> Self {
        Self::new(PlaybackDiagnostics::default())
    }
}

impl From<&PlaybackFrameChunk> for PlaybackFrameChunkMeta {
    fn from(value: &PlaybackFrameChunk) -> Self {
        Self {
            session_id: value.session_id,
            sample_rate: value.sample_rate,
            channel_count: value.channel_count,
            frames: value.frames,
            end_of_stream: value.end_of_stream,
            current_time_seconds: value.current_time_seconds,
            duration_seconds: value.duration_seconds,
        }
    }
}

fn encode_samples_f32le(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * std::mem::size_of::<f32>());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

struct PlaybackSession {
    source_path: String,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    track_time_base: Option<TimeBase>,
    output_sample_rate: u32,
    output_channel_count: u16,
    source_sample_rate: u32,
    source_channel_count: u16,
    duration_seconds: f64,
    decoded_samples: Vec<f32>,
    decoded_buffer_start_frame: u64,
    source_frame_cursor: f64,
    output_frames_emitted: u64,
    end_of_stream: bool,
}

impl PlaybackSession {
    fn open(
        path: &Path,
        output_sample_rate: u32,
        output_channel_count: u16,
    ) -> Result<Self, String> {
        let probe = super::open_audio_format(path)?;
        let format = probe.format;
        let track = format.default_track().ok_or_else(|| {
            "The audio file does not contain a playable default track.".to_string()
        })?;

        if track.codec_params.codec == CODEC_TYPE_NULL {
            return Err("The audio file uses an unsupported codec.".into());
        }

        let decoder = get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|error| error.to_string())?;
        let track_id = track.id;
        let track_time_base = track.codec_params.time_base;
        let source_sample_rate = track.codec_params.sample_rate.unwrap_or_default();
        let source_channel_count = track
            .codec_params
            .channels
            .map(|channels| channels.count() as u16)
            .unwrap_or_default();
        let duration_seconds = track
            .codec_params
            .time_base
            .zip(track.codec_params.n_frames)
            .map(|(time_base, n_frames)| {
                let time = time_base.calc_time(n_frames);
                (time.seconds as f64) + time.frac
            })
            .unwrap_or_default();

        let mut session = Self {
            source_path: path.to_string_lossy().into_owned(),
            format,
            decoder,
            track_id,
            track_time_base,
            output_sample_rate,
            output_channel_count: output_channel_count.max(1),
            source_sample_rate,
            source_channel_count,
            duration_seconds,
            decoded_samples: Vec::new(),
            decoded_buffer_start_frame: 0,
            source_frame_cursor: 0.0,
            output_frames_emitted: 0,
            end_of_stream: false,
        };

        session.prime_output_format()?;
        Ok(session)
    }

    fn metadata(&self, session_id: u64) -> PlaybackSessionMetadata {
        PlaybackSessionMetadata {
            session_id,
            sample_rate: self.output_sample_rate,
            channel_count: self.output_channel_count,
            source_sample_rate: self.source_sample_rate,
            source_channel_count: self.source_channel_count,
            duration_seconds: self.duration_seconds,
            current_time_seconds: self.current_time_seconds(),
        }
    }

    fn current_time_seconds(&self) -> f64 {
        if self.output_sample_rate == 0 {
            0.0
        } else {
            (self.output_frames_emitted as f64) / (self.output_sample_rate as f64)
        }
    }

    fn source_step(&self) -> f64 {
        if self.source_sample_rate == 0 {
            1.0
        } else {
            (self.source_sample_rate as f64) / (self.output_sample_rate as f64)
        }
    }

    fn available_source_frames(&self) -> u64 {
        if self.source_channel_count == 0 {
            return 0;
        }

        (self.decoded_samples.len() / self.source_channel_count as usize) as u64
    }

    fn prime_output_format(&mut self) -> Result<(), String> {
        if self.source_sample_rate > 0 && self.source_channel_count > 0 {
            return Ok(());
        }

        self.decode_until_buffered_samples()?;

        if self.source_sample_rate == 0 || self.source_channel_count == 0 {
            return Err(
                "The audio file did not expose a usable sample format for playback.".into(),
            );
        }

        Ok(())
    }

    fn read_frames(
        &mut self,
        session_id: u64,
        frame_count: usize,
        operation_token: Option<u64>,
        diagnostics: &PlaybackDiagnostics,
    ) -> Result<PlaybackFrameChunk, String> {
        if frame_count == 0 {
            return Ok(PlaybackFrameChunk {
                session_id,
                sample_rate: self.output_sample_rate,
                channel_count: self.output_channel_count,
                frames: 0,
                samples: Vec::new(),
                end_of_stream: self.end_of_stream && self.available_source_frames() == 0,
                current_time_seconds: self.current_time_seconds(),
                duration_seconds: self.duration_seconds,
            });
        }

        let mut samples = Vec::with_capacity(frame_count * self.output_channel_count as usize);
        let mut frames = 0usize;

        while frames < frame_count {
            self.ensure_renderable_frame()?;
            if !self.can_render_frame() {
                break;
            }

            let relative_position =
                self.source_frame_cursor - (self.decoded_buffer_start_frame as f64);
            let frame_index = relative_position.floor().max(0.0) as u64;
            let fraction = (relative_position - frame_index as f64).clamp(0.0, 1.0) as f32;
            let current = self.read_stereo_frame(frame_index);
            let next = self.read_stereo_frame(frame_index.saturating_add(1));
            let left = current.0 + ((next.0 - current.0) * fraction);
            let right = current.1 + ((next.1 - current.1) * fraction);

            match self.output_channel_count {
                0 => {}
                1 => samples.push((left + right) * 0.5),
                _ => {
                    samples.push(left);
                    samples.push(right);
                    for _ in 2..self.output_channel_count {
                        samples.push((left + right) * 0.5);
                    }
                }
            }

            self.source_frame_cursor += self.source_step();
            self.output_frames_emitted = self.output_frames_emitted.saturating_add(1);
            self.trim_consumed_source_frames();
            frames += 1;
        }

        let end_of_stream = self.end_of_stream && !self.can_render_frame();
        if frames == 0 && !end_of_stream {
            diagnostics.append_native(
                "native-read-impossible-empty-chunk",
                NativePlaybackLogOptions {
                    level: Some(PlaybackLogLevel::Error),
                    session_id: Some(session_id),
                    operation_token,
                    details: Some(serde_json::json!({
                        "frameCount": frame_count,
                        "state": self.diagnostic_state(),
                    })),
                    ..NativePlaybackLogOptions::default()
                },
            );
            return Err(
                "Playback decoder returned 0 frames without reaching end of stream.".into(),
            );
        }

        Ok(PlaybackFrameChunk {
            session_id,
            sample_rate: self.output_sample_rate,
            channel_count: self.output_channel_count,
            frames,
            samples,
            end_of_stream,
            current_time_seconds: self.current_time_seconds(),
            duration_seconds: self.duration_seconds,
        })
    }

    fn seek(
        &mut self,
        session_id: u64,
        seconds: f64,
        operation_token: Option<u64>,
        diagnostics: &PlaybackDiagnostics,
    ) -> Result<PlaybackSeekResult, String> {
        let clamped_seconds = if self.duration_seconds > 0.0 {
            seconds.clamp(0.0, self.duration_seconds)
        } else {
            seconds.max(0.0)
        };

        diagnostics.append_native(
            "native-seek-started",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                operation_token,
                requested_seconds: Some(seconds),
                details: Some(serde_json::json!({
                    "clampedSeconds": clamped_seconds,
                    "state": self.diagnostic_state(),
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        let seeked_to = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(clamped_seconds),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|error| error.to_string())?;

        self.decoder.reset();
        self.decoded_samples.clear();
        self.end_of_stream = false;

        let requested_source_frame = clamped_seconds * self.source_sample_rate as f64;
        let actual_source_frame = self
            .track_time_base
            .map(|time_base| time_base.calc_time(seeked_to.actual_ts))
            .map(|time| ((time.seconds as f64) + time.frac) * self.source_sample_rate as f64)
            .unwrap_or(requested_source_frame)
            .max(0.0);
        self.decoded_buffer_start_frame = actual_source_frame.floor() as u64;
        self.source_frame_cursor = requested_source_frame.max(actual_source_frame);
        self.output_frames_emitted = (clamped_seconds * self.output_sample_rate as f64)
            .round()
            .max(0.0) as u64;

        let result = PlaybackSeekResult {
            session_id,
            current_time_seconds: self.current_time_seconds(),
            duration_seconds: self.duration_seconds,
        };

        diagnostics.append_native(
            "native-seek-state-updated",
            NativePlaybackLogOptions {
                level: Some(PlaybackLogLevel::Info),
                session_id: Some(session_id),
                operation_token,
                requested_seconds: Some(seconds),
                actual_seconds: Some(result.current_time_seconds),
                details: Some(serde_json::json!({
                    "clampedSeconds": clamped_seconds,
                    "actualTimestamp": seeked_to.actual_ts,
                    "state": self.diagnostic_state(),
                })),
                ..NativePlaybackLogOptions::default()
            },
        );

        Ok(result)
    }

    fn ensure_renderable_frame(&mut self) -> Result<(), String> {
        while !self.can_render_frame() && !self.end_of_stream {
            self.decode_until_buffered_samples()?;
            if self.available_source_frames() == 0 && self.end_of_stream {
                break;
            }
        }

        Ok(())
    }

    fn can_render_frame(&self) -> bool {
        let available_frames = self.available_source_frames();
        if available_frames == 0 {
            return false;
        }

        let relative_position = self.source_frame_cursor - (self.decoded_buffer_start_frame as f64);
        if relative_position < 0.0 {
            return false;
        }

        let frame_index = relative_position.floor() as u64;
        if frame_index < available_frames.saturating_sub(1) {
            return true;
        }

        self.end_of_stream && frame_index < available_frames
    }

    fn trim_consumed_source_frames(&mut self) {
        let current_frame = self.source_frame_cursor.floor() as u64;
        let removable_frames = current_frame.saturating_sub(self.decoded_buffer_start_frame);
        if removable_frames < SOURCE_BUFFER_TRIM_FRAMES {
            return;
        }

        let samples_to_remove = removable_frames as usize * self.source_channel_count as usize;
        self.decoded_samples.drain(0..samples_to_remove);
        self.decoded_buffer_start_frame = self
            .decoded_buffer_start_frame
            .saturating_add(removable_frames);
    }

    fn decode_until_buffered_samples(&mut self) -> Result<(), String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.end_of_stream = true;
                    return Ok(());
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err(
                        "The audio decoder requested a reset while preparing playback data.".into(),
                    )
                }
                Err(error) => return Err(error.to_string()),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.end_of_stream = true;
                    return Ok(());
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err(
                        "The audio decoder requested a reset while preparing playback data.".into(),
                    )
                }
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => return Err(error.to_string()),
            };

            if self.source_sample_rate == 0 {
                self.source_sample_rate = decoded.spec().rate;
            }
            if self.source_channel_count == 0 {
                self.source_channel_count = decoded.spec().channels.count() as u16;
            }

            if self.source_sample_rate != decoded.spec().rate {
                return Err(
                    "Playback sample rate changed unexpectedly within the same track.".into(),
                );
            }

            let decoded_channel_count = decoded.spec().channels.count() as u16;
            if self.source_channel_count != decoded_channel_count {
                return Err(
                    "Playback channel layout changed unexpectedly within the same track.".into(),
                );
            }

            let mut sample_buffer =
                SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            sample_buffer.copy_interleaved_ref(decoded);
            if !sample_buffer.samples().is_empty() {
                self.decoded_samples
                    .extend_from_slice(sample_buffer.samples());
                return Ok(());
            }
        }
    }

    fn read_stereo_frame(&self, frame_index: u64) -> (f32, f32) {
        let available_frames = self.available_source_frames();
        if available_frames == 0 {
            return (0.0, 0.0);
        }

        let bounded_index = frame_index.min(available_frames.saturating_sub(1));
        let base_index = bounded_index as usize * self.source_channel_count as usize;
        let channel_count = self.source_channel_count.max(1) as usize;
        let mono = self.decoded_samples.get(base_index).copied().unwrap_or(0.0);

        if channel_count == 1 {
            return (mono, mono);
        }

        let left = self.decoded_samples.get(base_index).copied().unwrap_or(0.0);
        let right = self
            .decoded_samples
            .get(base_index + 1)
            .copied()
            .unwrap_or(left);
        (left, right)
    }

    fn diagnostic_state(&self) -> serde_json::Value {
        serde_json::json!({
            "path": self.source_path.clone(),
            "decodedBufferStartFrame": self.decoded_buffer_start_frame,
            "availableSourceFrames": self.available_source_frames(),
            "sourceFrameCursor": self.source_frame_cursor,
            "outputFramesEmitted": self.output_frames_emitted,
            "endOfStream": self.end_of_stream,
            "sourceSampleRate": self.source_sample_rate,
            "sourceChannelCount": self.source_channel_count,
            "outputSampleRate": self.output_sample_rate,
            "outputChannelCount": self.output_channel_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        encode_samples_f32le, PlaybackFrameChunk, PlaybackFrameChunkMeta, PlaybackSessionManager,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

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
                "darktone-playback-{name}-{}-{unique}",
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

    fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
        let mut samples = Vec::with_capacity(frames * channels as usize);
        for index in 0..frames {
            let sample = (((index as f32 / 32.0).sin()) * i16::MAX as f32 * 0.25) as i16;
            for _ in 0..channels {
                samples.push(sample);
            }
        }

        let data_size = (samples.len() as u32) * 2;
        let byte_rate = sample_rate * u32::from(channels) * 2;
        let block_align = channels * 2;
        let riff_size = 36 + data_size;
        let mut wav = Vec::with_capacity(44 + data_size as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&riff_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());

        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }

        fs::write(path, wav).expect("test wav should be written");
    }

    #[test]
    fn opens_reads_seeks_and_closes_a_playback_session() {
        let temp_dir = TestDir::new("session");
        let wav_path = temp_dir.path().join("test.wav");
        write_test_wav(&wav_path, 44_100, 2, 44_100);

        let manager = PlaybackSessionManager::default();
        let metadata = manager
            .open_session(&wav_path, 48_000, Some(2), None)
            .expect("playback session should open");

        assert_eq!(metadata.sample_rate, 48_000);
        assert_eq!(metadata.channel_count, 2);
        assert_eq!(metadata.source_sample_rate, 44_100);
        assert!(metadata.duration_seconds > 0.9);

        let first_chunk = manager
            .read_frames(metadata.session_id, 4096, None)
            .expect("frames should read");
        assert_eq!(first_chunk.sample_rate, 48_000);
        assert_eq!(first_chunk.channel_count, 2);
        assert_eq!(first_chunk.frames, 4096);
        assert_eq!(first_chunk.samples.len(), 8192);
        assert!(first_chunk.current_time_seconds > 0.08);

        let seek_result = manager
            .seek_session(metadata.session_id, 0.5, None)
            .expect("seek should succeed");
        assert!(seek_result.current_time_seconds >= 0.49);
        assert!(seek_result.current_time_seconds <= 0.51);

        let second_chunk = manager
            .read_frames(metadata.session_id, 2048, None)
            .expect("frames after seek should read");
        assert_eq!(second_chunk.frames, 2048);
        assert!(second_chunk.current_time_seconds >= 0.53);

        manager.close_session(metadata.session_id);
        let error = manager
            .read_frames(metadata.session_id, 512, None)
            .expect_err("closed sessions should fail");
        assert!(error.contains("was not found"));
    }

    #[test]
    fn reaches_end_of_stream_after_successive_reads() {
        let temp_dir = TestDir::new("eof");
        let wav_path = temp_dir.path().join("short.wav");
        write_test_wav(&wav_path, 44_100, 1, 2048);

        let manager = PlaybackSessionManager::default();
        let metadata = manager
            .open_session(&wav_path, 44_100, Some(2), None)
            .expect("playback session should open");

        let mut total_frames = 0usize;
        let mut end_of_stream = false;

        while !end_of_stream {
            let chunk = manager
                .read_frames(metadata.session_id, 512, None)
                .expect("chunk should read");
            total_frames += chunk.frames;
            end_of_stream = chunk.end_of_stream;
        }

        assert!(total_frames >= 2048);
    }

    #[test]
    fn successive_seeks_after_reads_keep_the_session_cursor_consistent() {
        let temp_dir = TestDir::new("successive-seeks");
        let wav_path = temp_dir.path().join("seek.wav");
        write_test_wav(&wav_path, 44_100, 2, 44_100 * 2);

        let manager = PlaybackSessionManager::default();
        let metadata = manager
            .open_session(&wav_path, 48_000, Some(2), None)
            .expect("playback session should open");

        let first_chunk = manager
            .read_frames(metadata.session_id, 2_048, None)
            .expect("initial frames should read");
        assert_eq!(first_chunk.frames, 2_048);
        assert!(first_chunk.current_time_seconds >= 0.04);

        let first_seek = manager
            .seek_session(metadata.session_id, 0.25, None)
            .expect("first seek should succeed");
        assert!(first_seek.current_time_seconds >= 0.24);
        assert!(first_seek.current_time_seconds <= 0.26);

        let after_first_seek = manager
            .read_frames(metadata.session_id, 1_024, None)
            .expect("frames after first seek should read");
        assert_eq!(after_first_seek.frames, 1_024);
        assert!(after_first_seek.current_time_seconds >= 0.27);

        let second_seek = manager
            .seek_session(metadata.session_id, 0.75, None)
            .expect("second seek should succeed");
        assert!(second_seek.current_time_seconds >= 0.74);
        assert!(second_seek.current_time_seconds <= 0.76);

        let after_second_seek = manager
            .read_frames(metadata.session_id, 1_024, None)
            .expect("frames after second seek should read");
        assert_eq!(after_second_seek.frames, 1_024);
        assert!(after_second_seek.current_time_seconds >= 0.77);

        let third_seek = manager
            .seek_session(metadata.session_id, 0.10, None)
            .expect("third seek should succeed");
        assert!(third_seek.current_time_seconds >= 0.09);
        assert!(third_seek.current_time_seconds <= 0.11);

        let after_third_seek = manager
            .read_frames(metadata.session_id, 512, None)
            .expect("frames after third seek should read");
        assert_eq!(after_third_seek.frames, 512);
        assert!(after_third_seek.current_time_seconds >= 0.11);
    }

    #[test]
    fn raw_channel_payload_matches_chunk_metadata_and_byte_length() {
        let chunk = PlaybackFrameChunk {
            session_id: 7,
            sample_rate: 48_000,
            channel_count: 2,
            frames: 2,
            samples: vec![0.25, -0.5, 1.0, -1.0],
            end_of_stream: true,
            current_time_seconds: 1.25,
            duration_seconds: 3.5,
        };

        let meta = PlaybackFrameChunkMeta::from(&chunk);
        let bytes = encode_samples_f32le(&chunk.samples);

        assert_eq!(meta.session_id, chunk.session_id);
        assert_eq!(meta.frames, chunk.frames);
        assert!(meta.end_of_stream);
        assert_eq!(
            bytes.len(),
            chunk.samples.len() * std::mem::size_of::<f32>()
        );
        assert_eq!(
            f32::from_le_bytes(
                bytes[0..4]
                    .try_into()
                    .expect("first sample bytes should exist")
            ),
            0.25,
        );
        assert_eq!(
            f32::from_le_bytes(
                bytes[4..8]
                    .try_into()
                    .expect("second sample bytes should exist")
            ),
            -0.5,
        );
    }
}
