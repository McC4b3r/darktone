import {
  closePlaybackSession,
  openPlaybackSession,
  readPlaybackFrames,
  seekPlaybackSession,
} from "./tauri";
import type { Track } from "./types";

export type PlaybackStatus = "idle" | "buffering" | "ready" | "playing" | "paused" | "ended" | "error";

export type AudioCallbacks = {
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: PlaybackStatus) => void;
};

type WorkletResetMessage = {
  type: "reset";
  generation: number;
  playedFrames: number;
};

type WorkletAppendMessage = {
  type: "append";
  generation: number;
  frames: number;
  channelCount: number;
  endOfStream: boolean;
  samples: Float32Array;
};

type WorkletMessage = WorkletResetMessage | WorkletAppendMessage;

type WorkletNeedDataMessage = {
  type: "need-data";
  generation: number;
  bufferedFrames: number;
};

type WorkletProgressMessage = {
  type: "progress";
  generation: number;
  playedFrames: number;
  bufferedFrames: number;
};

type WorkletEndedMessage = {
  type: "ended";
  generation: number;
  playedFrames: number;
};

type WorkletEvent = WorkletNeedDataMessage | WorkletProgressMessage | WorkletEndedMessage;

type EngineSession = {
  generation: number;
  sessionId: number;
  trackId: string;
  sampleRate: number;
  channelCount: number;
  duration: number;
  currentTime: number;
  bufferedFrames: number;
  endOfStream: boolean;
  readInFlight: boolean;
  pumpPromise: Promise<void> | null;
};

const PLAYBACK_DEBUG_STORAGE_KEY = "darktone:debug-playback";
const PLAYBACK_WORKLET_PATH = "/audio-worklet.js";
const OUTPUT_CHANNEL_COUNT = 2;
const READ_CHUNK_FRAMES = 16_384;
const STARTUP_BUFFER_FRAMES = 32_768;
const HIGH_WATER_FRAMES = 65_536;

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

