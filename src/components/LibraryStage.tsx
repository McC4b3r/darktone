import { AlbumPanel } from "./AlbumPanel";
import { NowPlayingPanel } from "./NowPlayingPanel";
import { SpectrumPanel } from "./SpectrumPanel";
import type { Album, PlaybackState, Track } from "../lib/types";

interface LibraryStageProps {
  album: Album | null;
  track: Track | null;
  playback: PlaybackState;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelectTrack: (track: Track, albumTracks: Track[]) => void;
}

export function LibraryStage({
  album,
  track,
  playback,
  onTogglePlay,
  onPrevious,
  onNext,
  onSelectTrack,
}: LibraryStageProps) {
  if (!album) {
    return null;
  }

  return (
    <section className="library-stage panel">
      <div className="library-stage__shell">
        <NowPlayingPanel
          album={album}
          track={track}
          playback={playback}
          onTogglePlay={onTogglePlay}
          onPrevious={onPrevious}
          onNext={onNext}
        />
        <AlbumPanel album={album} currentTrackId={track?.id ?? null} onSelectTrack={onSelectTrack} />
        <SpectrumPanel playback={playback} />
      </div>
    </section>
  );
}
