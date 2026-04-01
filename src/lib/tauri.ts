import { invoke } from "@tauri-apps/api/core";
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

export interface PlaybackSeekResult {
  sessionId: number;
  currentTimeSeconds: number;
  durationSeconds: number;
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
) {
  return invoke<PlaybackSessionMetadata>("open_playback_session", {
    path,
    outputSampleRate,
    outputChannelCount,
  });
}

export async function readPlaybackFrames(sessionId: number, frameCount: number) {
  return invoke<PlaybackFrameChunk>("read_playback_frames", {
    sessionId,
    frameCount,
  });
}

export async function seekPlaybackSession(sessionId: number, seconds: number) {
  return invoke<PlaybackSeekResult>("seek_playback_session", {
    sessionId,
    seconds,
  });
}

export async function closePlaybackSession(sessionId: number) {
  return invoke<void>("close_playback_session", {
    sessionId,
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
