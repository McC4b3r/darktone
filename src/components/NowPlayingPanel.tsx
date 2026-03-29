import { formatTime } from "../lib/library";
import type { Album, PlaybackState, Track } from "../lib/types";

interface NowPlayingPanelProps {
  album: Album;
  track: Track | null;
  playback: PlaybackState;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function NowPlayingPanel({
  album,
  track,
  playback,
  onTogglePlay,
  onPrevious,
  onNext,
}: NowPlayingPanelProps) {
  const remaining = Math.max(playback.duration - playback.currentTime, 0);

  return (
    <div className="library-stage__hero">
      <div className="library-stage__details panel">
        <div className="library-stage__overlay">
          <p className="eyebrow">Now Playing</p>
          <h2>{track?.title ?? album.title}</h2>
          <p className="library-stage__meta">{track?.artist ?? album.artist}</p>
          <p className="library-stage__submeta">
            {album.title} • {track?.format.toUpperCase() ?? "LOCAL"} • {formatTime(remaining)} left
          </p>
        </div>

        <div className="library-stage__transport">
          <button className="icon-button icon-button--transport" onClick={onPrevious} aria-label="Previous">
            <span className="transport-glyph transport-glyph--skip-back" aria-hidden="true" />
          </button>
          <button
            className="button button--primary library-stage__play-toggle"
            onClick={onTogglePlay}
            aria-label={playback.isPlaying ? "Pause" : "Play"}
          >
            <span
              className={`transport-glyph ${playback.isPlaying ? "transport-glyph--pause" : "transport-glyph--play"}`}
              aria-hidden="true"
            />
          </button>
          <button className="icon-button icon-button--transport" onClick={onNext} aria-label="Next">
            <span className="transport-glyph transport-glyph--skip-next" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
