import { convertFileSrc } from "@tauri-apps/api/core";
import { prepareDecodedAudioForPlayback } from "./tauri";
import type { Track } from "./types";

export type AudioCallbacks = {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
};

const PLAYBACK_DEBUG_STORAGE_KEY = "darktone:debug-playback";
const PLAYBACK_FILE_PROTOCOL = "playback";

export type PlaybackSourceStrategy = "decoded-wav" | "direct-file" | "native-file";

type PlaybackEnvironment = {
  isDev: boolean;
  isWindows: boolean;
};

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

function detectPlaybackEnvironment(): PlaybackEnvironment {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

  return {
    isDev: Boolean(import.meta.env.DEV),
    isWindows: /windows/i.test(userAgent),
  };
}

export function getTrackLoadStrategyOrder(
  _track: Track,
  environment: PlaybackEnvironment = detectPlaybackEnvironment(),
): PlaybackSourceStrategy[] {
  if (!environment.isDev && environment.isWindows) {
    return ["native-file", "direct-file", "decoded-wav"];
  }

  return ["direct-file", "native-file", "decoded-wav"];
}

export class AudioEngine {
  private audio: HTMLAudioElement;
  private callbacks: AudioCallbacks = {};
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
      loadedTrackId: this.loadedTrackId,
    });
    this.audio.pause();
    this.audio.src = src;
    this.audio.load();
    await this.waitForLoadResult();
  }

  private async assignNativeFileSource(track: Track) {
    await this.assignSource(convertFileSrc(track.path, PLAYBACK_FILE_PROTOCOL));
  }

  private async assignDecodedSource(track: Track) {
    const decodedPath = await prepareDecodedAudioForPlayback(track.path);
    await this.assignSource(convertFileSrc(decodedPath));
  }

  private shouldUseDecodedFallback(error: Error) {
    const message = error.message.toLowerCase();
    return message.includes("no supported source was found") || message.includes("demuxer_error_could_not_open");
  }

  private shouldSkipStrategy(track: Track, strategy: PlaybackSourceStrategy, previousErrors: Error[]) {
    if (strategy !== "decoded-wav") {
      return false;
    }

    const environment = detectPlaybackEnvironment();
    if (!environment.isDev && environment.isWindows) {
      return false;
    }

    if (track.format === "flac") {
      return !previousErrors.some((error) => this.shouldUseDecodedFallback(error));
    }

    if (track.format === "wav") {
      return !previousErrors.some((error) => this.shouldUseDecodedFallback(error));
    }

    return false;
  }

  private async runLoadStrategy(track: Track, strategy: PlaybackSourceStrategy) {
    logPlaybackDebug("loading strategy started", {
      strategy,
      trackId: track.id,
      format: track.format,
      path: track.path,
    });

    if (strategy === "decoded-wav") {
      await this.loadDecodedFallback(track);
      return;
    }

    if (strategy === "native-file") {
      await this.loadNativeFileFallback(track);
      return;
    }

    await this.loadDirectSource(track);
  }

  private buildStrategyFailure(track: Track, attemptedStrategies: PlaybackSourceStrategy[], errors: Error[]) {
    const attemptSummary = attemptedStrategies.join(", ");
    const errorSummary = errors.map((error) => error.message).join("; ");

    return new Error(
      `Playback could not start for "${track.title}" after trying ${attemptSummary}. ${errorSummary}`,
    );
  }

  private async resumeAudioContextIfNeeded() {
    const audioContext = this.getAudioContext();
    const previousState = audioContext.state;

    logPlaybackDebug("checking audio context", {
      beforeState: previousState,
      trackId: this.loadedTrackId,
    });

    if (previousState === "suspended") {
      await audioContext.resume();
    }

    logPlaybackDebug("audio context ready", {
      beforeState: previousState,
      afterState: audioContext.state,
      trackId: this.loadedTrackId,
    });
  }

  private async playMediaElement() {
    logPlaybackDebug("calling audio.play()", {
      trackId: this.loadedTrackId,
      muted: this.audio.muted,
      volume: this.audio.volume,
      currentSrc: this.audio.currentSrc || this.audio.src || null,
    });

    await this.audio.play();

    logPlaybackDebug("audio.play() resolved", {
      trackId: this.loadedTrackId,
      muted: this.audio.muted,
      volume: this.audio.volume,
      currentSrc: this.audio.currentSrc || this.audio.src || null,
      paused: this.audio.paused,
    });
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

  private async loadNativeFileFallback(track: Track) {
    const startedAt = performance.now();
    await this.assignNativeFileSource(track);
    logPlaybackDebug("loaded native-file fallback", {
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
    this.loadedTrackId = track.id;
    this.loadingSource = true;

    try {
      const attemptedStrategies: PlaybackSourceStrategy[] = [];
      const strategyErrors: Error[] = [];

      for (const strategy of getTrackLoadStrategyOrder(track)) {
        if (this.shouldSkipStrategy(track, strategy, strategyErrors)) {
          logPlaybackDebug("loading strategy skipped", {
            strategy,
            trackId: track.id,
            format: track.format,
            path: track.path,
          });
          continue;
        }

        attemptedStrategies.push(strategy);

        try {
          await this.runLoadStrategy(track, strategy);
          logPlaybackDebug("loading strategy selected", {
            strategy,
            trackId: track.id,
            format: track.format,
            path: track.path,
            attempts: attemptedStrategies,
          });
          break;
        } catch (error) {
          const strategyError = error instanceof Error ? error : new Error(`${strategy} playback failed.`);
          strategyErrors.push(strategyError);
          logPlaybackDebug("loading strategy failed", {
            strategy,
            trackId: track.id,
            format: track.format,
            path: track.path,
            error: strategyError.message,
            attempts: attemptedStrategies,
          });
        }
      }

      if (strategyErrors.length === attemptedStrategies.length) {
        throw this.buildStrategyFailure(track, attemptedStrategies, strategyErrors);
      }

      logPlaybackDebug("load completed", {
        trackId: track.id,
        format: track.format,
        path: track.path,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      await this.resumeAudioContextIfNeeded();
      if (autoPlay) {
        await this.playMediaElement();
      }
    } finally {
      this.loadingSource = false;
    }
  }

  async play() {
    await this.resumeAudioContextIfNeeded();
    await this.playMediaElement();
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
    });
    this.loadedTrackId = null;
    this.loadingSource = false;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}

export const audioEngine = new AudioEngine();
