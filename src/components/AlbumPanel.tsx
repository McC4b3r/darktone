import { convertFileSrc } from "@tauri-apps/api/core";
import { UNKNOWN_ALBUM, formatTime } from "../lib/library";
import type { Album, ArtistGroup, Track } from "../lib/types";
import { AlbumGrid } from "./AlbumGrid";
import { VirtualList } from "./VirtualList";

interface AlbumPanelProps {
  artist: ArtistGroup | null;
  album: Album | null;
  currentTrackId: string | null;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
}

function TrackList({
  tracks,
  currentTrackId,
  onSelectTrack,
}: {
  tracks: Track[];
  currentTrackId: string | null;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
}) {
  return (
    <VirtualList
      items={tracks}
      className="library-stage__album-list"
      itemClassName="library-stage__album-track-row"
      role="list"
      virtualizationThreshold={28}
      getKey={(albumTrack) => albumTrack.id}
      getItemSize={() => 43}
      renderItem={(albumTrack, index) => (
        <button
          className={`library-stage__album-track ${currentTrackId === albumTrack.id ? "library-stage__album-track--active" : ""}`}
          onClick={() => onSelectTrack(albumTrack, tracks)}
        >
          <span className="library-stage__album-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="library-stage__album-title" title={albumTrack.title}>
            {albumTrack.title}
          </span>
          <span className="library-stage__album-duration">{formatTime(albumTrack.durationMs / 1000)}</span>
        </button>
      )}
    />
  );
}

export function AlbumPanel({ artist, album, currentTrackId, onSelectAlbum, onSelectTrack }: AlbumPanelProps) {
  const looseSongsAlbum =
    artist && artist.albums.length === 1 && artist.albums[0]?.title === UNKNOWN_ALBUM ? artist.albums[0] : null;

  if (artist && !album && !looseSongsAlbum) {
    return (
      <div className="library-stage__album panel library-stage__album--gallery">
        <div className="library-stage__album-head library-stage__album-head--gallery">
          <div>
            <p className="eyebrow">Artist</p>
            <h3>{artist.name}</h3>
            <p className="library-stage__album-meta">
              {artist.albums.length} album{artist.albums.length === 1 ? "" : "s"} • {artist.trackCount} tracks
            </p>
          </div>
        </div>
        <AlbumGrid albums={artist.albums} selectedAlbumId={null} onSelectAlbum={onSelectAlbum} compact />
      </div>
    );
  }

  const panelAlbum = looseSongsAlbum ?? album;
  if (!panelAlbum) {
    return null;
  }

  const showArtistBack = Boolean(artist && album && !looseSongsAlbum);
  const coverGlyph = panelAlbum.title.slice(0, 1) || panelAlbum.artist.slice(0, 1) || "•";
  const artSrc = panelAlbum.artPath ? convertFileSrc(panelAlbum.artPath) : null;
  const isArtistSongs = Boolean(looseSongsAlbum);

  return (
    <div className="library-stage__album panel">
      <div className={`library-stage__album-art ${isArtistSongs ? "library-stage__album-art--artist" : ""}`}>
        {isArtistSongs ? (
          <div className="library-stage__artist-tile">
            <span>{artist?.name ?? panelAlbum.artist}</span>
          </div>
        ) : artSrc ? (
          <img src={artSrc} alt={`${panelAlbum.title} album art`} />
        ) : (
          <span aria-hidden="true">{coverGlyph}</span>
        )}
      </div>
      <div className="library-stage__album-content">
        <div className="library-stage__album-head">
          <div>
            <p className="eyebrow">{isArtistSongs ? "Songs" : "Album"}</p>
            <h3>{isArtistSongs ? artist?.name ?? panelAlbum.artist : panelAlbum.title}</h3>
            <p className="library-stage__album-meta">
              {isArtistSongs
                ? `${panelAlbum.trackCount} songs`
                : [panelAlbum.artist, panelAlbum.releaseYear, `${panelAlbum.trackCount} tracks`].filter(Boolean).join(" • ")}
            </p>
          </div>
          {showArtistBack ? (
            <button className="button library-stage__album-back" onClick={() => onSelectAlbum(null)}>
              Back to Albums
            </button>
          ) : null}
        </div>
        <TrackList tracks={panelAlbum.tracks} currentTrackId={currentTrackId} onSelectTrack={onSelectTrack} />
      </div>
    </div>
  );
}
