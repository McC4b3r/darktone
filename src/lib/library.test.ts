import { describe, expect, it } from "vitest";
import { filterLibrary, groupLibrary, normalizeLibrary, UNKNOWN_ALBUM, UNKNOWN_ARTIST } from "./library";
import type { LibraryData } from "./types";

const library: LibraryData = {
  scannedAt: Date.now(),
  tracks: [
    {
      id: "1",
      path: "/music/artist-a/album-a/track-1.mp3",
      artPath: "/music/artist-a/album-a/cover.jpg",
      filename: "track-1.mp3",
      title: "",
      artist: "",
      album: "",
      releaseYear: null,
      trackNumber: 1,
      durationMs: 200000,
      format: "mp3",
      modifiedAt: 1,
    },
    {
      id: "2",
      path: "/music/artist-a/album-a/track-2.mp3",
      artPath: "/music/artist-a/album-a/cover.jpg",
      filename: "track-2.mp3",
      title: "Track Two",
      artist: "Artist A",
      album: "Album A",
      releaseYear: 1998,
      trackNumber: 2,
      durationMs: 210000,
      format: "mp3",
      modifiedAt: 2,
    },
  ],
};

describe("library helpers", () => {
  it("normalizes missing metadata", () => {
    const normalized = normalizeLibrary(library);
    const missingMetadataTrack = normalized.tracks.find((track) => track.id === "1");
    expect(missingMetadataTrack?.title).toBe("track-1.mp3");
    expect(missingMetadataTrack?.artist).toBe(UNKNOWN_ARTIST);
    expect(missingMetadataTrack?.album).toBe(UNKNOWN_ALBUM);
  });

  it("groups by artist and album", () => {
    const grouped = groupLibrary(normalizeLibrary(library));
    expect(grouped).toHaveLength(2);
    expect(grouped[0].albums[0].trackCount).toBe(1);
    const artistAlbum = grouped.find((artist) => artist.name === "Artist A")?.albums.find((album) => album.title === "Album A");
    expect(artistAlbum?.artPath).toBe("/music/artist-a/album-a/cover.jpg");
    expect(artistAlbum?.releaseYear).toBe(1998);
  });

  it("filters on artist album and title text", () => {
    const filtered = filterLibrary(library, "track two");
    expect(filtered.tracks).toHaveLength(1);
    expect(filtered.tracks[0].id).toBe("2");
  });

  it("deduplicates tracks by id during normalization", () => {
    const duplicated: LibraryData = {
      ...library,
      tracks: [...library.tracks, library.tracks[1]],
    };
    const normalized = normalizeLibrary(duplicated);
    expect(normalized.tracks).toHaveLength(2);
  });
});
