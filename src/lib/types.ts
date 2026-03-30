export type RepeatMode = "off" | "all" | "one";

export interface Track {
  id: string;
  path: string;
  artPath?: string | null;
  filename: string;
  title: string;
  artist: string;
  album: string;
  trackNumber: number | null;
  durationMs: number;
  format: "mp3" | "wav" | "flac";
  modifiedAt: number;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artPath?: string | null;
  tracks: Track[];
  trackCount: number;
  totalDurationMs: number;
}

export interface ArtistGroup {
  id: string;
  name: string;
  albums: Album[];
  trackCount: number;
}

export interface LibraryData {
  tracks: Track[];
  scannedAt: number | null;
}

export interface LibraryScanResult {
  library: LibraryData;
  scannedFiles: number;
  skippedFiles: number;
  unsupportedFiles: number;
  unreadableEntries: number;
  unreadableAudioFiles: number;
}

export interface QueueItem {
  queueId: string;
  trackId: string;
}

export interface AppSettings {
  musicFolders: string[];
  volume: number;
  muted: boolean;
  repeatMode: RepeatMode;
  shuffle: boolean;
  queueTrackIds: string[];
  currentTrackId: string | null;
}

export interface PlaybackState {
  currentTrackId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  repeatMode: RepeatMode;
  shuffle: boolean;
}
