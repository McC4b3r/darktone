import {
  appendPlaybackLogEntry,
  closePlaybackSession,
  openPlaybackSession,
  type PlaybackLogEntry,
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
  operationToken: number;
  playedFrames: number;
};

type WorkletAppendMessage = {
  type: "append";
  generation: number;
  operationToken: number;
  frames: number;
  channelCount: number;
  endOfStream: boolean;
  samples: Float32Array;
};

type WorkletMessage = WorkletResetMessage | WorkletAppendMessage;

type WorkletNeedDataMessage = {
  type: "need-data";
  generation: number;
  operationToken: number;
  bufferedFrames: number;
};

type WorkletProgressMessage = {
  type: "progress";
  generation: number;
  operationToken: number;
  playedFrames: number;
  bufferedFrames: number;
};

type WorkletEndedMessage = {
  type: "ended";
  generation: number;
  operationToken: number;
  playedFrames: number;
};

type WorkletEvent = WorkletNeedDataMessage | WorkletProgressMessage | WorkletEndedMessage;

type EngineSession = {
  generation: number;
  sessionId: number;
  trackId: string;
  operationToken: number;
  sampleRate: number;
  channelCount: number;
  duration: number;
  currentTime: number;
  bufferedFrames: number;
  endOfStream: boolean;
  isSeeking: boolean;
  readPromise: Promise<void> | null;
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

function roundDurationMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
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
  private operationToken = 0;
  private pendingSeekSeconds: number | null = null;
  private seekPromise: Promise<void> | null = null;
  private playbackLogPromise: Promise<void> = Promise.resolve();

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

  private nextOperationToken() {
    this.operationToken += 1;
    return this.operationToken;
  }

  private queuePlaybackLog(entry: Omit<PlaybackLogEntry, "timestampMs">) {
    const payload: PlaybackLogEntry = {
      timestampMs: Date.now(),
      level: "info",
      details: null,
      ...entry,
    };

    this.playbackLogPromise = this.playbackLogPromise
      .catch(() => undefined)
      .then(() => appendPlaybackLogEntry(payload))
      .catch((error) => {
        console.warn("Could not write playback diagnostics.", error);
      });
  }

  private logFrontendEvent(
    event: string,
    {
      level,
      session,
      operationToken,
      trackId,
      requestedSeconds,
      actualSeconds,
      durationMs,
      details,
    }: {
      level?: PlaybackLogEntry["level"];
      session?: EngineSession | null;
      operationToken?: number | null;
      trackId?: string | null;
      requestedSeconds?: number | null;
      actualSeconds?: number | null;
      durationMs?: number | null;
      details?: Record<string, unknown> | null;
    } = {},
  ) {
    this.queuePlaybackLog({
      source: "frontend",
      event,
      level,
      sessionId: session?.sessionId ?? null,
      operationToken: operationToken ?? session?.operationToken ?? null,
      trackId: trackId ?? session?.trackId ?? this.loadedTrackId,
      requestedSeconds: requestedSeconds ?? null,
      actualSeconds: actualSeconds ?? null,
      durationMs: durationMs ?? null,
      details: details ?? null,
    });
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
    if (
      !session ||
      event.generation !== session.generation ||
      event.operationToken !== session.operationToken
    ) {
      return;
    }

    if (session.isSeeking) {
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
    this.pendingSeekSeconds = null;
    if (resetLoadedTrack) {
      this.loadedTrackId = null;
    }

    this.postToWorklet({
      type: "reset",
      generation: nextGeneration,
      operationToken: 0,
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
      operationToken: session.operationToken,
      playedFrames: Math.max(0, Math.round(currentTime * session.sampleRate)),
    });
  }

  private async readNextChunk(session: EngineSession, operationToken: number) {
    if (session.endOfStream) {
      return;
    }

    if (session.readPromise) {
      return session.readPromise;
    }

    const readStartedAt = performance.now();
    const readPromise = (async () => {
      const chunk = await readPlaybackFrames(session.sessionId, READ_CHUNK_FRAMES, operationToken);
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }

      if (chunk.frames === 0 && !chunk.endOfStream) {
        const message = "Playback stalled while waiting for decoded audio frames.";
        this.logFrontendEvent("playback-read-stalled", {
          level: "error",
          session,
          operationToken,
          durationMs: roundDurationMs(readStartedAt),
          details: {
            bufferedFrames: session.bufferedFrames,
            targetReadFrames: READ_CHUNK_FRAMES,
          },
        });
        throw new Error(message);
      }

      session.endOfStream = chunk.endOfStream;

      if (chunk.frames > 0) {
        const samples = Float32Array.from(chunk.samples);
        session.bufferedFrames += chunk.frames;
        this.postToWorklet({
          type: "append",
          generation: session.generation,
          operationToken,
          frames: chunk.frames,
          channelCount: chunk.channelCount,
          endOfStream: chunk.endOfStream,
          samples,
        });
      } else if (chunk.endOfStream) {
        this.postToWorklet({
          type: "append",
          generation: session.generation,
          operationToken,
          frames: 0,
          channelCount: session.channelCount,
          endOfStream: true,
          samples: new Float32Array(),
        });
      }
    })().finally(() => {
      if (session.readPromise === readPromise) {
        session.readPromise = null;
      }
    });

    session.readPromise = readPromise;
    return readPromise;
  }

  private async fillBuffer(session: EngineSession, targetFrames: number, operationToken: number) {
    while (this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
      if (session.bufferedFrames >= targetFrames || session.endOfStream) {
        return;
      }

      const bufferedBeforeRead = session.bufferedFrames;
      await this.readNextChunk(session, operationToken);
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }
      if (session.bufferedFrames === bufferedBeforeRead && session.endOfStream) {
        return;
      }

      if (session.bufferedFrames === bufferedBeforeRead) {
        throw new Error("Playback stalled while refilling the audio buffer.");
      }
    }
  }

  private async pumpSession(session: EngineSession) {
    if (session.pumpPromise) {
      return session.pumpPromise;
    }

    const operationToken = session.operationToken;
    const pumpPromise = (async () => {
      while (this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        if (session.isSeeking || session.endOfStream || session.bufferedFrames >= HIGH_WATER_FRAMES) {
          return;
        }

        const bufferedBeforeRead = session.bufferedFrames;
        await this.readNextChunk(session, operationToken);
        if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
          return;
        }
        if (session.bufferedFrames === bufferedBeforeRead) {
          if (session.endOfStream) {
            return;
          }

          throw new Error("Playback stalled while buffering audio in the background.");
        }
      }
    })().finally(() => {
      if (session.pumpPromise === pumpPromise) {
        session.pumpPromise = null;
      }
    });

    session.pumpPromise = pumpPromise;
    return pumpPromise;
  }

  private pumpSessionInBackground(session: EngineSession) {
    const operationToken = session.operationToken;
    void this.pumpSession(session).catch((error) => {
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }

      const message = error instanceof Error ? error.message : "Playback buffering failed.";
      this.logFrontendEvent("playback-background-pump-failed", {
        level: "error",
        session,
        operationToken,
        details: {
          message,
        },
      });
      this.notifyPlaybackError(message);
    });
  }

  private async waitForSessionDrain(session: EngineSession) {
    const pending = [session.pumpPromise, session.readPromise].filter(
      (promise): promise is Promise<void> => Boolean(promise),
    );
    if (pending.length === 0) {
      return;
    }

    await Promise.allSettled(pending);
  }

  private isActiveGeneration(generation: number, sessionId?: number) {
    return Boolean(
      this.activeSession &&
        this.activeSession.generation === generation &&
        (sessionId === undefined || this.activeSession.sessionId === sessionId),
    );
  }

  private isActiveOperation(generation: number, sessionId: number, operationToken: number) {
    return Boolean(
      this.activeSession &&
        this.activeSession.generation === generation &&
        this.activeSession.sessionId === sessionId &&
        this.activeSession.operationToken === operationToken,
    );
  }

  private async loadInternal(track: Track, autoPlay: boolean, startTime = 0) {
    const workletNode = await this.ensureWorkletNode();
    const audioContext = this.getAudioContext();
    const generation = this.generation + 1;
    const operationToken = this.nextOperationToken();
    this.generation = generation;
    this.loadedTrackId = track.id;
    this.pendingSeekSeconds = null;
    this.setPlayState(false);
    this.setStatus("buffering");
    this.emitTimeUpdate(startTime, track.durationMs / 1000);

    await this.teardownSession(generation, false);

    const openStartedAt = performance.now();
    this.logFrontendEvent("playback-open-requested", {
      operationToken,
      trackId: track.id,
      details: {
        autoPlay,
        startTime,
        outputSampleRate: audioContext.sampleRate,
        outputChannelCount: OUTPUT_CHANNEL_COUNT,
      },
    });
    const metadata = await openPlaybackSession(
      track.path,
      audioContext.sampleRate,
      OUTPUT_CHANNEL_COUNT,
      operationToken,
    );
    if (generation !== this.generation) {
      void closePlaybackSession(metadata.sessionId);
      return;
    }

    const session: EngineSession = {
      generation,
      sessionId: metadata.sessionId,
      trackId: track.id,
      operationToken,
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
      duration: metadata.durationSeconds || track.durationMs / 1000,
      currentTime: metadata.currentTimeSeconds,
      bufferedFrames: 0,
      endOfStream: false,
      isSeeking: false,
      readPromise: null,
      pumpPromise: null,
    };
    this.activeSession = session;
    this.logFrontendEvent("playback-open-finished", {
      session,
      trackId: track.id,
      durationMs: roundDurationMs(openStartedAt),
      details: {
        autoPlay,
        sourceSampleRate: metadata.sourceSampleRate,
        sourceChannelCount: metadata.sourceChannelCount,
        startTime,
      },
    });

    if (startTime > 0) {
      this.logFrontendEvent("playback-open-seek-started", {
        session,
        requestedSeconds: startTime,
      });
      const seekStartedAt = performance.now();
      const seekResult = await seekPlaybackSession(session.sessionId, startTime, operationToken);
      if (!this.isActiveOperation(generation, session.sessionId, operationToken)) {
        return;
      }

      session.currentTime = seekResult.currentTimeSeconds;
      session.duration = seekResult.durationSeconds || session.duration;
      this.logFrontendEvent("playback-open-seek-finished", {
        session,
        requestedSeconds: startTime,
        actualSeconds: seekResult.currentTimeSeconds,
        durationMs: roundDurationMs(seekStartedAt),
      });
    }

    this.resetWorklet(session, session.currentTime);
    this.emitTimeUpdate(session.currentTime, session.duration);

    const refillStartedAt = performance.now();
    this.logFrontendEvent("playback-open-refill-started", {
      session,
      requestedSeconds: startTime > 0 ? startTime : null,
      actualSeconds: session.currentTime,
    });
    await this.fillBuffer(session, STARTUP_BUFFER_FRAMES, operationToken);
    if (!this.isActiveOperation(generation, session.sessionId, operationToken)) {
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
    this.logFrontendEvent("playback-session-ready", {
      session,
      trackId: track.id,
      durationMs: roundDurationMs(refillStartedAt),
      actualSeconds: session.currentTime,
      details: {
        autoPlay,
        bufferedFrames: session.bufferedFrames,
        workletInitialized: Boolean(workletNode),
      },
    });

    this.pumpSessionInBackground(session);
  }

  async load(track: Track, autoPlay = true) {
    try {
      await this.loadInternal(track, autoPlay, 0);
    } catch (error) {
      this.logFrontendEvent("playback-load-failed", {
        level: "error",
        trackId: track.id,
        details: {
          autoPlay,
          message: error instanceof Error ? error.message : `${error}`,
        },
      });
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
    const normalizedSeconds = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
    this.pendingSeekSeconds = normalizedSeconds;
    if (this.seekPromise) {
      return this.seekPromise;
    }

    this.seekPromise = (async () => {
      while (this.pendingSeekSeconds !== null) {
        const targetSeconds = this.pendingSeekSeconds;
        this.pendingSeekSeconds = null;
        await this.performSeek(targetSeconds);
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : `${error}`;
      this.notifyPlaybackError(message);
      throw error;
    }).finally(() => {
      this.seekPromise = null;
    });

    return this.seekPromise;
  }

  private async performSeek(seconds: number) {
    const session = this.activeSession;
    if (!session) {
      return;
    }

    const wasPlaying = this.playState;
    const operationToken = this.nextOperationToken();
    const seekRequestedAt = performance.now();
    session.operationToken = operationToken;
    session.isSeeking = true;
    session.bufferedFrames = 0;
    session.endOfStream = false;
    this.setStatus(wasPlaying ? "buffering" : "ready");
    this.logFrontendEvent("playback-seek-requested", {
      session,
      operationToken,
      requestedSeconds: seconds,
      details: {
        wasPlaying,
      },
    });

    try {
      await this.suspendAudioContext();

      const pumpDrainStartedAt = performance.now();
      await this.waitForSessionDrain(session);
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }

      this.logFrontendEvent("playback-seek-pump-drained", {
        session,
        operationToken,
        requestedSeconds: seconds,
        durationMs: roundDurationMs(pumpDrainStartedAt),
      });

      if (this.pendingSeekSeconds !== null) {
        this.logFrontendEvent("playback-seek-superseded", {
          session,
          operationToken,
          requestedSeconds: seconds,
          durationMs: roundDurationMs(seekRequestedAt),
          details: {
            stage: "before-native",
            nextRequestedSeconds: this.pendingSeekSeconds,
          },
        });
        return;
      }

      this.logFrontendEvent("playback-seek-native-started", {
        session,
        operationToken,
        requestedSeconds: seconds,
      });
      const nativeSeekStartedAt = performance.now();
      const result = await seekPlaybackSession(session.sessionId, seconds, operationToken);
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }

      session.currentTime = result.currentTimeSeconds;
      session.duration = result.durationSeconds || session.duration;
      if (this.pendingSeekSeconds !== null) {
        this.logFrontendEvent("playback-seek-superseded", {
          session,
          operationToken,
          requestedSeconds: seconds,
          actualSeconds: result.currentTimeSeconds,
          durationMs: roundDurationMs(nativeSeekStartedAt),
          details: {
            stage: "after-native",
            nextRequestedSeconds: this.pendingSeekSeconds,
          },
        });
        return;
      }

      this.resetWorklet(session, session.currentTime);
      this.emitTimeUpdate(session.currentTime, session.duration);
      this.logFrontendEvent("playback-seek-native-finished", {
        session,
        operationToken,
        requestedSeconds: seconds,
        actualSeconds: result.currentTimeSeconds,
        durationMs: roundDurationMs(nativeSeekStartedAt),
      });

      const refillStartedAt = performance.now();
      this.logFrontendEvent("playback-seek-refill-started", {
        session,
        operationToken,
        requestedSeconds: seconds,
        actualSeconds: session.currentTime,
      });
      await this.fillBuffer(session, STARTUP_BUFFER_FRAMES, operationToken);
      if (!this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        return;
      }

      this.logFrontendEvent("playback-seek-refill-finished", {
        session,
        operationToken,
        requestedSeconds: seconds,
        actualSeconds: session.currentTime,
        durationMs: roundDurationMs(refillStartedAt),
        details: {
          bufferedFrames: session.bufferedFrames,
        },
      });

      if (this.pendingSeekSeconds !== null) {
        return;
      }

      if (wasPlaying) {
        await this.resumeAudioContext();
        this.setPlayState(true);
        this.setStatus("playing");
        this.logFrontendEvent("playback-seek-resumed", {
          session,
          operationToken,
          requestedSeconds: seconds,
          actualSeconds: session.currentTime,
          durationMs: roundDurationMs(seekRequestedAt),
        });
        this.pumpSessionInBackground(session);
      } else {
        this.setPlayState(false);
        this.setStatus("ready");
      }
    } finally {
      if (this.isActiveOperation(session.generation, session.sessionId, operationToken)) {
        session.isSeeking = false;
      }
    }
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
    this.pendingSeekSeconds = null;
    this.setPlayState(false);
    this.setStatus("idle");
    this.emitTimeUpdate(0, 0);
    void this.suspendAudioContext();
    void this.teardownSession(nextGeneration, true);
  }

  notifyPlaybackError(message: string) {
    this.pendingSeekSeconds = null;
    this.logFrontendEvent("playback-error", {
      level: "error",
      session: this.activeSession,
      details: {
        message,
      },
    });
    this.setStatus("error");
    this.setPlayState(false);
    void this.suspendAudioContext();
    void this.teardownSession(this.generation, false);
    this.callbacks.onError?.(message);
  }
}

export const audioEngine = new AudioEngine();
