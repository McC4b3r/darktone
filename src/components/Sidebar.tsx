import { animated, useReducedMotion, useSpring } from "@react-spring/web";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ArtistGroup, Track } from "../lib/types";
import { VirtualList } from "./VirtualList";

interface SidebarProps {
  artists: ArtistGroup[];
  activeArtistId: string | null;
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
  activeArtistId,
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
  const previousSearchQueryRef = useRef(searchQuery);
  const scrollRequestKeyRef = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{ index: number; key: number } | null>(null);
  const ARTIST_GROUP_ROW_HEIGHT = 44;
  const ALBUM_ROW_HEIGHT = 42;
  const TRACK_ROW_HEIGHT = 32;
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

  useEffect(() => {
    const previousSearchQuery = previousSearchQueryRef.current;
    const didClearSearch = previousSearchQuery.trim().length > 0 && searchQuery.trim().length === 0;
    previousSearchQueryRef.current = searchQuery;

    if (!didClearSearch) {
      return;
    }

    const anchorArtistId = selectedArtistId ?? activeArtistId;
    if (!anchorArtistId) {
      return;
    }

    const anchorArtistIndex = artists.findIndex((artist) => artist.id === anchorArtistId);
    if (anchorArtistIndex === -1) {
      return;
    }

    scrollRequestKeyRef.current += 1;
    setScrollRequest({
      index: anchorArtistIndex,
      key: scrollRequestKeyRef.current,
    });
  }, [activeArtistId, artists, searchQuery, selectedArtistId]);

  function clearSearch() {
    onSearchChange("");
    searchInputRef.current?.focus();
  }

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
                <span className="sidebar__collapse-chevron" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="sidebar__section">
            <label className="field">
              <span className="field__label">Search</span>
              <div className="sidebar__search-control">
                <input
                  ref={searchInputRef}
                  className="input sidebar__search-input"
                  value={searchQuery}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Artist, album, or track"
                />
                {searchQuery.trim() ? (
                  <button
                    type="button"
                    className="sidebar__search-clear"
                    aria-label="Clear search"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={clearSearch}
                  >
                    <span aria-hidden="true">x</span>
                  </button>
                ) : null}
              </div>
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
            <VirtualList
              items={artists}
              className="artist-list"
              itemClassName="artist-list__item"
              virtualizationThreshold={36}
              getKey={(artist) => artist.id}
              scrollToIndex={scrollRequest?.index ?? null}
              scrollRequestKey={scrollRequest?.key ?? null}
              scrollAlignment="start"
              getItemSize={(artist) => {
                let size = ARTIST_GROUP_ROW_HEIGHT + 6;

                if (selectedArtistId !== artist.id) {
                  return size;
                }

                size += 10;
                size += artist.albums.reduce((total, album) => {
                  let albumSize = ALBUM_ROW_HEIGHT + 6;
                  if (selectedAlbumId === album.id) {
                    albumSize += 12 + album.tracks.length * (TRACK_ROW_HEIGHT + 2);
                  }
                  return total + albumSize;
                }, 0);

                return size;
              }}
              renderItem={(artist) => {
                const isExpanded = selectedArtistId === artist.id;
                const isActive = activeArtistId === artist.id;

                return (
                  <div className="artist-list__group">
                    <button
                      className={`nav-item ${isActive ? "nav-item--active" : ""}`}
                      onClick={() => {
                        if (isExpanded) {
                          onSelectArtist(null);
                          return;
                        }

                        onSelectArtist(artist.id);
                        if (!isActive) {
                          onSelectAlbum(null);
                        }
                      }}
                    >
                      <span>{artist.name}</span>
                      <span className="nav-item__meta">{artist.albums.length}</span>
                    </button>

                    {isExpanded ? (
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
                );
              }}
            />
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
