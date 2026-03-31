import { AlbumPanel } from "./AlbumPanel";
import { NowPlayingPanel } from "./NowPlayingPanel";
import { SpectrumPanel } from "./SpectrumPanel";
import type { Album, ArtistGroup, Track } from "../lib/types";

interface LibraryStageProps {
  artist: ArtistGroup | null;
  album: Album | null;
  nowPlayingAlbum: Album | null;
  track: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelectAlbum: (albumId: string | null) => void;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
}

export function LibraryStage({
  artist,
  album,
  nowPlayingAlbum,
  track,
  isPlaying,
  onTogglePlay,
  onPrevious,
  onNext,
  onSelectAlbum,
  onSelectTrack,
}: LibraryStageProps) {
  const heroAlbum = nowPlayingAlbum ?? album ?? artist?.albums[0] ?? null;

  if ((!artist && !album) || !heroAlbum) {
    return null;
  }

  return (
    <section className="library-stage panel">
      <div className="library-stage__shell">
        <NowPlayingPanel
          album={heroAlbum}
          track={track}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
          onPrevious={onPrevious}
          onNext={onNext}
        />
        <AlbumPanel
          artist={artist}
          album={album}
          currentTrackId={track?.id ?? null}
          onSelectAlbum={onSelectAlbum}
          onSelectTrack={onSelectTrack}
        />
        <SpectrumPanel />
      </div>
    </section>
  );
}
