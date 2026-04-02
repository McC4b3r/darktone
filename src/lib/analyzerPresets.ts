import AudioMotionAnalyzer from "audiomotion-analyzer";
import { audioEngine } from "./audio";

export const NOW_PLAYING_ANALYZER_OPTIONS = Object.freeze({
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
} as const);

export const SPECTRUM_ANALYZER_OPTIONS = Object.freeze({
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
  frequencyScale: "log",
} as const);

export function createNowPlayingAnalyzer(container: HTMLDivElement) {
  const analyzer = new AudioMotionAnalyzer(container, {
    audioCtx: audioEngine.getAudioContext(),
    source: audioEngine.getAnalyzerInputNode(),
    ...NOW_PLAYING_ANALYZER_OPTIONS,
  });

  setTransparentAnalyzerCanvas(analyzer);
  return analyzer;
}

export function createSpectrumAnalyzer(container: HTMLDivElement) {
  const analyzer = new AudioMotionAnalyzer(container, {
    audioCtx: audioEngine.getAudioContext(),
    source: audioEngine.getAnalyzerInputNode(),
    ...SPECTRUM_ANALYZER_OPTIONS,
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
  setTransparentAnalyzerCanvas(analyzer);
  return analyzer;
}

function setTransparentAnalyzerCanvas(analyzer: AudioMotionAnalyzer) {
  analyzer.canvas.style.background = "transparent";
  analyzer.canvas.parentElement?.style.setProperty("background", "transparent");
}
