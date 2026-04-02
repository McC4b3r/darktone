import { animated, useReducedMotion, useSpring } from "@react-spring/web";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Album, ArtistGroup, Track } from "../lib/types";
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

const ARTIST_ROW_SIZE = 32;
const ALBUM_ROW_SIZE = 32;
const TRACK_ROW_SIZE = 24;
const EXPANDED_GROUP_PADDING = 6;

type SidebarArtistRow = {
  key: string;
  kind: "artist";
  size: number;
  artist: ArtistGroup;
  isActive: boolean;
  isExpanded: boolean;
};

type SidebarAlbumRow = {
  key: string;
  kind: "album";
  size: number;
  artistId: string;
  album: Album;
  isExpanded: boolean;
  isFirstAlbum: boolean;
};

type SidebarTrackRow = {
  key: string;
  kind: "track";
  size: number;
  albumId: string;
  track: Track;
  albumTracks: Track[];
  isFirstTrack: boolean;
};

type SidebarRow = SidebarArtistRow | SidebarAlbumRow | SidebarTrackRow;

function getSidebarRowKey(row: SidebarRow) {
  return row.key;
}

function getSidebarRowSize(row: SidebarRow) {
  return row.size;
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

  const rows = useMemo<SidebarRow[]>(() => {
    const nextRows: SidebarRow[] = [];

    for (const artist of artists) {
      const isExpanded = selectedArtistId === artist.id;
      nextRows.push({
        key: `artist:${artist.id}`,
        kind: "artist",
        size: ARTIST_ROW_SIZE,
        artist,
        isActive: activeArtistId === artist.id,
        isExpanded,
      });

      if (!isExpanded) {
        continue;
      }

      for (const [albumIndex, album] of artist.albums.entries()) {
        const albumExpanded = selectedAlbumId === album.id;
        nextRows.push({
          key: `album:${album.id}`,
          kind: "album",
          size: ALBUM_ROW_SIZE + (albumIndex === 0 ? EXPANDED_GROUP_PADDING : 0),
          artistId: artist.id,
          album,
          isExpanded: albumExpanded,
          isFirstAlbum: albumIndex === 0,
        });

        if (!albumExpanded) {
          continue;
        }

        for (const [trackIndex, track] of album.tracks.entries()) {
          nextRows.push({
            key: `track:${track.id}`,
            kind: "track",
            size: TRACK_ROW_SIZE + (trackIndex === 0 ? EXPANDED_GROUP_PADDING : 0),
            albumId: album.id,
            track,
            albumTracks: album.tracks,
            isFirstTrack: trackIndex === 0,
          });
        }
      }
    }

    return nextRows;
  }, [activeArtistId, artists, selectedAlbumId, selectedArtistId]);

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

    const anchorArtistIndex = rows.findIndex((row) => row.kind === "artist" && row.artist.id === anchorArtistId);
    if (anchorArtistIndex === -1) {
      return;
    }

    scrollRequestKeyRef.current += 1;
    setScrollRequest({
      index: anchorArtistIndex,
      key: scrollRequestKeyRef.current,
    });
  }, [activeArtistId, rows, searchQuery, selectedArtistId]);

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
                    <span aria-hidden="true">&times;</span>
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
              items={rows}
              className="artist-list"
              virtualizationThreshold={36}
              getKey={getSidebarRowKey}
              scrollToIndex={scrollRequest?.index ?? null}
              scrollRequestKey={scrollRequest?.key ?? null}
              scrollAlignment="start"
              getItemSize={getSidebarRowSize}
              renderItem={(row) => {
                if (row.kind === "artist") {
                  return (
                    <button
                      className={`nav-item ${row.isActive ? "nav-item--active" : ""}`}
                      onClick={() => {
                        if (row.isExpanded) {
                          onSelectArtist(null);
                          return;
                        }

                        onSelectArtist(row.artist.id);
                        if (!row.isActive) {
                          onSelectAlbum(null);
                        }
                      }}
                    >
                      <span>{row.artist.name}</span>
                      <span className="nav-item__meta">{row.artist.albums.length}</span>
                    </button>
                  );
                }

                if (row.kind === "album") {
                  return (
                    <div
                      className="tree-node"
                      style={{
                        paddingTop: row.isFirstAlbum ? EXPANDED_GROUP_PADDING : 0,
                        paddingLeft: 8,
                      }}
                    >
                      <button
                        className={`sub-nav-item ${row.isExpanded ? "sub-nav-item--active" : ""}`}
                        onClick={() => onSelectAlbum(row.isExpanded ? null : row.album.id)}
                      >
                        <span className="tree-label">
                          <span className="tree-caret">{row.isExpanded ? "▾" : "▸"}</span>
                          <span>{row.album.title}</span>
                        </span>
                        <span className="nav-item__meta">{row.album.trackCount}</span>
                      </button>
                    </div>
                  );
                }

                return (
                  <div
                    style={{
                      paddingTop: row.isFirstTrack ? EXPANDED_GROUP_PADDING : 0,
                      marginLeft: 14,
                      paddingLeft: 8,
                      borderLeft: "1px solid rgba(124, 149, 187, 0.12)",
                    }}
                  >
                    <button
                      className={`tree-leaf ${currentTrackId === row.track.id ? "tree-leaf--active" : ""}`}
                      onClick={() => onSelectTrack(row.track, row.albumTracks)}
                      title={row.track.title}
                    >
                      <span className="tree-label">
                        <span className="tree-file-dot">♪</span>
                        <span className="tree-leaf__text">{row.track.title}</span>
                      </span>
                    </button>
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
