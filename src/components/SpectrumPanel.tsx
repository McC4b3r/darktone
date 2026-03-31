import { useEffect, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { formatTime } from "../lib/library";
import { audioEngine } from "../lib/audio";
import { usePlaybackProgress } from "../lib/playbackProgress";

export function SpectrumPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const analyzerRef = useRef<AudioMotionAnalyzer | null>(null);
  const playbackProgress = usePlaybackProgress();

  useEffect(() => {
    if (!containerRef.current || analyzerRef.current) return;

    const analyzer = new AudioMotionAnalyzer(containerRef.current, {
      audioCtx: audioEngine.getAudioContext(),
      source: audioEngine.getAnalyzerInputNode(),
      connectSpeakers: false,
      height: 136,
      mode: 1,
      barSpace: 0.5,
      roundBars: true,
      showScaleX: false,
      showPeaks: false,
      overlay: true,
      reflexRatio: 0,
      mirror: -1,
      smoothing: 0.72,
      minFreq: 20,
      maxFreq: 22000,
      minDecibels: -98,
      maxDecibels: -16,
      gradient: "classic",
      alphaBars: false,
      lumiBars: false,
      fillAlpha: 1,
      lineWidth: 1,
      showBgColor: false,
      bgAlpha: 0,
      frequencyScale: "log"
    });

    analyzer.registerGradient("darktone-crimson", {
      bgColor: "transparent",
      colorStops: [
        { color: "#6038cc", pos: 0 },
        { color: "#cb4067", pos: 0.22 },
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
          {formatTime(playbackProgress.currentTime)} / {formatTime(playbackProgress.duration)}
        </span>
      </div>
      <div ref={containerRef} className="library-stage__spectrum-canvas" />
    </div>
  );
}
