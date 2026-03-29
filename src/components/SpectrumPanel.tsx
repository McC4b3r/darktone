import { useEffect, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { formatTime } from "../lib/library";
import { audioEngine } from "../lib/audio";
import type { PlaybackState } from "../lib/types";

interface SpectrumPanelProps {
  playback: PlaybackState;
}

export function SpectrumPanel({ playback }: SpectrumPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const analyzerRef = useRef<AudioMotionAnalyzer | null>(null);

  useEffect(() => {
    if (!containerRef.current || analyzerRef.current) return;

    const analyzer = new AudioMotionAnalyzer(containerRef.current, {
      audioCtx: audioEngine.getAudioContext(),
      source: audioEngine.getAnalyzerInputNode(),
      connectSpeakers: false,
      height: 136,
      mode: 2,
      barSpace: 0.18,
      roundBars: false,
      showScaleX: false,
      showPeaks: false,
      overlay: false,
      reflexRatio: 0,
      mirror: -1,
      smoothing: 0.72,
      minFreq: 20,
      maxFreq: 22000,
      minDecibels: -85,
      maxDecibels: -16,
      gradient: "classic",
      alphaBars: false,
      lumiBars: false,
      fillAlpha: 1,
      lineWidth: 1,
      showBgColor: false,
      bgAlpha: 0,
    });

    analyzer.registerGradient("darktone-crimson", {
      bgColor: "transparent",
      colorStops: [
        { color: "#3768b8", pos: 0 },
        { color: "#9d3150", pos: 0.22 },
        { color: "#ff2331", pos: 0.7 },
        { color: "#ccbb29", pos: 1 },
      ],
    });
    analyzer.setOptions({ gradient: "darktone-crimson" });
    analyzer.canvas.style.background = "transparent";
    analyzer.canvas.parentElement?.style.setProperty("background", "transparent");
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
          {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
        </span>
      </div>
      <div ref={containerRef} className="library-stage__spectrum-canvas" />
    </div>
  );
}
