import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioCallbacks } from "./audio";
import type { Track } from "./types";

const mockOpenPlaybackSession = vi.fn();
const mockReadPlaybackFrames = vi.fn();
const mockSeekPlaybackSession = vi.fn();
const mockClosePlaybackSession = vi.fn();

vi.mock("./tauri", () => ({
  openPlaybackSession: (...args: unknown[]) => mockOpenPlaybackSession(...args),
  readPlaybackFrames: (...args: unknown[]) => mockReadPlaybackFrames(...args),
  seekPlaybackSession: (...args: unknown[]) => mockSeekPlaybackSession(...args),
  closePlaybackSession: (...args: unknown[]) => mockClosePlaybackSession(...args),
}));

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sentMessages: unknown[] = [];

  postMessage(message: unknown) {
    this.sentMessages.push(message);
  }

  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeGainNode {
  gain = { value: 1 };

  connect() {
    return undefined;
  }
}

class FakeAudioWorklet {
  addModule = vi.fn(async () => undefined);
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  sampleRate = 48_000;
  state: "running" | "suspended" = "suspended";
  audioWorklet = new FakeAudioWorklet();
  destination = {};

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return new FakeGainNode();
  }

  resume = vi.fn(async () => {
    this.state = "running";
  });

  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  readonly port = new FakeMessagePort();
  readonly connect = vi.fn();

  constructor(
    _context: AudioContext,
    _name: string,
    _options?: AudioWorkletNodeOptions,
  ) {
    FakeAudioWorkletNode.instances.push(this);
  }
}

const track: Track = {
  id: "track-1",
  path: "/music/artist/album/song.flac",
  artPath: null,
  filename: "song.flac",
  title: "Song",
  artist: "Artist",
  album: "Album",
  releaseYear: 2024,
  trackNumber: 1,
  durationMs: 180000,
  format: "flac",
  modifiedAt: 1,
};

const secondTrack: Track = {
  ...track,
  id: "track-2",
  path: "/music/artist/album/song-2.mp3",
  filename: "song-2.mp3",
  title: "Song 2",
  format: "mp3",
};

function playbackMetadata(sessionId: number) {
  return {
    sessionId,
    sampleRate: 48_000,
    channelCount: 2,
    sourceSampleRate: 44_100,
    sourceChannelCount: 2,
    durationSeconds: 180,
    currentTimeSeconds: 0,
  };
}

function playbackChunk(
  sessionId: number,
  frames: number,
  options?: {
    endOfStream?: boolean;
    currentTimeSeconds?: number;
    durationSeconds?: number;
  },
) {
  return {
    sessionId,
    sampleRate: 48_000,
    channelCount: 2,
    frames,
    samples: Array.from({ length: frames * 2 }, (_, index) => Math.sin(index / 16)),
    endOfStream: options?.endOfStream ?? false,
    currentTimeSeconds: options?.currentTimeSeconds ?? frames / 48_000,
    durationSeconds: options?.durationSeconds ?? 180,
  };
}

function latestWorkletPort() {
  const instance = FakeAudioWorkletNode.instances[FakeAudioWorkletNode.instances.length - 1];
  if (!instance) {
    throw new Error("Expected a worklet node instance.");
  }
  return instance.port;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  FakeAudioContext.instances = [];
  FakeAudioWorkletNode.instances = [];

  mockOpenPlaybackSession.mockReset();
  mockReadPlaybackFrames.mockReset();
  mockSeekPlaybackSession.mockReset();
  mockClosePlaybackSession.mockReset();
  mockClosePlaybackSession.mockResolvedValue(undefined);

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
});

