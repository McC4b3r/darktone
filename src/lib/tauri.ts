import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import type { AppSettings, LibraryData, LibraryScanResult, LibrarySyncResult } from "./types";

export const LIBRARY_SCAN_PROGRESS_EVENT = "library-scan-progress";

export interface PlaybackSessionMetadata {
  sessionId: number;
  sampleRate: number;
  channelCount: number;
  sourceSampleRate: number;
  sourceChannelCount: number;
  durationSeconds: number;
  currentTimeSeconds: number;
}

export interface PlaybackFrameChunk {
  sessionId: number;
  sampleRate: number;
  channelCount: number;
  frames: number;
  samples: number[];
  endOfStream: boolean;
  currentTimeSeconds: number;
  durationSeconds: number;
}

export interface PlaybackFrameChunkMeta {
  sessionId: number;
  sampleRate: number;
  channelCount: number;
  frames: number;
  endOfStream: boolean;
  currentTimeSeconds: number;
  durationSeconds: number;
}

export interface PlaybackSeekResult {
  sessionId: number;
  currentTimeSeconds: number;
  durationSeconds: number;
}

export type PlaybackTransportMode = "legacy" | "raw-channel";

export type RuntimeMode =
  | {
      kind: "normal";
    }
  | {
      kind: "playbackSmoke";
      config: PlaybackSmokeConfig;
    };

export interface PlaybackSmokeFixturePaths {
  wav: string;
  mp3: string;
  flac: string;
}

export interface PlaybackSmokeConfig {
  reportPath: string;
  fixturePaths: PlaybackSmokeFixturePaths;
  transportMode: PlaybackTransportMode;
}

export interface PlaybackSmokeTrackResult {
  format: "wav" | "mp3" | "flac";
  openMs: number;
  firstPlayingMs: number;
  seekMs: number;
  pauseResumeOk: boolean;
  progressAdvancedOk: boolean;
}

export interface PlaybackSmokeReport {
  passed: boolean;
  failures: string[];
  warnings: string[];
  tracks: PlaybackSmokeTrackResult[];
  transportMode: PlaybackTransportMode;
  statusTransitions: string[];
}

export interface PlaybackLogEntry {
  timestampMs: number;
  source: "frontend" | "native";
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  sessionId?: number | null;
  operationToken?: number | null;
  trackId?: string | null;
  requestedSeconds?: number | null;
  actualSeconds?: number | null;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
}

export async function pickMusicFolders() {
  const selection = await open({
    directory: true,
    multiple: true,
    recursive: true,
    fileAccessMode: "scoped",
    title: "Add Music Folder",
  });

  if (!selection) return [];
  const paths = Array.isArray(selection) ? selection : [selection];
  return paths.filter((value): value is string => typeof value === "string");
}

export async function scanLibrary(folders: string[]) {
  return invoke<LibraryScanResult>("scan_library", { folders });
}

export async function syncLibraryChanges(changedPaths: string[]) {
  return invoke<LibrarySyncResult>("sync_library_changes", { changedPaths });
}

export async function loadLibrary() {
  return invoke<LibraryData>("load_library");
}

export async function saveSettings(settings: AppSettings) {
  return invoke<void>("save_settings", { settings });
}

export async function loadSettings() {
  return invoke<AppSettings>("load_settings");
}

export async function openPlaybackSession(
  path: string,
  outputSampleRate: number,
  outputChannelCount = 2,
  operationToken?: number,
) {
  return invoke<PlaybackSessionMetadata>("open_playback_session", {
    path,
    outputSampleRate,
    outputChannelCount,
    operationToken,
  });
}

export async function readPlaybackFrames(sessionId: number, frameCount: number, operationToken?: number) {
  return invoke<PlaybackFrameChunk>("read_playback_frames", {
    sessionId,
    frameCount,
    operationToken,
  });
}

export async function readPlaybackFramesV2(sessionId: number, frameCount: number, operationToken?: number) {
  const samplesChannel = new Channel<ArrayBuffer>();

  return new Promise<PlaybackFrameChunkMeta & { samples: Float32Array }>((resolve, reject) => {
    let chunkMeta: PlaybackFrameChunkMeta | null = null;
    let samplesBuffer: ArrayBuffer | null = null;
    let settled = false;

    const maybeResolve = () => {
      if (settled || !chunkMeta || samplesBuffer === null) {
        return;
      }

      settled = true;
      resolve({
        ...chunkMeta,
        samples: new Float32Array(samplesBuffer),
      });
    };

    samplesChannel.onmessage = (payload) => {
      samplesBuffer = payload;
      maybeResolve();
    };

    void invoke<PlaybackFrameChunkMeta>("read_playback_frames_v2", {
      sessionId,
      frameCount,
      onSamplesChannel: samplesChannel,
      operationToken,
    }).then((chunk) => {
      chunkMeta = chunk;
      if (chunk.frames === 0) {
        samplesBuffer = new ArrayBuffer(0);
      }
      maybeResolve();
    }).catch((error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });
  });
}

export async function seekPlaybackSession(sessionId: number, seconds: number, operationToken?: number) {
  return invoke<PlaybackSeekResult>("seek_playback_session", {
    sessionId,
    seconds,
    operationToken,
  });
}

export async function closePlaybackSession(sessionId: number) {
  return invoke<void>("close_playback_session", {
    sessionId,
  });
}

export async function appendPlaybackLogEntry(entry: PlaybackLogEntry) {
  return invoke<void>("append_playback_log_entry", {
    entry,
  });
}

export async function getPlaybackLogPath() {
  return invoke<string>("get_playback_log_path");
}

export async function getRuntimeMode() {
  return invoke<RuntimeMode>("get_runtime_mode");
}

export async function writePlaybackSmokeReport(report: PlaybackSmokeReport) {
  return invoke<void>("write_playback_smoke_report", {
    report,
  });
}

export async function exitApp(exitCode = 0) {
  return invoke<void>("exit_app", {
    exitCode,
  });
}

function shouldHandleWatchEvent(event: WatchEvent) {
  return !(typeof event.type === "object" && "access" in event.type);
}

export async function watchMusicFolders(folders: string[], onChange: (paths: string[]) => void) {
  const unwatchers = await Promise.all(
    folders.map((folder) =>
      watch(
        folder,
        (event) => {
          if (!shouldHandleWatchEvent(event)) {
            return;
          }

          const changedPaths = event.paths.filter((value): value is string => typeof value === "string");
          if (changedPaths.length > 0) {
            onChange(changedPaths);
          }
        },
        { recursive: true, delayMs: 500 },
      ),
    ),
  );

  return () => {
    for (const unwatch of unwatchers) {
      unwatch();
    }
  };
}
