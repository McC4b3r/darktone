import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { audioEngine } from "../lib/audio";
import {
  filterLibrary,
  groupLibrary,
  normalizeLibrary,
  UNKNOWN_ALBUM,
  UNKNOWN_ARTIST,
} from "../lib/library";
import { getNextQueueIndex, getPreviousQueueIndex, makeQueue, moveQueueItem, removeQueueItem } from "../lib/queue";
import { LIBRARY_SCAN_PROGRESS_EVENT, loadLibrary, loadSettings, pickMusicFolders, saveSettings, scanLibrary, watchMusicFolders } from "../lib/tauri";
import type { AppSettings, LibraryData, LibraryScanProgress, PlaybackState, QueueItem, RepeatMode, Track } from "../lib/types";

const DEFAULT_SETTINGS: AppSettings = {
  musicFolders: [],
  volume: 0.8,
  muted: false,
  repeatMode: "all",
  shuffle: false,
  queueTrackIds: [],
  currentTrackId: null,
};

const EMPTY_LIBRARY: LibraryData = {
  tracks: [],
  scannedAt: null,
};

const PLAYBACK_DEBUG_STORAGE_KEY = "darktone:debug-playback";

function isPlaybackDebugEnabled() {
  if (import.meta.env.DEV) {
    return true;
  }

  try {
    return window.localStorage.getItem(PLAYBACK_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function logPlaybackDebug(message: string, details?: Record<string, unknown>) {
  if (!isPlaybackDebugEnabled()) {
    return;
  }

  const payload = details ? { ...details } : undefined;
  console.info(`[playback] ${message}`, payload ?? "");
}

function cycleRepeatMode(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}

function getErrorMessage(cause: unknown, fallback: string) {
  if (cause instanceof Error && cause.message) {
    return `${fallback}: ${cause.message}`;
  }

  if (typeof cause === "string" && cause.trim()) {
    return `${fallback}: ${cause}`;
  }

  return fallback;
}

function getPlaybackErrorMessage(cause: unknown) {
  if (cause instanceof Error && cause.message) {
    return `Playback failed. ${cause.message}`;
  }

  if (typeof cause === "string" && cause.trim()) {
    return `Playback failed. ${cause}`;
  }

  return "Playback failed. The app could not open this track with any available source.";
}

function getPathLabel(path: string | null) {
  if (!path) return null;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function formatProgressMessage(progress: LibraryScanProgress) {
  const folderLabel = getPathLabel(progress.currentFolder);

  if (progress.phase === "discovering") {
    const folderPart =
      progress.folderCount > 0
        ? `Scanning folder ${Math.min(progress.foldersCompleted + 1, progress.folderCount)} of ${progress.folderCount}`
        : "Scanning folders";
    const foundPart =
      progress.current === 0
        ? "looking for supported tracks"
        : `found ${progress.current} supported file${progress.current === 1 ? "" : "s"} so far`;

    return folderLabel ? `${folderPart} in ${folderLabel}, ${foundPart}.` : `${folderPart}, ${foundPart}.`;
  }

  if (!progress.total) {
    return "Preparing the music library index…";
  }

  const percent = Math.min(100, Math.round((progress.current / progress.total) * 100));
  const folderPart = folderLabel ? ` from ${folderLabel}` : "";
  return `Indexing track ${progress.current} of ${progress.total}${folderPart} (${percent}%).`;
}

export function usePlayerApp() {
  const [library, setLibrary] = useState<LibraryData>(EMPTY_LIBRARY);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null);
  const [focusedArtistId, setFocusedArtistId] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Loading library…");
  const [scanProgress, setScanProgress] = useState<LibraryScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>({
    currentTrackId: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    volume: DEFAULT_SETTINGS.volume,
    muted: DEFAULT_SETTINGS.muted,
    repeatMode: DEFAULT_SETTINGS.repeatMode,
    shuffle: DEFAULT_SETTINGS.shuffle,
  });

  const hasInitializedRef = useRef(false);
  const refreshTimeoutRef = useRef<number | null>(null);
  const unwatchFoldersRef = useRef<(() => void) | null>(null);

  const normalizedLibrary = useMemo(() => normalizeLibrary(library), [library]);
  const filteredLibrary = useMemo(
    () => filterLibrary(normalizedLibrary, searchQuery),
    [normalizedLibrary, searchQuery],
  );
  const artists = useMemo(() => groupLibrary(filteredLibrary), [filteredLibrary]);
  const allAlbums = useMemo(() => artists.flatMap((artist) => artist.albums), [artists]);
  const tracksById = useMemo(
    () => new Map(normalizedLibrary.tracks.map((track) => [track.id, track])),
    [normalizedLibrary.tracks],
  );

  const selectedArtist = artists.find((artist) => artist.id === selectedArtistId) ?? null;
  const focusedArtist = artists.find((artist) => artist.id === focusedArtistId) ?? null;
  const visibleAlbums = selectedArtist ? selectedArtist.albums : allAlbums;
  const selectedAlbum =
    visibleAlbums.find((album) => album.id === selectedAlbumId) ??
    (!selectedArtist ? visibleAlbums[0] : null) ??
    null;

  const visibleTracks =
    selectedAlbum?.tracks ??
    (selectedArtist ? selectedArtist.albums.flatMap((artistAlbum) => artistAlbum.tracks) : filteredLibrary.tracks);
  const queuedTrack = currentIndex >= 0 ? tracksById.get(queue[currentIndex]?.trackId ?? "") ?? null : null;
  const currentTrack =
    (playback.currentTrackId ? tracksById.get(playback.currentTrackId) ?? null : null) ?? queuedTrack;
  const currentAlbum =
    (currentTrack ? allAlbums.find((album) => album.tracks.some((track) => track.id === currentTrack.id)) ?? null : null) ??
    selectedAlbum ??
    (selectedArtist?.albums[0] ?? null);

  useEffect(() => {
    audioEngine.setCallbacks({
      onTimeUpdate: (currentTime, duration) => {
        setPlayback((state) => ({ ...state, currentTime, duration }));
      },
      onPlayStateChange: (isPlaying) => {
        setPlayback((state) => ({ ...state, isPlaying }));
      },
      onEnded: () => {
        void playNext();
      },
      onError: (message) => {
        setError(`Playback failed. ${message}`);
      },
    });
  }, [playNext]);

  useEffect(() => {
    void initialize();
    // We only want the boot sequence once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<LibraryScanProgress>(LIBRARY_SCAN_PROGRESS_EVENT, (event) => {
      if (disposed) return;
      setIsSyncing(true);
      setScanProgress(event.payload);
      setSyncMessage(formatProgressMessage(event.payload));
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!hasInitializedRef.current || settings.musicFolders.length === 0) {
      unwatchFoldersRef.current?.();
      unwatchFoldersRef.current = null;
      return;
    }

    let disposed = false;

    void watchMusicFolders(settings.musicFolders, () => {
      if (disposed) return;
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
      refreshTimeoutRef.current = window.setTimeout(() => {
        refreshTimeoutRef.current = null;
        void refreshLibrary(settings.musicFolders, false);
      }, 900);
    }).then((unwatch) => {
      if (disposed) {
        unwatch();
        return;
      }

      unwatchFoldersRef.current?.();
      unwatchFoldersRef.current = unwatch;
    }).catch((cause) => {
      console.warn("Could not watch the music folders for updates.", cause);
    });

    return () => {
      disposed = true;
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
      unwatchFoldersRef.current?.();
      unwatchFoldersRef.current = null;
    };
  }, [refreshLibrary, settings.musicFolders]);

  useEffect(() => {
    async function refreshOnFocus() {
      if (!hasInitializedRef.current || settings.musicFolders.length === 0) return;
      await refreshLibrary(settings.musicFolders, false);
    }

    function onWindowFocus() {
      void refreshOnFocus();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void refreshOnFocus();
      }
    }

    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshLibrary, settings.musicFolders]);

  useEffect(() => {
    audioEngine.setVolume(playback.volume);
    audioEngine.setMuted(playback.muted);
  }, [playback.volume, playback.muted]);

  useEffect(() => {
    if (!hasInitializedRef.current) return;

    const nextSettings: AppSettings = {
      ...settings,
      volume: playback.volume,
      muted: playback.muted,
      repeatMode: playback.repeatMode,
      shuffle: playback.shuffle,
      queueTrackIds: queue.map((item) => item.trackId),
      currentTrackId: currentTrack?.id ?? null,
    };

    void saveSettings(nextSettings).catch((cause) => {
      console.error(cause);
      setError("Could not save app settings.");
    });
    // We intentionally persist when queue/playback values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, currentTrack?.id, playback.volume, playback.muted, playback.repeatMode, playback.shuffle]);

  async function initialize() {
    try {
      setLoading(true);
      setError(null);
      audioEngine.reset();
      const [storedSettings, storedLibrary] = await Promise.all([
        loadSettings().catch(() => DEFAULT_SETTINGS),
        loadLibrary().catch(() => EMPTY_LIBRARY),
      ]);

      const nextLibrary = normalizeLibrary(storedLibrary);
      const restoredCurrentTrack =
        storedSettings.currentTrackId && nextLibrary.tracks.some((track) => track.id === storedSettings.currentTrackId)
          ? storedSettings.currentTrackId
          : null;
      logPlaybackDebug("restoring startup state", {
        restoredCurrentTrackId: restoredCurrentTrack,
        restoredQueueCount: storedSettings.queueTrackIds.length,
        musicFolderCount: storedSettings.musicFolders.length,
      });
      setSettings(storedSettings);
      setLibrary(nextLibrary);
      setPlayback((state) => ({
        ...state,
        currentTrackId: restoredCurrentTrack,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        volume: storedSettings.volume,
        muted: storedSettings.muted,
        repeatMode: storedSettings.repeatMode,
        shuffle: storedSettings.shuffle,
      }));

      const restoredQueue = storedSettings.queueTrackIds.filter((trackId) => nextLibrary.tracks.some((track) => track.id === trackId));
      setQueue(makeQueue(restoredQueue));
      setCurrentIndex(
        restoredCurrentTrack ? restoredQueue.findIndex((trackId) => trackId === restoredCurrentTrack) : -1,
      );

      if (!storedSettings.musicFolders.length) {
        setSyncMessage("Add a music folder to build your library.");
      }

      hasInitializedRef.current = true;
    } catch (cause) {
      console.error(cause);
      setError("Could not initialize the music library.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshLibrary(folders = settings.musicFolders, announce = true) {
    if (!folders.length) return;

    try {
      setError(null);
      setIsSyncing(true);
      setScanProgress(null);
      if (announce) setSyncMessage("Refreshing library…");
      const result = await scanLibrary(folders);
      const normalized = normalizeLibrary(result.library);

      setLibrary(normalized);
      const indexedMessage = `Indexed ${result.scannedFiles} files from ${folders.length} folder${folders.length === 1 ? "" : "s"}.`;
      const skippedParts = [
        result.unsupportedFiles > 0
          ? `${result.unsupportedFiles} skipped because only MP3, WAV, and FLAC are supported right now`
          : null,
        result.unreadableEntries > 0
          ? `${result.unreadableEntries} folders or files could not be traversed`
          : null,
        result.unreadableAudioFiles > 0
          ? `${result.unreadableAudioFiles} audio files could not be opened or parsed`
          : null,
      ].filter(Boolean);
      const skippedMessage = skippedParts.length > 0 ? ` ${skippedParts.join(". ")}.` : "";
      setSyncMessage(`${indexedMessage}${skippedMessage}`);

      const validQueueTrackIds = queue
        .map((item) => item.trackId)
        .filter((trackId) => normalized.tracks.some((track) => track.id === trackId));
      setQueue(makeQueue(validQueueTrackIds));

      if (currentTrack && !normalized.tracks.some((track) => track.id === currentTrack.id)) {
        setCurrentIndex(-1);
        setPlayback((state) => ({
          ...state,
          currentTrackId: null,
          isPlaying: false,
          currentTime: 0,
          duration: 0,
        }));
        audioEngine.reset();
      }
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Library refresh failed"));
      setSyncMessage("Refresh failed.");
    } finally {
      setIsSyncing(false);
      setScanProgress(null);
    }
  }

  async function addFolders() {
    try {
      setError(null);
      const folders = await pickMusicFolders();
      if (!folders.length) return;

      const uniqueFolders = Array.from(new Set([...settings.musicFolders, ...folders]));
      const nextSettings = { ...settings, musicFolders: uniqueFolders };
      setSettings(nextSettings);
      await saveSettings(nextSettings);
      await refreshLibrary(uniqueFolders);
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Could not add music folders"));
    }
  }

  async function playTrack(track: Track, sourceTracks = visibleTracks) {
    const startedAt = performance.now();
    try {
      setError(null);
      const albumContextTracks =
        allAlbums.find((album) => album.tracks.some((candidate) => candidate.id === track.id))?.tracks ?? [];
      const baseQueue =
        sourceTracks.length > 1
          ? sourceTracks
          : albumContextTracks.length > 1
            ? albumContextTracks
            : sourceTracks.length
              ? sourceTracks
              : [track];
      const nextQueue = makeQueue(baseQueue.map((item) => item.id));
      const nextIndex = nextQueue.findIndex((item) => item.trackId === track.id);

      setQueue(nextQueue);
      setCurrentIndex(nextIndex);
      setPlayback((state) => ({
        ...state,
        currentTrackId: track.id,
        currentTime: 0,
        duration: track.durationMs / 1000,
      }));
      logPlaybackDebug("track selected from library", {
        trackId: track.id,
        format: track.format,
        sourceTrackCount: sourceTracks.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      await audioEngine.load(track);
      logPlaybackDebug("track load finished from library", {
        trackId: track.id,
        format: track.format,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (cause) {
      console.error(cause);
      setError(getPlaybackErrorMessage(cause));
    }
  }

  async function playQueueIndex(index: number) {
    const startedAt = performance.now();
    try {
      setError(null);
      const track = tracksById.get(queue[index]?.trackId ?? "");
      if (!track) return;

      setCurrentIndex(index);
      setPlayback((state) => ({
        ...state,
        currentTrackId: track.id,
        currentTime: 0,
        duration: track.durationMs / 1000,
      }));
      logPlaybackDebug("queue track selected", {
        trackId: track.id,
        format: track.format,
        index,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      await audioEngine.load(track);
      logPlaybackDebug("queue track load finished", {
        trackId: track.id,
        format: track.format,
        index,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (cause) {
      console.error(cause);
      setError(getPlaybackErrorMessage(cause));
    }
  }

  async function togglePlay() {
    try {
      setError(null);
      if (playback.isPlaying) {
        audioEngine.pause();
        return;
      }

      if (currentTrack) {
        await audioEngine.resume(currentTrack, playback.currentTime);
        return;
      }

      if (queue.length) {
        await playQueueIndex(Math.max(currentIndex, 0));
        return;
      }

      if (visibleTracks.length) {
        await playTrack(visibleTracks[0], visibleTracks);
      }
    } catch (cause) {
      console.error(cause);
      setError(getPlaybackErrorMessage(cause));
    }
  }

  async function playNext() {
    const nextIndex = getNextQueueIndex(queue, currentIndex, playback.repeatMode, playback.shuffle);
    if (nextIndex === -1) {
      setPlayback((state) => ({ ...state, isPlaying: false }));
      return;
    }
    await playQueueIndex(nextIndex);
  }

  async function playPrevious() {
    if (!queue.length) return;
    const previousIndex = getPreviousQueueIndex(currentIndex <= 0 ? 0 : currentIndex, playback.currentTime);
    await playQueueIndex(previousIndex);
  }

  function addToQueue(track: Track) {
    setQueue((state) => [
      ...state,
      {
        queueId: `${track.id}-${state.length + 1}`,
        trackId: track.id,
      },
    ]);
  }

  function playNextAfterCurrent(track: Track) {
    setQueue((state) => {
      const nextQueue = [...state];
      const insertAt = Math.max(currentIndex + 1, 0);
      nextQueue.splice(insertAt, 0, {
        queueId: `${track.id}-next-${Date.now()}`,
        trackId: track.id,
      });
      return nextQueue;
    });
  }

  function moveQueue(from: number, to: number) {
    setQueue((state) => moveQueueItem(state, from, to));
    setCurrentIndex((state) => {
      if (state === from) return to;
      if (from < state && to >= state) return state - 1;
      if (from > state && to <= state) return state + 1;
      return state;
    });
  }

  function removeFromQueue(index: number) {
    setQueue((state) => removeQueueItem(state, index));

    if (index === currentIndex) {
      audioEngine.reset();
      setCurrentIndex(-1);
      setPlayback((state) => ({
        ...state,
        currentTrackId: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
      }));
      return;
    }

    if (index < currentIndex) {
      setCurrentIndex((state) => state - 1);
    }
  }

  function setVolume(volume: number) {
    setPlayback((state) => ({ ...state, volume, muted: volume === 0 ? true : false }));
  }

  function toggleMute() {
    setPlayback((state) => ({ ...state, muted: !state.muted }));
  }

  function toggleShuffle() {
    setPlayback((state) => ({ ...state, shuffle: !state.shuffle }));
  }

  function cycleRepeat() {
    setPlayback((state) => ({ ...state, repeatMode: cycleRepeatMode(state.repeatMode) }));
  }

  function seek(seconds: number) {
    audioEngine.seek(seconds);
    setPlayback((state) => ({ ...state, currentTime: seconds }));
  }

  function chooseArtist(artistId: string | null) {
    setSelectedArtistId(artistId);
    setSelectedAlbumId(null);
    if (artistId) {
      setFocusedArtistId(artistId);
    }
  }

  function chooseAlbum(albumId: string | null) {
    setSelectedAlbumId(albumId);
  }

  function playAlbum(album: (typeof visibleAlbums)[number]) {
    const firstTrack = album.tracks[0];
    if (!firstTrack) return;
    void playTrack(firstTrack, album.tracks);
  }

  return {
    loading,
    isSyncing,
    error,
    syncMessage,
    scanProgress,
    searchQuery,
    artists,
    allAlbums,
    visibleAlbums,
    visibleTracks,
    selectedArtist,
    focusedArtist,
    selectedAlbum,
    currentAlbum,
    selectedArtistId,
    selectedAlbumId,
    currentIndex,
    currentTrack,
    queue,
    tracksById,
    playback,
    settings,
    library,
    fallbackArtist: UNKNOWN_ARTIST,
    fallbackAlbum: UNKNOWN_ALBUM,
    setSearchQuery,
    setSelectedArtistId: chooseArtist,
    setSelectedAlbumId: chooseAlbum,
    addFolders,
    refreshLibrary: () => refreshLibrary(),
    playTrack,
    playAlbum,
    playQueueIndex,
    togglePlay,
    playNext,
    playPrevious,
    addToQueue,
    playNextAfterCurrent,
    moveQueue,
    removeFromQueue,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    seek,
  };
}
