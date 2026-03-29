import { formatDuration } from "../lib/library";
import type { Album } from "../lib/types";

interface AlbumGridProps {
  albums: Album[];
  selectedAlbumId: string | null;
  onSelectAlbum: (albumId: string) => void;
}

export function AlbumGrid({ albums, selectedAlbumId, onSelectAlbum }: AlbumGridProps) {
  return (
    <section className="album-grid">
      {albums.map((album) => (
        <button
          key={album.id}
          className={`album-card panel ${selectedAlbumId === album.id ? "album-card--active" : ""}`}
          onClick={() => onSelectAlbum(album.id)}
        >
          <div className="album-card__cover">
            <span>{album.artist.slice(0, 1)}</span>
            <div className="album-card__overlay">
              <div className="album-card__body">
                <p className="album-card__title">{album.title}</p>
                <p className="album-card__artist">{album.artist}</p>
                <div className="album-card__meta">
                  <span>{album.trackCount} tracks</span>
                  <span>{formatDuration(album.totalDurationMs)}</span>
                </div>
              </div>
            </div>
          </div>
        </button>
      ))}
    </section>
  );
}
