import type { RefObject } from "react";
import type { ArtistGroup } from "../lib/types";

interface SidebarProps {
  artists: ArtistGroup[];
  selectedArtistId: string | null;
  selectedAlbumId: string | null;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement>;
  musicFolders: string[];
  onSelectArtist: (artistId: string | null) => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSearchChange: (value: string) => void;
  onAddFolders: () => void;
  onRefreshLibrary: () => void;
}

export function Sidebar({
  artists,
  selectedArtistId,
  selectedAlbumId,
  searchQuery,
  searchInputRef,
  musicFolders,
  onSelectArtist,
  onSelectAlbum,
  onSearchChange,
  onAddFolders,
  onRefreshLibrary,
}: SidebarProps) {
  return (
    <aside className="sidebar panel">
      <div className="sidebar__section">
        <p className="eyebrow">Collection</p>
        <div className="sidebar__actions">
          <button className="button button--primary" onClick={onAddFolders}>
            Add Folder
          </button>
          <button className="button" onClick={onRefreshLibrary} disabled={!musicFolders.length}>
            Refresh
          </button>
        </div>
      </div>

      <div className="sidebar__section">
        <label className="field">
          <span className="field__label">Search</span>
          <input
            ref={searchInputRef}
            className="input"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Artist, album, or track"
          />
        </label>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__meta">
          <span>{musicFolders.length} source{musicFolders.length === 1 ? "" : "s"}</span>
          <span>{artists.length} artist{artists.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="sidebar__section sidebar__section--grow">
        <button
          className={`nav-item ${selectedArtistId === null ? "nav-item--active" : ""}`}
          onClick={() => {
            onSelectArtist(null);
            onSelectAlbum(null);
          }}
        >
          All Artists
        </button>

        <div className="artist-list">
          {artists.map((artist) => (
            <div key={artist.id} className="artist-list__group">
              <button
                className={`nav-item ${selectedArtistId === artist.id ? "nav-item--active" : ""}`}
                onClick={() => {
                  onSelectArtist(artist.id);
                  onSelectAlbum(null);
                }}
              >
                <span>{artist.name}</span>
                <span className="nav-item__meta">{artist.albums.length}</span>
              </button>

              {selectedArtistId === artist.id ? (
                <div className="artist-list__albums">
                  {artist.albums.map((album) => (
                    <button
                      key={album.id}
                      className={`sub-nav-item ${selectedAlbumId === album.id ? "sub-nav-item--active" : ""}`}
                      onClick={() => onSelectAlbum(album.id)}
                    >
                      <span>{album.title}</span>
                      <span className="nav-item__meta">{album.trackCount}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
