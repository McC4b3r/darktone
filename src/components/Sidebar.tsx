import { animated, useReducedMotion, useSpring } from "@react-spring/web";
import type { RefObject } from "react";
import type { ArtistGroup, Track } from "../lib/types";

interface SidebarProps {
  artists: ArtistGroup[];
  selectedArtistId: string | null;
  selectedAlbumId: string | null;
  currentTrackId: string | null;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement>;
  musicFoldersCount: number;
  collapsed: boolean;
  onSelectArtist: (artistId: string | null) => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
  onAddSource: () => void;
  onSearchChange: (value: string) => void;
  onToggleCollapsed: () => void;
  onFocusSearch: () => void;
}

export function Sidebar({
  artists,
  selectedArtistId,
  selectedAlbumId,
  currentTrackId,
  searchQuery,
  searchInputRef,
  musicFoldersCount,
  collapsed,
  onSelectArtist,
  onSelectAlbum,
  onSelectTrack,
  onAddSource,
  onSearchChange,
  onToggleCollapsed,
  onFocusSearch,
}: SidebarProps) {
  const reduceMotion = useReducedMotion();
  const [expandedPaneSpring] = useSpring(() => ({
    opacity: collapsed ? 0 : 1,
    x: collapsed ? -14 : 0,
    delay: collapsed ? 0 : 55,
    config: {
      tension: 320,
      friction: 22,
    },
    immediate: Boolean(reduceMotion),
  }), [collapsed, reduceMotion]);
  const [collapsedPaneSpring] = useSpring(() => ({
    opacity: collapsed ? 1 : 0,
    x: collapsed ? 0 : 10,
    delay: collapsed ? 55 : 0,
    config: {
      tension: 320,
      friction: 22,
    },
    immediate: Boolean(reduceMotion),
  }), [collapsed, reduceMotion]);

  return (
    <aside className={`sidebar panel ${collapsed ? "sidebar--collapsed" : ""}`}>
      <div className="sidebar__viewport">
        <animated.div
          className="sidebar__pane sidebar__pane--expanded"
          style={{
            opacity: expandedPaneSpring.opacity,
            pointerEvents: expandedPaneSpring.opacity.to((value: number) => (value < 0.1 ? "none" : "auto")),
            transform: expandedPaneSpring.x.to((x: number) => `translate3d(${x}px, 0, 0)`),
          }}
        >
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <div>
                <p className="eyebrow">Collection</p>
                <p className="sidebar__section-title">Library Explorer</p>
              </div>
              <button
                className="icon-button sidebar__collapse-toggle"
                onClick={onToggleCollapsed}
                aria-label="Collapse library explorer"
                title="Collapse library explorer"
              >
                <span aria-hidden="true">←</span>
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
              <span>{musicFoldersCount} source{musicFoldersCount === 1 ? "" : "s"}</span>
              <span>{artists.length} artist{artists.length === 1 ? "" : "s"}</span>
            </div>
            {musicFoldersCount === 0 ? (
              <div className="sidebar__source-cta">
                <button className="button sidebar__source-button" onClick={onAddSource}>
                  Add Source
                </button>
                <p className="sidebar__source-hint">Choose a folder to watch and start building your library.</p>
              </div>
            ) : null}
          </div>

          <div className="sidebar__section sidebar__section--grow">
            <div className="artist-list">
              {artists.map((artist) => (
                <div key={artist.id} className="artist-list__group">
                  <button
                    className={`nav-item ${selectedArtistId === artist.id ? "nav-item--active" : ""}`}
                    onClick={() => {
                      onSelectArtist(selectedArtistId === artist.id ? null : artist.id);
                      onSelectAlbum(null);
                    }}
                  >
                    <span>{artist.name}</span>
                    <span className="nav-item__meta">{artist.albums.length}</span>
                  </button>

                  {selectedArtistId === artist.id ? (
                    <div className="artist-list__albums">
                      {artist.albums.map((album) => (
                        <div key={album.id} className="tree-node">
                          <button
                            className={`sub-nav-item ${selectedAlbumId === album.id ? "sub-nav-item--active" : ""}`}
                            onClick={() => onSelectAlbum(selectedAlbumId === album.id ? null : album.id)}
                          >
                            <span className="tree-label">
                              <span className="tree-caret">{selectedAlbumId === album.id ? "▾" : "▸"}</span>
                              <span>{album.title}</span>
                            </span>
                            <span className="nav-item__meta">{album.trackCount}</span>
                          </button>

                          {selectedAlbumId === album.id ? (
                            <div className="tree-children">
                              {album.tracks.map((track) => (
                                <button
                                  key={track.id}
                                  className={`tree-leaf ${currentTrackId === track.id ? "tree-leaf--active" : ""}`}
                                  onClick={() => onSelectTrack(track, album.tracks)}
                                  title={track.title}
                                >
                                  <span className="tree-label">
                                    <span className="tree-file-dot">♪</span>
                                    <span className="tree-leaf__text">{track.title}</span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </animated.div>

        <animated.div
          className="sidebar__pane sidebar__pane--collapsed"
          style={{
            opacity: collapsedPaneSpring.opacity,
            pointerEvents: collapsedPaneSpring.opacity.to((value: number) => (value < 0.1 ? "none" : "auto")),
            transform: collapsedPaneSpring.x.to((x: number) => `translate3d(${x}px, 0, 0)`),
          }}
        >
          <button
            className="icon-button sidebar__collapse-toggle sidebar__dock-button"
            onClick={onToggleCollapsed}
            aria-label="Expand library explorer"
            title="Expand library explorer"
          >
            <span className="sidebar__dock-icon sidebar__dock-icon--door" aria-hidden="true" />
          </button>
          <button
            className="icon-button sidebar__collapsed-action sidebar__dock-button"
            onClick={onFocusSearch}
            aria-label="Expand and focus search"
            title="Expand and focus search"
          >
            <span className="sidebar__dock-icon sidebar__dock-icon--search" aria-hidden="true" />
          </button>
          <div className="sidebar__collapsed-caption" aria-hidden="true">
            <span>LIB</span>
          </div>
        </animated.div>
      </div>
    </aside>
  );
}
