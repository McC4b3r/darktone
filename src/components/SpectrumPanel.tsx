import { useEffect, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { formatTime } from "../lib/library";
import { createSpectrumAnalyzer } from "../lib/analyzerPresets";
import { usePlaybackProgress } from "../lib/playbackProgress";

export function SpectrumPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const analyzerRef = useRef<AudioMotionAnalyzer | null>(null);
  const playbackProgress = usePlaybackProgress();

  useEffect(() => {
    if (!containerRef.current || analyzerRef.current) return;

    const analyzer = createSpectrumAnalyzer(containerRef.current);
    analyzerRef.current = analyzer;

    return () => {
      analyzer.destroy();
      analyzerRef.current = null;
    };
  }, []);

  return (
    <div className="library-stage__meter panel">
      <div className="library-stage__meter-head">
        <span className="library-stage__meter-time">
          {formatTime(playbackProgress.currentTime)} / {formatTime(playbackProgress.duration)}
        </span>
      </div>
      <div ref={containerRef} className="library-stage__spectrum-canvas" />
    </div>
  );
}
