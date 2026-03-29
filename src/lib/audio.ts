import { readFile } from "@tauri-apps/plugin-fs";
import type { Track } from "./types";

type AudioCallbacks = {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
  onSpectrumUpdate?: (spectrum: number[]) => void;
};

export class AudioEngine {
  private audio: HTMLAudioElement;
  private callbacks: AudioCallbacks = {};
  private objectUrl: string | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private spectrumFrame: number | null = null;
  private readonly spectrumBins = 160;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "metadata";

    this.audio.addEventListener("timeupdate", () => {
      this.callbacks.onTimeUpdate?.(this.audio.currentTime, this.audio.duration || 0);
    });

    this.audio.addEventListener("loadedmetadata", () => {
      this.callbacks.onTimeUpdate?.(this.audio.currentTime, this.audio.duration || 0);
    });

    this.audio.addEventListener("ended", () => {
      this.callbacks.onEnded?.();
    });

    this.audio.addEventListener("play", () => {
      this.callbacks.onPlayStateChange?.(true);
    });

    this.audio.addEventListener("pause", () => {
      this.callbacks.onPlayStateChange?.(false);
    });

    this.audio.addEventListener("error", () => {
      const message = this.audio.error?.message || "Audio playback failed.";
      this.callbacks.onError?.(message);
    });
  }

  setCallbacks(callbacks: AudioCallbacks) {
    this.callbacks = callbacks;
  }

  private revokeObjectUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private getMimeType(track: Track) {
    if (track.format === "mp3") return "audio/mpeg";
    if (track.format === "wav") return "audio/wav";
    return "application/octet-stream";
  }

  private ensureAnalyser() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    if (!this.sourceNode) {
      this.sourceNode = this.audioContext.createMediaElementSource(this.audio);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 4096;
      this.analyserNode.smoothingTimeConstant = 0.68;
      this.analyserNode.minDecibels = -92;
      this.analyserNode.maxDecibels = -16;
      this.sourceNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);
    }
  }

  private emitSpectrum() {
    if (!this.analyserNode) return;

    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);

    const spectrum = Array.from({ length: this.spectrumBins }, (_, index) => {
      const start = Math.floor((index / this.spectrumBins) ** 1.9 * data.length);
      const end = Math.max(
        start + 1,
        Math.floor(((index + 1) / this.spectrumBins) ** 1.9 * data.length),
      );
      let total = 0;
      let peak = 0;

      for (let cursor = start; cursor < end; cursor += 1) {
        total += data[cursor];
        peak = Math.max(peak, data[cursor]);
      }

      const average = end > start ? total / (end - start) : 0;
      return Math.max(0.02, (average * 0.72 + peak * 0.28) / 255);
    });

    this.callbacks.onSpectrumUpdate?.(spectrum);
  }

  private startSpectrumLoop() {
    if (this.spectrumFrame !== null) return;

    const tick = () => {
      this.emitSpectrum();
      if (!this.audio.paused) {
        this.spectrumFrame = window.requestAnimationFrame(tick);
      } else {
        this.spectrumFrame = null;
      }
    };

    this.spectrumFrame = window.requestAnimationFrame(tick);
  }

  private stopSpectrumLoop() {
    if (this.spectrumFrame !== null) {
      window.cancelAnimationFrame(this.spectrumFrame);
      this.spectrumFrame = null;
    }
  }

  async load(track: Track, autoPlay = true) {
    this.revokeObjectUrl();
    const bytes = await readFile(track.path);
    const blob = new Blob([bytes], { type: this.getMimeType(track) });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    this.audio.load();
    this.ensureAnalyser();
    if (this.audioContext?.state === "suspended") {
      await this.audioContext.resume();
    }
    if (autoPlay) {
      await this.audio.play();
      this.startSpectrumLoop();
    }
  }

  async play() {
    this.ensureAnalyser();
    if (this.audioContext?.state === "suspended") {
      await this.audioContext.resume();
    }
    await this.audio.play();
    this.startSpectrumLoop();
  }

  pause() {
    this.audio.pause();
    this.stopSpectrumLoop();
  }

  toggle() {
    if (this.audio.paused) {
      return this.play();
    }
    this.pause();
    return Promise.resolve();
  }

  seek(seconds: number) {
    this.audio.currentTime = seconds;
  }

  setVolume(volume: number) {
    this.audio.volume = volume;
  }

  setMuted(muted: boolean) {
    this.audio.muted = muted;
  }

  reset() {
    this.stopSpectrumLoop();
    this.callbacks.onSpectrumUpdate?.(Array.from({ length: this.spectrumBins }, () => 0));
    this.revokeObjectUrl();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

export const audioEngine = new AudioEngine();
