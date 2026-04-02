import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  const [draftSeekSeconds, setDraftSeekSeconds] = useState<number | null>(null);
  const draftSeekSecondsRef = useRef<number | null>(null);
  const timelineMax = Math.max(playbackProgress.duration, 1);
  const displayedCurrentTime =
    draftSeekSeconds === null ? playbackProgress.currentTime : Math.min(draftSeekSeconds, playbackProgress.duration || timelineMax);
  const timelineValue = Math.min(displayedCurrentTime, playbackProgress.duration || 0);
  const timelinePercent = Math.min(100, (timelineValue / timelineMax) * 100);
  const volumePercent = Math.min(100, Math.max(0, volume * 100));
  const remaining = Math.max(playbackProgress.duration - displayedCurrentTime, 0);

  useEffect(() => {
    if (draftSeekSeconds === null) {
      return;
    }

    const clampedDraft = Math.min(draftSeekSeconds, playbackProgress.duration || timelineMax);
    if (clampedDraft !== draftSeekSeconds) {
      draftSeekSecondsRef.current = clampedDraft;
      setDraftSeekSeconds(clampedDraft);
    }
  }, [draftSeekSeconds, playbackProgress.duration, timelineMax]);

  function updateDraftSeek(seconds: number) {
    draftSeekSecondsRef.current = seconds;
    setDraftSeekSeconds(seconds);
  }

  function commitDraftSeek() {
    const nextSeekSeconds = draftSeekSecondsRef.current;
    if (nextSeekSeconds === null) {
      return;
    }

    draftSeekSecondsRef.current = null;
    setDraftSeekSeconds(null);
    onSeek(nextSeekSeconds);
  }

  return (
    <footer className="transport panel">
      <div className="transport__controls">
        <div className="transport__timeline">
          <span className="transport__time transport__time--elapsed">{formatTime(displayedCurrentTime)}</span>
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
            onChange={(event) => updateDraftSeek(Number(event.target.value))}
            onPointerUp={commitDraftSeek}
            onBlur={commitDraftSeek}
            onKeyUp={(event) => {
              if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowRight" ||
                event.key === "ArrowUp" ||
                event.key === "ArrowDown" ||
                event.key === "Home" ||
                event.key === "End" ||
                event.key === "PageUp" ||
                event.key === "PageDown"
              ) {
                commitDraftSeek();
              }
            }}
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
