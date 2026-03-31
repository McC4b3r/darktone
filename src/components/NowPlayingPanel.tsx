import { useEffect, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { audioEngine } from "../lib/audio";
import { formatTime } from "../lib/library";
import { usePlaybackProgress } from "../lib/playbackProgress";
import type { Album, Track } from "../lib/types";

interface NowPlayingPanelProps {
  album: Album;
  track: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function NowPlayingPanel({
  album,
  track,
  isPlaying,
  onTogglePlay,
  onPrevious,
  onNext,
}: NowPlayingPanelProps) {
  const visualRef = useRef<HTMLDivElement>(null);
  const analyzerRef = useRef<AudioMotionAnalyzer | null>(null);
  const playbackProgress = usePlaybackProgress();
  const remaining = Math.max(playbackProgress.duration - playbackProgress.currentTime, 0);

  useEffect(() => {
    if (!visualRef.current || analyzerRef.current) return;

    const analyzer = new AudioMotionAnalyzer(visualRef.current, {
      audioCtx: audioEngine.getAudioContext(),
      source: audioEngine.getAnalyzerInputNode(),
      connectSpeakers: false,
      height: 168,
      fftSize: 8192,
      mode: 10,
      colorMode: "bar-level",
      lineWidth: 2,
      fillAlpha: 0.2,
      overlay: true,
      bgAlpha: 0.7,
      reflexFit: true,
      showScaleX: false,
      showScaleY: false,
      showPeaks: true,
      peakLine: false,
      fadePeaks: false,
      gravity: 3.8,
      peakFadeTime: 750,
      peakHoldTime: 500,
      reflexRatio: 0.4,
      reflexAlpha: 1,
      reflexBright: 1,
      mirror: -1,
      smoothing: 0.7,
      minFreq: 20,
      maxFreq: 8000,
      minDecibels: -85,
      maxDecibels: -25,
      gradient: "rainbow",
      frequencyScale: "log",
      weightingFilter: "D",
      linearAmplitude: true,
      linearBoost: 1.6,
      maxFPS: 0,
    });
    analyzer.canvas.style.background = "transparent";
    analyzer.canvas.parentElement?.style.setProperty("background", "transparent");
    analyzerRef.current = analyzer;

    return () => {
      analyzer.destroy();
      analyzerRef.current = null;
    };
  }, []);

  return (
    <div className="library-stage__hero">
      <div className="library-stage__details panel">
        <div className="library-stage__visual" aria-hidden="true">
          <div ref={visualRef} className="library-stage__visual-canvas" />
        </div>
        <div className="library-stage__visual-veil" aria-hidden="true" />
        <div className="library-stage__overlay">
          <p className="eyebrow">Now Playing</p>
          <h2 className="library-stage__hero-title" title={track?.title ?? album.title}>
            {track?.title ?? album.title}
          </h2>
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
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            <span
              className={`transport-glyph ${isPlaying ? "transport-glyph--pause" : "transport-glyph--play"}`}
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
