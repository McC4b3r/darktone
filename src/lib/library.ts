import type { Album, ArtistGroup, LibraryData, Track } from "./types";

export const UNKNOWN_ARTIST = "Unknown Artist";
export const UNKNOWN_ALBUM = "Unknown Album";

function normalizeValue(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function normalizeTrack(track: Track): Track {
  return {
    ...track,
    title: normalizeValue(track.title, track.filename),
    artist: normalizeValue(track.artist, UNKNOWN_ARTIST),
    album: normalizeValue(track.album, UNKNOWN_ALBUM),
  };
}

export function normalizeLibrary(library: LibraryData): LibraryData {
  return {
    ...library,
    tracks: library.tracks
      .map(normalizeTrack)
      .sort((a, b) => {
        if (a.artist !== b.artist) return a.artist.localeCompare(b.artist);
        if (a.album !== b.album) return a.album.localeCompare(b.album);
        const trackNumberA = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
        const trackNumberB = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
        if (trackNumberA !== trackNumberB) return trackNumberA - trackNumberB;
        return a.title.localeCompare(b.title);
      }),
  };
}

export function groupLibrary(library: LibraryData): ArtistGroup[] {
  const artists = new Map<string, Map<string, Track[]>>();

  for (const rawTrack of library.tracks) {
    const track = normalizeTrack(rawTrack);
    const artistAlbums = artists.get(track.artist) ?? new Map<string, Track[]>();
    const albumTracks = artistAlbums.get(track.album) ?? [];

    albumTracks.push(track);
    artistAlbums.set(track.album, albumTracks);
    artists.set(track.artist, artistAlbums);
  }

  return Array.from(artists.entries())
    .map(([artistName, albumsMap]) => {
      const albums: Album[] = Array.from(albumsMap.entries())
        .map(([albumTitle, tracks]) => {
          const sortedTracks = [...tracks].sort((a, b) => {
            const trackNumberA = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
            const trackNumberB = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
            if (trackNumberA !== trackNumberB) return trackNumberA - trackNumberB;
            return a.title.localeCompare(b.title);
          });

          return {
            id: `${artistName}::${albumTitle}`,
            title: albumTitle,
            artist: artistName,
            tracks: sortedTracks,
            trackCount: sortedTracks.length,
            totalDurationMs: sortedTracks.reduce((sum, track) => sum + track.durationMs, 0),
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));

      return {
        id: artistName,
        name: artistName,
        albums,
        trackCount: albums.reduce((sum, album) => sum + album.trackCount, 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterLibrary(library: LibraryData, query: string): LibraryData {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return normalizeLibrary(library);

  return {
    ...library,
    tracks: normalizeLibrary(library).tracks.filter((track) =>
      [track.title, track.artist, track.album, track.filename]
        .join(" ")
        .toLowerCase()
        .includes(trimmed),
    ),
  };
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
