import type { Album, ArtistGroup, LibraryData, Track } from "./types";

export const UNKNOWN_ARTIST = "Unknown Artist";
export const UNKNOWN_ALBUM = "Unknown Album";

const normalizedTracks = new WeakSet<Track>();
const normalizedLibraries = new WeakSet<LibraryData>();
const trackSearchTextCache = new WeakMap<Track, string>();

function normalizeValue(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function compareTracks(a: Track, b: Track) {
  if (a.artist !== b.artist) return a.artist.localeCompare(b.artist);
  if (a.album !== b.album) return a.album.localeCompare(b.album);
  const trackNumberA = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
  const trackNumberB = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
  if (trackNumberA !== trackNumberB) return trackNumberA - trackNumberB;
  return a.title.localeCompare(b.title);
}

function markTrackNormalized(track: Track) {
  normalizedTracks.add(track);
  return track;
}

function markLibraryNormalized(library: LibraryData) {
  normalizedLibraries.add(library);
  for (const track of library.tracks) {
    normalizedTracks.add(track);
  }
  return library;
}

function ensureNormalizedLibrary(library: LibraryData) {
  return normalizedLibraries.has(library) ? library : normalizeLibrary(library);
}

function getTrackSearchText(track: Track) {
  const cached = trackSearchTextCache.get(track);
  if (cached !== undefined) {
    return cached;
  }

  const searchText = [track.title, track.artist, track.album, track.filename].join(" ").toLowerCase();
  trackSearchTextCache.set(track, searchText);
  return searchText;
}

export function normalizeTrack(track: Track): Track {
  if (normalizedTracks.has(track)) {
    return track;
  }

  return markTrackNormalized({
    ...track,
    artPath: track.artPath?.trim() || null,
    title: normalizeValue(track.title, track.filename),
    artist: normalizeValue(track.artist, UNKNOWN_ARTIST),
    album: normalizeValue(track.album, UNKNOWN_ALBUM),
    releaseYear: Number.isFinite(track.releaseYear) ? track.releaseYear : null,
  });
}

export function normalizeLibrary(library: LibraryData): LibraryData {
  if (normalizedLibraries.has(library)) {
    return library;
  }

  const uniqueTracks = Array.from(new Map(library.tracks.map((track) => [track.id, normalizeTrack(track)])).values());
  uniqueTracks.sort(compareTracks);

  return markLibraryNormalized({
    ...library,
    tracks: uniqueTracks,
  });
}

export function groupLibrary(library: LibraryData): ArtistGroup[] {
  const normalizedLibrary = ensureNormalizedLibrary(library);
  const artists: ArtistGroup[] = [];
  let currentArtist: ArtistGroup | null = null;
  let currentAlbum: Album | null = null;

  for (const track of normalizedLibrary.tracks) {
    if (!currentArtist || currentArtist.name !== track.artist) {
      currentArtist = {
        id: track.artist,
        name: track.artist,
        albums: [],
        trackCount: 0,
      };
      artists.push(currentArtist);
      currentAlbum = null;
    }

    if (!currentAlbum || currentAlbum.title !== track.album) {
      currentAlbum = {
        id: `${track.artist}::${track.album}`,
        title: track.album,
        artist: track.artist,
        artPath: null,
        releaseYear: null,
        tracks: [],
        trackCount: 0,
        totalDurationMs: 0,
      };
      currentArtist.albums.push(currentAlbum);
    }

    currentAlbum.tracks.push(track);
    currentAlbum.trackCount += 1;
    currentAlbum.totalDurationMs += track.durationMs;
    currentArtist.trackCount += 1;

    if (currentAlbum.artPath === null && track.artPath) {
      currentAlbum.artPath = track.artPath;
    }

    if (currentAlbum.releaseYear === null && track.releaseYear !== null) {
      currentAlbum.releaseYear = track.releaseYear;
    }
  }

  return artists;
}

export function filterLibrary(library: LibraryData, query: string): LibraryData {
  const normalizedLibrary = ensureNormalizedLibrary(library);
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return normalizedLibrary;

  return markLibraryNormalized({
    ...normalizedLibrary,
    tracks: normalizedLibrary.tracks.filter((track) => getTrackSearchText(track).includes(trimmed)),
  });
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const roundedSeconds = Math.floor(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainder = roundedSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
