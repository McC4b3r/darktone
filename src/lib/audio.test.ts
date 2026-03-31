import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "./types";

const mockPrepareDecodedAudioForPlayback = vi.fn<[string], Promise<string>>();
const mockConvertFileSrc = vi.fn((path: string, protocol = "asset") => `${protocol}://${path}`);

vi.mock("./tauri", () => ({
  prepareDecodedAudioForPlayback: (path: string) => mockPrepareDecodedAudioForPlayback(path),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol?: string) => mockConvertFileSrc(path, protocol),
}));

type Listener = () => void;

class FakeAudio {
  static readonly HAVE_NOTHING = 0;
  static readonly HAVE_METADATA = 1;

  preload = "metadata";
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  paused = true;
  readyState = FakeAudio.HAVE_NOTHING;
  src = "";
  currentSrc = "";
  error: { code: number; message: string } | null = null;
  private listeners = new Map<string, Set<Listener>>();
  static failures = new Map<string, { code: number; message: string }>();

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  pause() {
    this.paused = true;
    this.dispatch("pause");
  }

  async play() {
    this.paused = false;
    this.dispatch("play");
  }

  load() {
    this.currentSrc = this.src;

    const failure = FakeAudio.failures.get(this.src);
    if (failure) {
      this.readyState = FakeAudio.HAVE_NOTHING;
      this.error = failure;
      queueMicrotask(() => {
        this.dispatch("error");
      });
      return;
    }

    if (this.src.endsWith(".flac")) {
      this.readyState = FakeAudio.HAVE_NOTHING;
      this.error = {
        code: 4,
        message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
      };
      queueMicrotask(() => {
        this.dispatch("error");
      });
      return;
    }

    this.readyState = FakeAudio.HAVE_METADATA;
    this.error = null;
    queueMicrotask(() => {
      this.dispatch("loadedmetadata");
      this.dispatch("canplay");
    });
  }

  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
      this.currentSrc = "";
    }
  }

  private dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

class FakeAudioContext {
  state: "running" | "suspended" = "running";

  createMediaElementSource() {
    return {
      connect() {
        return undefined;
      },
    };
  }

  createGain() {
    return {
      connect() {
        return undefined;
      },
    };
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  get destination() {
    return {};
  }
}

const flacTrack: Track = {
  id: "flac-track",
  path: "C:/music/problematic.flac",
  artPath: null,
  filename: "problematic.flac",
  title: "Problematic",
  artist: "Artist",
  album: "Album",
  releaseYear: 2004,
  trackNumber: 1,
  durationMs: 180000,
  format: "flac",
  modifiedAt: 1,
};

const mp3Track: Track = {
  ...flacTrack,
  id: "mp3-track",
  path: "C:/music/working.mp3",
  filename: "working.mp3",
  format: "mp3",
};

beforeEach(() => {
  vi.resetModules();
  mockPrepareDecodedAudioForPlayback.mockReset();
  mockConvertFileSrc.mockClear();
  FakeAudio.failures.clear();

  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });
});

describe("AudioEngine", () => {
  it("chooses the native-file fallback first for packaged Windows builds", async () => {
    const { getTrackLoadStrategyOrder } = await import("./audio");

    expect(
      getTrackLoadStrategyOrder(mp3Track, {
        isDev: false,
        isWindows: true,
      }),
    ).toEqual(["native-file", "direct-file", "decoded-wav"]);
  });

  it("keeps the direct-first strategy outside packaged Windows builds", async () => {
    const { getTrackLoadStrategyOrder } = await import("./audio");

    expect(
      getTrackLoadStrategyOrder(mp3Track, {
        isDev: true,
        isWindows: true,
      }),
    ).toEqual(["direct-file", "native-file", "decoded-wav"]);

    expect(
      getTrackLoadStrategyOrder(flacTrack, {
        isDev: false,
        isWindows: false,
      }),
    ).toEqual(["direct-file", "native-file", "decoded-wav"]);
  });

  it("tries direct and native file sources before using the decoded WAV fallback for FLAC", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/problematic.wav");

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(flacTrack, false);

    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(1, flacTrack.path, undefined);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(2, flacTrack.path, "playback");
    expect(mockPrepareDecodedAudioForPlayback).toHaveBeenCalledWith(flacTrack.path);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(3, "C:/app/playback/problematic.wav", undefined);
  });

  it("does not use fallbacks for mp3 when the direct source succeeds", async () => {
    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path, undefined);
    expect(mockPrepareDecodedAudioForPlayback).not.toHaveBeenCalled();
  });

  it("uses the native-file fallback for mp3 when the direct source fails", async () => {
    FakeAudio.failures.set(`asset://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(1, mp3Track.path, undefined);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(2, mp3Track.path, "playback");
    expect(mockPrepareDecodedAudioForPlayback).not.toHaveBeenCalled();
  });

  it("uses decoded fallback after direct and native failures when both are unsupported-source errors", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    FakeAudio.failures.set(`asset://${mp3Track.path}`, {
      code: 4,
      message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
    });
    FakeAudio.failures.set(`playback://${mp3Track.path}`, {
      code: 4,
      message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockPrepareDecodedAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(3, "C:/app/playback/working.wav", undefined);
  });

  it("uses decoded fallback as a final recovery path when direct and native playback both fail", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    FakeAudio.failures.set(`asset://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });
    FakeAudio.failures.set(`playback://${mp3Track.path}`, {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockPrepareDecodedAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(3, "C:/app/playback/working.wav", undefined);
  });

  it("reset clears the active source and startup state after a fallback load", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/problematic.wav");

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(flacTrack, false);
    const mediaElement = engine.getMediaElement() as unknown as FakeAudio;
    mediaElement.currentTime = 42;

    engine.reset();

    expect(mediaElement.src).toBe("");
    expect(mediaElement.currentSrc).toBe("");
    expect(mediaElement.currentTime).toBe(0);
    expect((engine as unknown as { loadedTrackId: string | null }).loadedTrackId).toBeNull();
    expect((engine as unknown as { loadingSource: boolean }).loadingSource).toBe(false);
  });

  it("reports the attempted source strategies when playback fails everywhere", async () => {
    mockPrepareDecodedAudioForPlayback.mockRejectedValue(new Error("decoder failed"));
    FakeAudio.failures.set(`asset://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });
    FakeAudio.failures.set(`playback://${mp3Track.path}`, {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await expect(engine.load(mp3Track, false)).rejects.toThrow(
      'Playback could not start for "Problematic" after trying direct-file, native-file, decoded-wav.',
    );
  });
});
