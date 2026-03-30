import { AlbumPanel } from "./AlbumPanel";
import { NowPlayingPanel } from "./NowPlayingPanel";
import { SpectrumPanel } from "./SpectrumPanel";
import type { Album, ArtistGroup, PlaybackState, Track } from "../lib/types";

interface LibraryStageProps {
  artist: ArtistGroup | null;
  album: Album | null;
  nowPlayingAlbum: Album | null;
  track: Track | null;
  playback: PlaybackState;
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
  playback,
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
          playback={playback}
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
        <SpectrumPanel playback={playback} />
      </div>
    </section>
  );
}
