import type { CSSProperties } from "react";
import { formatTime } from "../lib/library";
import type { PlaybackState } from "../lib/types";

interface TransportBarProps {
  playback: PlaybackState;
  onSeek: (seconds: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
}

export function TransportBar({
  playback,
  onSeek,
  onVolumeChange,
  onToggleMute,
}: TransportBarProps) {
  const timelineMax = Math.max(playback.duration, 1);
  const timelineValue = Math.min(playback.currentTime, playback.duration || 0);
  const timelinePercent = Math.min(100, (timelineValue / timelineMax) * 100);
  const volumePercent = Math.min(100, Math.max(0, playback.volume * 100));
  const remaining = Math.max(playback.duration - playback.currentTime, 0);

  return (
    <footer className="transport panel">
      <div className="transport__controls">
        <div className="transport__timeline">
          <span className="transport__time transport__time--elapsed">{formatTime(playback.currentTime)}</span>
          <input
            className="range range--timeline"
            type="range"
            min={0}
            max={timelineMax}
            step={1}
            value={timelineValue}
            style={
              {
                "--range-progress": `${timelinePercent}%`,
              } as CSSProperties
            }
            onChange={(event) => onSeek(Number(event.target.value))}
          />
          <span className="transport__time transport__time--remaining">-{formatTime(remaining)}</span>
        </div>
      </div>

      <div className="transport__volume">
        <button className="icon-button" onClick={onToggleMute}>
          {playback.muted ? "Muted" : "Volume"}
        </button>
        <input
          className="range range--volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={playback.volume}
          style={
            {
              "--range-progress": `${volumePercent}%`,
            } as CSSProperties
          }
          onChange={(event) => onVolumeChange(Number(event.target.value))}
        />
      </div>
    </footer>
  );
}