describe("AudioEngine", () => {
  it("loads a startup buffer through playback sessions before beginning playback", async () => {
    mockOpenPlaybackSession.mockResolvedValue(playbackMetadata(11));
    mockReadPlaybackFrames
      .mockResolvedValueOnce(playbackChunk(11, 16_384))
      .mockResolvedValueOnce(playbackChunk(11, 16_384))
      .mockResolvedValue(playbackChunk(11, 16_384, { endOfStream: true }));

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(track, false);

    expect(mockOpenPlaybackSession).toHaveBeenCalledWith(track.path, 48_000, 2);
    expect(mockReadPlaybackFrames).toHaveBeenCalledTimes(3);
    expect(FakeAudioContext.instances[0]?.resume).not.toHaveBeenCalled();
    expect((FakeAudioContext.instances[0]?.audioWorklet.addModule as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(
      new URL(
        (FakeAudioContext.instances[0]?.audioWorklet.addModule as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
      ).pathname,
    ).toBe("/audio-worklet.js");

    const messages = latestWorkletPort().sentMessages as Array<{ type: string }>;
    expect(messages[0]?.type).toBe("reset");
    expect(messages.filter((message) => message.type === "append")).toHaveLength(2);
  });

  it("includes the shipped worklet URL in the playback error when the module fails to load", async () => {
    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();
    const audioContext = engine.getAudioContext() as unknown as FakeAudioContext;
    (
      audioContext.audioWorklet.addModule as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("Unable to load a worklet's module"));

    await expect(engine.load(track, false)).rejects.toThrow(
      /Unable to load the playback worklet from .*\/audio-worklet\.js\. Unable to load a worklet's module/u,
    );
    expect(mockOpenPlaybackSession).not.toHaveBeenCalled();
  });

  it("reports progress from worklet messages and keeps the analyzer graph alive", async () => {
    mockOpenPlaybackSession.mockResolvedValue(playbackMetadata(21));
    mockReadPlaybackFrames
      .mockResolvedValueOnce(playbackChunk(21, 16_384))
      .mockResolvedValueOnce(playbackChunk(21, 16_384))
      .mockResolvedValue(playbackChunk(21, 8_192));

    const callbacks: AudioCallbacks = {
      onTimeUpdate: vi.fn(),
      onPlayStateChange: vi.fn(),
      onStatusChange: vi.fn(),
    };

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();
    engine.setCallbacks(callbacks);

    const audioContext = engine.getAudioContext();
    const analyzerInput = engine.getAnalyzerInputNode();

    await engine.load(track, true);

    expect(audioContext).toBeInstanceOf(FakeAudioContext);
    expect(analyzerInput).toBeInstanceOf(FakeGainNode);
    expect(callbacks.onPlayStateChange).toHaveBeenLastCalledWith(true);

    latestWorkletPort().emit({
      type: "progress",
      generation: 1,
      playedFrames: 24_000,
      bufferedFrames: 12_000,
    });

    expect(callbacks.onTimeUpdate).toHaveBeenLastCalledWith(0.5, 180);
  });

  it("drops stale worklet events and closes the superseded playback session on track changes", async () => {
    mockOpenPlaybackSession
      .mockResolvedValueOnce(playbackMetadata(31))
      .mockResolvedValueOnce(playbackMetadata(32));
    mockReadPlaybackFrames
      .mockResolvedValueOnce(playbackChunk(31, 16_384))
      .mockResolvedValueOnce(playbackChunk(31, 16_384))
      .mockResolvedValueOnce(playbackChunk(32, 16_384))
      .mockResolvedValueOnce(playbackChunk(32, 16_384))
      .mockResolvedValue(playbackChunk(32, 16_384));

    const callbacks: AudioCallbacks = {
      onTimeUpdate: vi.fn(),
    };

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();
    engine.setCallbacks(callbacks);

    await engine.load(track, false);
    const firstPort = latestWorkletPort();
    await engine.load(secondTrack, false);

    expect(mockClosePlaybackSession).toHaveBeenCalledWith(31);

    firstPort.emit({
      type: "progress",
      generation: 1,
      playedFrames: 48_000,
      bufferedFrames: 4_096,
    });

    expect(callbacks.onTimeUpdate).not.toHaveBeenCalledWith(1, 180);
  });

  it("seeks by resetting the worklet timeline and refilling a fresh startup buffer", async () => {
    mockOpenPlaybackSession.mockResolvedValue(playbackMetadata(41));
    mockReadPlaybackFrames
      .mockResolvedValueOnce(playbackChunk(41, 16_384))
      .mockResolvedValueOnce(playbackChunk(41, 16_384))
      .mockResolvedValueOnce(playbackChunk(41, 16_384))
      .mockResolvedValueOnce(playbackChunk(41, 16_384));
    mockSeekPlaybackSession.mockResolvedValue({
      sessionId: 41,
      currentTimeSeconds: 30,
      durationSeconds: 180,
    });

    const callbacks: AudioCallbacks = {
      onTimeUpdate: vi.fn(),
    };

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();
    engine.setCallbacks(callbacks);

    await engine.load(track, false);
    latestWorkletPort().sentMessages.length = 0;

    await engine.seek(30);

    expect(mockSeekPlaybackSession).toHaveBeenCalledWith(41, 30);
    expect(mockReadPlaybackFrames).toHaveBeenCalledTimes(5);
    expect(callbacks.onTimeUpdate).toHaveBeenCalledWith(30, 180);

    const resetMessage = (latestWorkletPort().sentMessages[0] ?? {}) as { type?: string; playedFrames?: number };
    expect(resetMessage.type).toBe("reset");
    expect(resetMessage.playedFrames).toBe(30 * 48_000);
  });

  it("surfaces background buffering failures through the async playback callbacks", async () => {
    mockOpenPlaybackSession.mockResolvedValue(playbackMetadata(51));
    mockReadPlaybackFrames
      .mockResolvedValueOnce(playbackChunk(51, 16_384))
      .mockResolvedValueOnce(playbackChunk(51, 16_384))
      .mockRejectedValueOnce(new Error("decoder stalled"));

    const callbacks: AudioCallbacks = {
      onError: vi.fn(),
      onPlayStateChange: vi.fn(),
    };

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();
    engine.setCallbacks(callbacks);

    await engine.load(track, true);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(callbacks.onError).toHaveBeenCalledWith("decoder stalled");
    expect(callbacks.onPlayStateChange).toHaveBeenLastCalledWith(false);
  });
});