function getAudioContextConstructor() {
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function resolvePlaybackWorkletUrl() {
  return new URL(PLAYBACK_WORKLET_PATH, window.location.href).href;
}

export class AudioEngine {
  private callbacks: AudioCallbacks = {};
  private loadedTrackId: string | null = null;
  private audioContext: AudioContext | null = null;
  private analyzerInputNode: GainNode | null = null;
  private masterGainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletSetupPromise: Promise<void> | null = null;
  private activeSession: EngineSession | null = null;
  private generation = 0;
  private volume = 1;
  private muted = false;
  private playState = false;
  private status: PlaybackStatus = "idle";
  private lastReportedTime = {
    currentTime: Number.NaN,
    duration: Number.NaN,
  };

  setCallbacks(callbacks: AudioCallbacks) {
    this.callbacks = callbacks;
  }

  getAudioContext() {
    this.ensureAudioGraphBase();
    return this.audioContext!;
  }

  getAnalyzerInputNode() {
    this.ensureAudioGraphBase();
    return this.analyzerInputNode!;
  }

  private ensureAudioGraphBase() {
    if (this.audioContext && this.analyzerInputNode && this.masterGainNode) {
      return;
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      throw new Error("Web Audio is not available in this environment.");
    }

    if (!this.audioContext) {
      this.audioContext = new AudioContextConstructor({
        latencyHint: "playback",
      });
    }

    if (!this.analyzerInputNode) {
      this.analyzerInputNode = this.audioContext.createGain();
    }

    if (!this.masterGainNode) {
      this.masterGainNode = this.audioContext.createGain();
      this.analyzerInputNode.connect(this.masterGainNode);
      this.masterGainNode.connect(this.audioContext.destination);
    }

    this.applyOutputGain();
  }

  private async ensureWorkletNode() {
    this.ensureAudioGraphBase();
    if (this.workletNode) {
      return this.workletNode;
    }

    if (!this.workletSetupPromise) {
      this.workletSetupPromise = this.createWorkletNode().catch((error) => {
        this.workletSetupPromise = null;
        throw error;
      });
    }

    await this.workletSetupPromise;
    if (!this.workletNode) {
      throw new Error("Playback worklet did not initialize.");
    }
    return this.workletNode;
  }

  private async createWorkletNode() {
    const audioContext = this.getAudioContext();
    const workletUrl = resolvePlaybackWorkletUrl();

    if (!("audioWorklet" in audioContext) || typeof AudioWorkletNode === "undefined") {
      throw new Error("AudioWorklet is not available in this desktop runtime.");
    }

    logPlaybackDebug("loading playback worklet", {
      workletUrl,
    });

    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : `${error}`;

      logPlaybackDebug("playback worklet load failed", {
        workletUrl,
        error: reason,
      });

      throw new Error(`Unable to load the playback worklet from ${workletUrl}. ${reason}`);
    }

    const node = new AudioWorkletNode(audioContext, "darktone-pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [OUTPUT_CHANNEL_COUNT],
    });
    node.port.onmessage = (event: MessageEvent<WorkletEvent>) => {
      this.handleWorkletEvent(event.data);
    };
    node.connect(this.getAnalyzerInputNode());
    this.workletNode = node;
  }

  private handleWorkletEvent(event: WorkletEvent) {
    const session = this.activeSession;
    if (!session || event.generation !== session.generation) {
      return;
    }

    if (event.type === "need-data") {
      session.bufferedFrames = event.bufferedFrames;
      this.pumpSessionInBackground(session);
      return;
    }

    if (event.type === "progress") {
      session.bufferedFrames = event.bufferedFrames;
      session.currentTime = event.playedFrames / session.sampleRate;
      this.emitTimeUpdate(session.currentTime, session.duration);

      if (!session.endOfStream && session.bufferedFrames < HIGH_WATER_FRAMES / 2) {
        this.pumpSessionInBackground(session);
      }
      return;
    }

    session.currentTime = event.playedFrames / session.sampleRate;
    session.bufferedFrames = 0;
    this.emitTimeUpdate(session.duration || session.currentTime, session.duration);
    this.setPlayState(false);
    this.setStatus("ended");
    void this.suspendAudioContext();
    this.callbacks.onEnded?.();
  }

  private postToWorklet(message: WorkletMessage) {
    if (!this.workletNode) {
      return;
    }

    if (message.type === "append") {
      this.workletNode.port.postMessage(message, [message.samples.buffer]);
      return;
    }

    this.workletNode.port.postMessage(message);
  }

  private setStatus(status: PlaybackStatus) {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }

  private setPlayState(isPlaying: boolean) {
    if (this.playState === isPlaying) {
      return;
    }

    this.playState = isPlaying;
    this.callbacks.onPlayStateChange?.(isPlaying);
  }

  private emitTimeUpdate(currentTime: number, duration: number) {
    const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(currentTime, 0) : 0;
    const safeDuration = Number.isFinite(duration) ? Math.max(duration, 0) : 0;

    if (
      this.lastReportedTime.currentTime === safeCurrentTime &&
      this.lastReportedTime.duration === safeDuration
    ) {
      return;
    }

    this.lastReportedTime = {
      currentTime: safeCurrentTime,
      duration: safeDuration,
    };
    this.callbacks.onTimeUpdate?.(safeCurrentTime, safeDuration);
  }

  private applyOutputGain() {
    if (!this.masterGainNode) {
      return;
    }

    this.masterGainNode.gain.value = this.muted ? 0 : this.volume;
  }

  private async resumeAudioContext() {
    const audioContext = this.getAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  private async suspendAudioContext() {
    if (!this.audioContext || this.audioContext.state !== "running") {
      return;
    }

    await this.audioContext.suspend();
  }

  private async teardownSession(nextGeneration: number, resetLoadedTrack: boolean) {
    const previousSession = this.activeSession;
    this.activeSession = null;
    if (resetLoadedTrack) {
      this.loadedTrackId = null;
    }

    this.postToWorklet({
      type: "reset",
      generation: nextGeneration,
      playedFrames: 0,
    });

    if (previousSession) {
      logPlaybackDebug("closing playback session", {
        sessionId: previousSession.sessionId,
        trackId: previousSession.trackId,
      });
      void closePlaybackSession(previousSession.sessionId).catch((error) => {
        console.warn("Could not close playback session.", error);
      });
    }
  }

  private resetWorklet(session: EngineSession, currentTime: number) {
    this.postToWorklet({
      type: "reset",
      generation: session.generation,
      playedFrames: Math.max(0, Math.round(currentTime * session.sampleRate)),
    });
  }

  private async readNextChunk(session: EngineSession) {
    if (session.readInFlight || session.endOfStream) {
      return;
    }

    session.readInFlight = true;

    try {
      const chunk = await readPlaybackFrames(session.sessionId, READ_CHUNK_FRAMES);
      if (!this.isActiveGeneration(session.generation, session.sessionId)) {
        return;
      }

      session.endOfStream = chunk.endOfStream;

      if (chunk.frames > 0) {
        const samples = Float32Array.from(chunk.samples);
        session.bufferedFrames += chunk.frames;
        this.postToWorklet({
          type: "append",
          generation: session.generation,
          frames: chunk.frames,
          channelCount: chunk.channelCount,
          endOfStream: chunk.endOfStream,
          samples,
        });
      } else if (chunk.endOfStream) {
        this.postToWorklet({
          type: "append",
          generation: session.generation,
          frames: 0,
          channelCount: session.channelCount,
          endOfStream: true,
          samples: new Float32Array(),
        });
      }
    } finally {
      session.readInFlight = false;
    }
  }

  private async fillBuffer(session: EngineSession, targetFrames: number) {
    while (this.isActiveGeneration(session.generation, session.sessionId)) {
      if (session.bufferedFrames >= targetFrames || session.endOfStream) {
        return;
      }

      const bufferedBeforeRead = session.bufferedFrames;
      await this.readNextChunk(session);
      if (session.bufferedFrames === bufferedBeforeRead && session.endOfStream) {
        return;
      }
    }
  }

  private async pumpSession(session: EngineSession) {
    if (session.pumpPromise) {
      return session.pumpPromise;
    }

    session.pumpPromise = (async () => {
      while (this.isActiveGeneration(session.generation, session.sessionId)) {
        if (session.endOfStream || session.bufferedFrames >= HIGH_WATER_FRAMES) {
          return;
        }

        const bufferedBeforeRead = session.bufferedFrames;
        await this.readNextChunk(session);
        if (session.bufferedFrames === bufferedBeforeRead) {
          return;
        }
      }
    })().finally(() => {
      if (this.isActiveGeneration(session.generation, session.sessionId)) {
        session.pumpPromise = null;
      }
    });

    return session.pumpPromise;
  }

  private pumpSessionInBackground(session: EngineSession) {
    void this.pumpSession(session).catch((error) => {
      if (!this.isActiveGeneration(session.generation, session.sessionId)) {
        return;
      }

      const message = error instanceof Error ? error.message : "Playback buffering failed.";
      this.notifyPlaybackError(message);
    });
  }

  private isActiveGeneration(generation: number, sessionId?: number) {
    return Boolean(
      this.activeSession &&
        this.activeSession.generation === generation &&
        (sessionId === undefined || this.activeSession.sessionId === sessionId),
    );
  }

  private async loadInternal(track: Track, autoPlay: boolean, startTime = 0) {
    const workletNode = await this.ensureWorkletNode();
    const audioContext = this.getAudioContext();
    const generation = this.generation + 1;
    this.generation = generation;
    this.loadedTrackId = track.id;
    this.setPlayState(false);
    this.setStatus("buffering");
    this.emitTimeUpdate(startTime, track.durationMs / 1000);

    await this.teardownSession(generation, false);

    const metadata = await openPlaybackSession(track.path, audioContext.sampleRate, OUTPUT_CHANNEL_COUNT);
    if (generation !== this.generation) {
      void closePlaybackSession(metadata.sessionId);
      return;
    }

    const session: EngineSession = {
      generation,
      sessionId: metadata.sessionId,
      trackId: track.id,
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
      duration: metadata.durationSeconds || track.durationMs / 1000,
      currentTime: metadata.currentTimeSeconds,
      bufferedFrames: 0,
      endOfStream: false,
      readInFlight: false,
      pumpPromise: null,
    };
    this.activeSession = session;

    if (startTime > 0) {
      const seekResult = await seekPlaybackSession(session.sessionId, startTime);
      if (!this.isActiveGeneration(generation, session.sessionId)) {
        return;
      }

      session.currentTime = seekResult.currentTimeSeconds;
      session.duration = seekResult.durationSeconds || session.duration;
    }

    this.resetWorklet(session, session.currentTime);
    this.emitTimeUpdate(session.currentTime, session.duration);

    await this.fillBuffer(session, STARTUP_BUFFER_FRAMES);
    if (!this.isActiveGeneration(generation, session.sessionId)) {
      return;
    }

    if (session.bufferedFrames === 0 && session.endOfStream) {
      throw new Error("The audio file did not produce any decoded PCM samples.");
    }

    if (autoPlay) {
      await this.resumeAudioContext();
      this.setPlayState(true);
      this.setStatus("playing");
    } else {
      await this.suspendAudioContext();
      this.setPlayState(false);
      this.setStatus("ready");
    }

    logPlaybackDebug("playback session ready", {
      trackId: track.id,
      sessionId: session.sessionId,
      currentTime: session.currentTime,
      duration: session.duration,
      bufferedFrames: session.bufferedFrames,
      workletInitialized: Boolean(workletNode),
    });

    this.pumpSessionInBackground(session);
  }

  async load(track: Track, autoPlay = true) {
    try {
      await this.loadInternal(track, autoPlay, 0);
    } catch (error) {
      if (this.loadedTrackId === track.id) {
        await this.teardownSession(this.generation, false);
        this.setStatus("error");
        this.setPlayState(false);
      }
      throw error;
    }
  }

  async play() {
    if (!this.activeSession) {
      return;
    }

    if (this.status === "ended") {
      await this.seek(0);
    }

    await this.ensureWorkletNode();
    await this.resumeAudioContext();
    this.setPlayState(true);
    this.setStatus("playing");
    this.pumpSessionInBackground(this.activeSession);
  }

  async resume(track: Track, currentTime = 0) {
    const activeSession = this.activeSession;
    const shouldReload = this.loadedTrackId !== track.id || !activeSession;

    if (shouldReload) {
      await this.loadInternal(track, false, currentTime);
    } else if (
      currentTime > 0 &&
      Math.abs(activeSession.currentTime - currentTime) > 0.25
    ) {
      await this.seek(currentTime);
    }

    await this.play();
  }

  async pause() {
    await this.suspendAudioContext();
    this.setPlayState(false);

    if (this.activeSession) {
      this.setStatus("paused");
    }
  }

  async toggle() {
    if (this.playState) {
      await this.pause();
      return;
    }

    await this.play();
  }

  async seek(seconds: number) {
    const session = this.activeSession;
    if (!session) {
      return;
    }

    this.setStatus(this.playState ? "buffering" : "ready");
    session.bufferedFrames = 0;
    session.endOfStream = false;
    this.resetWorklet(session, seconds);

    const result = await seekPlaybackSession(session.sessionId, seconds);
    if (!this.isActiveGeneration(session.generation, session.sessionId)) {
      return;
    }

    session.currentTime = result.currentTimeSeconds;
    session.duration = result.durationSeconds || session.duration;
    this.emitTimeUpdate(session.currentTime, session.duration);
    await this.fillBuffer(session, STARTUP_BUFFER_FRAMES);
    if (!this.isActiveGeneration(session.generation, session.sessionId)) {
      return;
    }

    this.setStatus(this.playState ? "playing" : "ready");
    this.pumpSessionInBackground(session);
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.applyOutputGain();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyOutputGain();
  }

  reset() {
    const nextGeneration = this.generation + 1;
    this.generation = nextGeneration;
    this.setPlayState(false);
    this.setStatus("idle");
    this.emitTimeUpdate(0, 0);
    void this.suspendAudioContext();
    void this.teardownSession(nextGeneration, true);
  }

  notifyPlaybackError(message: string) {
    this.setStatus("error");
    this.setPlayState(false);
    void this.suspendAudioContext();
    void this.teardownSession(this.generation, false);
    this.callbacks.onError?.(message);
  }
}

export const audioEngine = new AudioEngine();
