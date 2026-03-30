import { convertFileSrc } from "@tauri-apps/api/core";
import { readAudioFile } from "./tauri";
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
  private loadedTrackId: string | null = null;
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
      const message = this.describeMediaError();
      this.callbacks.onError?.(message);
    });
  }

  setCallbacks(callbacks: AudioCallbacks) {
    this.callbacks = callbacks;
  }

  getMediaElement() {
    return this.audio;
  }

  hasSource() {
    return Boolean(this.audio.currentSrc || this.audio.src);
  }

  private async waitForMetadata() {
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const handleLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(this.audio.error?.message || "Audio metadata failed to load."));
      };
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        this.audio.removeEventListener("error", handleError);
      };

      this.audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
      this.audio.addEventListener("error", handleError, { once: true });
    });
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

  private describeMediaError() {
    const error = this.audio.error;
    if (!error) {
      return "Audio playback failed.";
    }

    const codeLabel =
      error.code === MediaError.MEDIA_ERR_ABORTED
        ? "media load aborted"
        : error.code === MediaError.MEDIA_ERR_NETWORK
          ? "network error while loading media"
          : error.code === MediaError.MEDIA_ERR_DECODE
            ? "media decode error"
            : error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              ? "no supported source was found"
              : "unknown media error";

    return error.message ? `${codeLabel}: ${error.message}` : codeLabel;
  }

  private getMimeType(track: Track) {
    if (track.format === "mp3") return "audio/mpeg";
    if (track.format === "wav") return "audio/wav";
    if (track.format === "flac") return "audio/flac";
    return "application/octet-stream";
  }

  private async waitForLoadResult() {
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const handleLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const handleCanPlay = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(this.describeMediaError()));
      };
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        this.audio.removeEventListener("canplay", handleCanPlay);
        this.audio.removeEventListener("error", handleError);
      };

      this.audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
      this.audio.addEventListener("canplay", handleCanPlay, { once: true });
      this.audio.addEventListener("error", handleError, { once: true });
    });
  }

  private async assignSource(src: string) {
    this.audio.pause();
    this.audio.src = src;
    this.audio.load();
    await this.waitForLoadResult();
  }

  private async assignBlobSource(track: Track) {
    const bytes = await readAudioFile(track.path);
    const blob = new Blob([new Uint8Array(bytes)], { type: this.getMimeType(track) });
    this.objectUrl = URL.createObjectURL(blob);
    await this.assignSource(this.objectUrl);
  }

  async load(track: Track, autoPlay = true) {
    this.revokeObjectUrl();
    this.loadedTrackId = track.id;

    try {
      await this.assignBlobSource(track);
    } catch (error) {
      const blobSourceError = error instanceof Error ? error : new Error("Blob playback failed.");
      try {
        await this.assignSource(convertFileSrc(track.path));
      } catch (directError) {
        const directMessage = directError instanceof Error ? directError.message : "Direct file playback failed.";
        throw new Error(`${blobSourceError.message}; fallback also failed: ${directMessage}`);
      }
    }

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

  async resume(track: Track, currentTime = 0) {
    const shouldReload =
      this.loadedTrackId !== track.id || !this.hasSource() || this.audio.readyState === HTMLMediaElement.HAVE_NOTHING;

    if (shouldReload) {
      await this.load(track, false);
      await this.waitForMetadata();

      if (currentTime > 0) {
        const maxSeekTime = Number.isFinite(this.audio.duration) ? Math.max(this.audio.duration - 0.25, 0) : currentTime;
        this.audio.currentTime = Math.min(currentTime, maxSeekTime);
      }
    }

    await this.play();
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
    this.loadedTrackId = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

export const audioEngine = new AudioEngine();
