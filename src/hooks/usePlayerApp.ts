import { useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "../lib/audio";
import {
  filterLibrary,
  groupLibrary,
  normalizeLibrary,
  UNKNOWN_ALBUM,
  UNKNOWN_ARTIST,
} from "../lib/library";
import { getNextQueueIndex, getPreviousQueueIndex, makeQueue, moveQueueItem, removeQueueItem } from "../lib/queue";
import { loadLibrary, loadSettings, pickMusicFolders, saveSettings, scanLibrary } from "../lib/tauri";
import type { AppSettings, LibraryData, PlaybackState, QueueItem, RepeatMode, Track } from "../lib/types";

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

const EMPTY_SPECTRUM = Array.from({ length: 160 }, () => 0);

export function usePlayerApp() {
  const [library, setLibrary] = useState<LibraryData>(EMPTY_LIBRARY);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncMessage, setSyncMessage] = useState("Loading library…");
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
    spectrum: EMPTY_SPECTRUM,
  });

  const hasInitializedRef = useRef(false);

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
  const visibleAlbums = selectedArtist ? selectedArtist.albums : allAlbums;
  const selectedAlbum =
    visibleAlbums.find((album) => album.id === selectedAlbumId) ??
    selectedArtist?.albums[0] ??
    visibleAlbums[0] ??
    null;

  const visibleTracks = selectedAlbum?.tracks ?? filteredLibrary.tracks;
  const currentTrack =
    currentIndex >= 0 ? tracksById.get(queue[currentIndex]?.trackId ?? "") ?? null : null;

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
        setError(`Playback failed: ${message}`);
      },
      onSpectrumUpdate: (spectrum) => {
        setPlayback((state) => ({ ...state, spectrum }));
      },
    });
  }, []);

  useEffect(() => {
    void initialize();
    // We only want the boot sequence once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const [storedSettings, storedLibrary] = await Promise.all([
        loadSettings().catch(() => DEFAULT_SETTINGS),
        loadLibrary().catch(() => EMPTY_LIBRARY),
      ]);

      const nextLibrary = normalizeLibrary(storedLibrary);
      setSettings(storedSettings);
      setLibrary(nextLibrary);
      setPlayback((state) => ({
        ...state,
        currentTrackId: storedSettings.currentTrackId,
        volume: storedSettings.volume,
        muted: storedSettings.muted,
        repeatMode: storedSettings.repeatMode,
        shuffle: storedSettings.shuffle,
      }));

      const restoredQueue = storedSettings.queueTrackIds.filter((trackId) => nextLibrary.tracks.some((track) => track.id === trackId));
      setQueue(makeQueue(restoredQueue));
      setCurrentIndex(
        storedSettings.currentTrackId ? restoredQueue.findIndex((trackId) => trackId === storedSettings.currentTrackId) : -1,
      );

      if (storedSettings.musicFolders.length) {
        await refreshLibrary(storedSettings.musicFolders, false);
      } else {
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
      if (announce) setSyncMessage("Refreshing library…");
      const result = await scanLibrary(folders);
      const normalized = normalizeLibrary(result.library);

      setLibrary(normalized);
      setSyncMessage(`Indexed ${result.scannedFiles} files from ${folders.length} folder${folders.length === 1 ? "" : "s"}.`);

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
          spectrum: EMPTY_SPECTRUM,
        }));
        audioEngine.reset();
      }
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Library refresh failed"));
      setSyncMessage("Refresh failed.");
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
    try {
      setError(null);
      const baseQueue = sourceTracks.length ? sourceTracks : [track];
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
      await audioEngine.load(track);
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Playback failed"));
    }
  }

  async function playQueueIndex(index: number) {
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
      await audioEngine.load(track);
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Playback failed"));
    }
  }

  async function togglePlay() {
    try {
      setError(null);
      if (!queue.length && visibleTracks.length) {
        await playTrack(visibleTracks[0], visibleTracks);
        return;
      }
      await audioEngine.toggle();
    } catch (cause) {
      console.error(cause);
      setError(getErrorMessage(cause, "Playback failed"));
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
        spectrum: EMPTY_SPECTRUM,
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
    error,
    syncMessage,
    searchQuery,
    artists,
    allAlbums,
    visibleAlbums,
    visibleTracks,
    selectedAlbum,
    selectedArtistId,
    selectedAlbumId: selectedAlbum?.id ?? null,
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
