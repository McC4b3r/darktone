import { convertFileSrc } from "@tauri-apps/api/core";
import { decodeAudioForPlayback, readAudioFile } from "./tauri";
import type { Track } from "./types";

type AudioCallbacks = {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
};

const PLAYBACK_DEBUG_STORAGE_KEY = "darktone:debug-playback";

function isPlaybackDebugEnabled() {
  if (import.meta.env.DEV) {
    return true;
  }

  try {
    return window.localStorage.getItem(PLAYBACK_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function logPlaybackDebug(message: string, details?: Record<string, unknown>) {
  if (!isPlaybackDebugEnabled()) {
    return;
  }

  const payload = details ? { ...details } : undefined;
  console.info(`[playback] ${message}`, payload ?? "");
}

export class AudioEngine {
  private audio: HTMLAudioElement;
  private callbacks: AudioCallbacks = {};
  private objectUrl: string | null = null;
  private loadedTrackId: string | null = null;
  private loadingSource = false;
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
      if (this.loadingSource) {
        return;
      }

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

  private setObjectUrl(blob: Blob) {
    this.revokeObjectUrl();
    this.objectUrl = URL.createObjectURL(blob);
    return this.objectUrl;
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
    logPlaybackDebug("assigning source", {
      src,
      hadObjectUrl: Boolean(this.objectUrl),
      loadedTrackId: this.loadedTrackId,
    });
    this.audio.pause();
    this.audio.src = src;
    this.audio.load();
    await this.waitForLoadResult();
  }

  private async assignBlobSource(track: Track) {
    const bytes = await readAudioFile(track.path);
    const blob = new Blob([new Uint8Array(bytes)], { type: this.getMimeType(track) });
    await this.assignSource(this.setObjectUrl(blob));
  }

  private async assignDecodedSource(track: Track) {
    const bytes = await decodeAudioForPlayback(track.path);
    const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
    await this.assignSource(this.setObjectUrl(blob));
  }

  private shouldUseDecodedFallback(error: Error) {
    const message = error.message.toLowerCase();
    return message.includes("no supported source was found") || message.includes("demuxer_error_could_not_open");
  }

  private async loadDirectSource(track: Track) {
    const startedAt = performance.now();
    await this.assignSource(convertFileSrc(track.path));
    logPlaybackDebug("loaded direct source", {
      trackId: track.id,
      format: track.format,
      path: track.path,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }

  private async loadBlobFallback(track: Track) {
    const startedAt = performance.now();
    await this.assignBlobSource(track);
    logPlaybackDebug("loaded blob fallback", {
      trackId: track.id,
      format: track.format,
      path: track.path,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }

  private async loadDecodedFallback(track: Track) {
    const startedAt = performance.now();
    await this.assignDecodedSource(track);
    logPlaybackDebug("loaded decoded wav fallback", {
      trackId: track.id,
      format: track.format,
      path: track.path,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }

  async load(track: Track, autoPlay = true) {
    const startedAt = performance.now();
    this.revokeObjectUrl();
    this.loadedTrackId = track.id;
    this.loadingSource = true;

    try {
      try {
        await this.loadDirectSource(track);
      } catch (directError) {
        const directSourceError = directError instanceof Error ? directError : new Error("Direct file playback failed.");
        logPlaybackDebug("direct source failed", {
          trackId: track.id,
          format: track.format,
          path: track.path,
          error: directSourceError.message,
        });

        const shouldTryDecodedFirst = track.format === "flac" && this.shouldUseDecodedFallback(directSourceError);

        if (shouldTryDecodedFirst) {
          try {
            await this.loadDecodedFallback(track);
          } catch (decodedError) {
            const decodedSourceError = decodedError instanceof Error ? decodedError : new Error("Decoded playback failed.");
            logPlaybackDebug("decoded fallback failed", {
              trackId: track.id,
              format: track.format,
              path: track.path,
              error: decodedSourceError.message,
            });

            try {
              await this.loadBlobFallback(track);
            } catch (blobError) {
              const blobSourceError = blobError instanceof Error ? blobError : new Error("Blob playback failed.");
              throw new Error(
                `${directSourceError.message}; decoded fallback failed: ${decodedSourceError.message}; blob fallback failed: ${blobSourceError.message}`,
              );
            }
          }
        } else {
          try {
            await this.loadBlobFallback(track);
          } catch (blobError) {
            const blobSourceError = blobError instanceof Error ? blobError : new Error("Blob playback failed.");
            const shouldTryDecodedAfterBlob =
              track.format !== "wav" ||
              this.shouldUseDecodedFallback(directSourceError) ||
              this.shouldUseDecodedFallback(blobSourceError);

            if (shouldTryDecodedAfterBlob) {
              try {
                await this.loadDecodedFallback(track);
              } catch (decodedError) {
                const decodedSourceError = decodedError instanceof Error ? decodedError : new Error("Decoded playback failed.");
                throw new Error(
                  `${directSourceError.message}; blob fallback failed: ${blobSourceError.message}; decoded fallback failed: ${decodedSourceError.message}`,
                );
              }
            } else {
              throw new Error(`${directSourceError.message}; blob fallback failed: ${blobSourceError.message}`);
            }
          }
        }
      }

      logPlaybackDebug("load completed", {
        trackId: track.id,
        format: track.format,
        path: track.path,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      if (this.getAudioContext().state === "suspended") {
        await this.audioContext?.resume();
      }
      if (autoPlay) {
        await this.audio.play();
      }
    } finally {
      this.loadingSource = false;
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
    logPlaybackDebug("resetting audio engine", {
      loadedTrackId: this.loadedTrackId,
      currentSrc: this.audio.currentSrc || this.audio.src || null,
      hadObjectUrl: Boolean(this.objectUrl),
    });
    this.revokeObjectUrl();
    this.loadedTrackId = null;
    this.loadingSource = false;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

export const audioEngine = new AudioEngine();
