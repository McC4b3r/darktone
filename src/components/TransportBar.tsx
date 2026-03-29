import { formatTime } from "../lib/library";
import type { PlaybackState } from "../lib/types";

interface TransportBarProps {
  playback: PlaybackState;
  onSeek: (seconds: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onToggleShuffle: () => void;
}

export function TransportBar({
  playback,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onToggleShuffle,
}: TransportBarProps) {
  return (
    <footer className="transport panel">
      <div className="transport__controls">
        <div className="transport__timeline">
          <span>{formatTime(playback.currentTime)}</span>
          <input
            className="range"
            type="range"
            min={0}
            max={Math.max(playback.duration, 1)}
            step={1}
            value={Math.min(playback.currentTime, playback.duration || 0)}
            onChange={(event) => onSeek(Number(event.target.value))}
          />
          <span>{formatTime(playback.duration)}</span>
        </div>
      </div>

      <div className="transport__volume">
        <button className="icon-button" onClick={onToggleShuffle} data-active={playback.shuffle}>
          Mix
        </button>
        <button className="icon-button" onClick={onToggleMute}>
          {playback.muted ? "Muted" : "Volume"}
        </button>
        <input
          className="range"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={playback.volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
        />
      </div>
    </footer>
  );
}
