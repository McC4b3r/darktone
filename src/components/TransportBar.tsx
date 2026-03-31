import type { CSSProperties } from "react";
import { formatTime } from "../lib/library";
import { usePlaybackProgress } from "../lib/playbackProgress";

interface TransportBarProps {
  volume: number;
  muted: boolean;
  onSeek: (seconds: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
}

export function TransportBar({
  volume,
  muted,
  onSeek,
  onVolumeChange,
  onToggleMute,
}: TransportBarProps) {
  const playbackProgress = usePlaybackProgress();
  const timelineMax = Math.max(playbackProgress.duration, 1);
  const timelineValue = Math.min(playbackProgress.currentTime, playbackProgress.duration || 0);
  const timelinePercent = Math.min(100, (timelineValue / timelineMax) * 100);
  const volumePercent = Math.min(100, Math.max(0, volume * 100));
  const remaining = Math.max(playbackProgress.duration - playbackProgress.currentTime, 0);

  return (
    <footer className="transport panel">
      <div className="transport__controls">
        <div className="transport__timeline">
          <span className="transport__time transport__time--elapsed">{formatTime(playbackProgress.currentTime)}</span>
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
          {muted ? "Muted" : "Volume"}
        </button>
        <input
          className="range range--volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
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
