import { useEffect, useRef, useState } from "react";
import { animated, useReducedMotion, useSpring } from "@react-spring/web";
import { listen } from "@tauri-apps/api/event";
import { EmptyState } from "./components/EmptyState";
import { LibraryStage } from "./components/LibraryStage";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { TransportBar } from "./components/TransportBar";
import { usePlayerApp } from "./hooks/usePlayerApp";

function useMediaQuery(query: string) {
  const getMatches = () => window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const onChange = () => setMatches(mediaQuery.matches);
    onChange();
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export default function App() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const reduceMotion = useReducedMotion();
  const compactLayout = useMediaQuery("(max-width: 840px)");
  const narrowDesktop = useMediaQuery("(max-width: 1200px)");
  const {
    error,
    artists,
    visibleAlbums,
    selectedArtist,
    selectedAlbum,
    currentAlbum,
    selectedArtistId,
    selectedAlbumId,
    currentTrack,
    currentIndex,
    queue,
    tracksById,
    playback,
    settings,
    searchQuery,
    setSearchQuery,
    setSelectedArtistId,
    setSelectedAlbumId,
    addFolders,
    refreshLibrary,
    playTrack,
    playQueueIndex,
    togglePlay,
    playNext,
    playPrevious,
    moveQueue,
    removeFromQueue,
    setVolume,
    toggleMute,
    seek,
  } = usePlayerApp();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void addFolders();
        return;
      }

      if (isInput) return;

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void playNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void playPrevious();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addFolders, playNext, playPrevious, togglePlay]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen("menu-open", () => {
      void addFolders();
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [addFolders]);

  useEffect(() => {
    if (compactLayout) {
      setSidebarCollapsed(false);
    }
  }, [compactLayout]);

  const expandedSidebarWidth = narrowDesktop ? 240 : 242;
  const [sidebarSpring] = useSpring(() => ({
    sidebarWidth: sidebarCollapsed ? 84 : expandedSidebarWidth,
    delay: sidebarCollapsed ? 55 : 0,
    config: {
      tension: 340,
      friction: 28,
      clamp: false,
    },
    immediate: Boolean(reduceMotion) || compactLayout,
  }), [sidebarCollapsed, expandedSidebarWidth, reduceMotion, compactLayout]);

  return (
    <animated.div
      className="app-shell"
      style={
        compactLayout
          ? undefined
          : {
              gridTemplateColumns: sidebarSpring.sidebarWidth.to(
                (width) => `${width}px minmax(0, 1fr) 48px`,
              ),
            }
      }
    >
      <Sidebar
        artists={artists}
        selectedArtistId={selectedArtistId}
        selectedAlbumId={selectedAlbumId}
        currentTrackId={currentTrack?.id ?? null}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        musicFoldersCount={settings.musicFolders.length}
        collapsed={sidebarCollapsed}
        onSelectArtist={setSelectedArtistId}
        onSelectAlbum={setSelectedAlbumId}
        onSelectTrack={(track, albumTracks) => void playTrack(track, albumTracks)}
        onSearchChange={setSearchQuery}
        onToggleCollapsed={() => setSidebarCollapsed((state) => !state)}
        onFocusSearch={() => {
          setSidebarCollapsed(false);
          searchInputRef.current?.focus();
        }}
      />

      <main className="content">
        {error ? <div className="error-banner panel">{error}</div> : null}

        {!settings.musicFolders.length ? (
          <EmptyState
            title="Start with a music folder"
            body="Use File > Open or press Cmd/Ctrl+O to add one or more folders and scan MP3, WAV, and FLAC files into your local library."
          />
        ) : visibleAlbums.length === 0 ? (
          <EmptyState
            title="No matching music found"
            body="Try a different search term or refresh the indexed folders."
            action={
              <button className="button" onClick={() => void refreshLibrary()}>
                Refresh Library
              </button>
            }
          />
        ) : (
          <>
            <LibraryStage
              artist={selectedArtist}
              album={selectedAlbum}
              nowPlayingAlbum={currentAlbum}
              track={currentTrack}
              playback={playback}
              onTogglePlay={() => void togglePlay()}
              onPrevious={() => void playPrevious()}
              onNext={() => void playNext()}
              onSelectAlbum={setSelectedAlbumId}
              onSelectTrack={(track, albumTracks) => void playTrack(track, albumTracks)}
            />
          </>
        )}
      </main>

      <QueuePanel
        open={queueOpen}
        queue={queue}
        currentIndex={currentIndex}
        tracksById={tracksById}
        onToggleOpen={() => setQueueOpen((state) => !state)}
        onPlayIndex={(index) => void playQueueIndex(index)}
        onMove={moveQueue}
        onRemove={removeFromQueue}
      />

      <TransportBar
        playback={playback}
        onSeek={seek}
        onVolumeChange={setVolume}
        onToggleMute={toggleMute}
      />
    </animated.div>
  );
}
