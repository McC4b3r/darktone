import { readFile } from "@tauri-apps/plugin-fs";
import type { Track } from "./types";

type AudioCallbacks = {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
};

export class AudioEngine {
  private audio: HTMLAudioElement;
  private callbacks: AudioCallbacks = {};
  private objectUrl: string | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private outputNode: GainNode | null = null;

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

  getMediaElement() {
    return this.audio;
  }

  getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  getSourceNode() {
    if (!this.sourceNode) {
      const audioContext = this.getAudioContext();
      this.sourceNode = audioContext.createMediaElementSource(this.audio);
      this.outputNode = audioContext.createGain();
      this.sourceNode.connect(this.outputNode);
      this.outputNode.connect(audioContext.destination);
    }
    return this.sourceNode;
  }

  getAnalyzerInputNode() {
    this.getSourceNode();
    if (!this.outputNode) {
      throw new Error("Audio output node is not initialized.");
    }
    return this.outputNode;
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
    if (track.format === "flac") return "audio/flac";
    return "application/octet-stream";
  }

  async load(track: Track, autoPlay = true) {
    this.revokeObjectUrl();
    const bytes = await readFile(track.path);
    const blob = new Blob([bytes], { type: this.getMimeType(track) });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    this.audio.load();
    if (this.getAudioContext().state === "suspended") {
      await this.audioContext?.resume();
    }
    if (autoPlay) {
      await this.audio.play();
    }
  }

  async play() {
    if (this.getAudioContext().state === "suspended") {
      await this.audioContext?.resume();
    }
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
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
    this.revokeObjectUrl();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

export const audioEngine = new AudioEngine();
