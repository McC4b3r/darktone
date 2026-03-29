import { useEffect, useRef, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { LibraryStage } from "./components/LibraryStage";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { TransportBar } from "./components/TransportBar";
import { usePlayerApp } from "./hooks/usePlayerApp";

export default function App() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const {
    loading,
    error,
    syncMessage,
    artists,
    visibleAlbums,
    selectedAlbum,
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
    playAlbum,
    playQueueIndex,
    togglePlay,
    playNext,
    playPrevious,
    addToQueue,
    moveQueue,
    removeFromQueue,
    setVolume,
    toggleMute,
    toggleShuffle,
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

  const heroTitle = selectedArtistId
    ? visibleAlbums[0]?.artist ?? "Selected Artist"
    : "All Albums";
  return (
    <div className="app-shell">
      <Sidebar
        artists={artists}
        selectedArtistId={selectedArtistId}
        selectedAlbumId={selectedAlbumId}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        musicFolders={settings.musicFolders}
        onSelectArtist={setSelectedArtistId}
        onSelectAlbum={setSelectedAlbumId}
        onSearchChange={setSearchQuery}
        onAddFolders={() => void addFolders()}
        onRefreshLibrary={() => void refreshLibrary()}
      />

      <main className="content">
        <header className="hero panel">
          <div>
            <p className="eyebrow">Darktone Player</p>
            <h1>{heroTitle}</h1>
          </div>
          <div className="hero__status">
            <span>{syncMessage}</span>
            {loading ? <span className="status-dot" /> : null}
          </div>
        </header>

        {error ? <div className="error-banner panel">{error}</div> : null}

        {!settings.musicFolders.length ? (
          <EmptyState
            title="Start with a music folder"
            body="Add one or more folders and Darktone will scan MP3 and WAV files into a persistent local library."
            action={
              <button className="button button--primary" onClick={() => void addFolders()}>
                Add Music Folder
              </button>
            }
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
              album={selectedAlbum}
              track={currentTrack}
              playback={playback}
              queueCount={queue.length}
              onTogglePlay={() => void togglePlay()}
              onPrevious={() => void playPrevious()}
              onNext={() => void playNext()}
              onPlayAlbum={playAlbum}
              onPlayTrack={(track, album) => void playTrack(track, album.tracks)}
              onQueueTrack={addToQueue}
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
        onToggleShuffle={toggleShuffle}
      />
    </div>
  );
}
