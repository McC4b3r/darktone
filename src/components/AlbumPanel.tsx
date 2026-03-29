import { formatTime } from "../lib/library";
import type { Album, Track } from "../lib/types";

interface AlbumPanelProps {
  album: Album;
  currentTrackId: string | null;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
}

export function AlbumPanel({ album, currentTrackId, onSelectTrack }: AlbumPanelProps) {
  const coverGlyph = album.title.slice(0, 1) || album.artist.slice(0, 1) || "•";

  return (
    <div className="library-stage__album panel">
      <div className="library-stage__album-art" aria-hidden="true">
        <span>{coverGlyph}</span>
      </div>
      <div className="library-stage__album-content">
        <div className="library-stage__album-head">
          <div>
            <p className="eyebrow">Album</p>
            <h3>{album.title}</h3>
            <p className="library-stage__album-meta">
              {album.artist} • {album.trackCount} tracks
            </p>
          </div>
        </div>
        <div className="library-stage__album-list" role="list">
          {album.tracks.map((albumTrack, index) => (
            <button
              key={albumTrack.id}
              className={`library-stage__album-track ${currentTrackId === albumTrack.id ? "library-stage__album-track--active" : ""}`}
              onClick={() => onSelectTrack(albumTrack, album.tracks)}
            >
              <span className="library-stage__album-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="library-stage__album-title">{albumTrack.title}</span>
              <span className="library-stage__album-duration">{formatTime(albumTrack.durationMs / 1000)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
