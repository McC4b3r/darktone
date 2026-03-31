import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "./types";

const mockReadAudioFile = vi.fn<[string], Promise<number[]>>();
const mockDecodeAudioForPlayback = vi.fn<[string], Promise<number[]>>();
const mockConvertFileSrc = vi.fn((path: string) => `file://${path}`);
let blobUrlCounter = 0;
const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blobUrlCounter++}`);
const revokeObjectURL = vi.fn();

vi.mock("./tauri", () => ({
  readAudioFile: (path: string) => mockReadAudioFile(path),
  decodeAudioForPlayback: (path: string) => mockDecodeAudioForPlayback(path),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
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

    if (this.src.includes("audio/flac") || this.src.endsWith(".flac")) {
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
  mockReadAudioFile.mockReset();
  mockDecodeAudioForPlayback.mockReset();
  mockConvertFileSrc.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  FakeAudio.failures.clear();
  blobUrlCounter = 0;

  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
});

describe("AudioEngine", () => {
  it("chooses decoded WAV first for packaged Windows builds", async () => {
    const { getTrackLoadStrategyOrder } = await import("./audio");

    expect(
      getTrackLoadStrategyOrder(mp3Track, {
        isDev: false,
        isWindows: true,
      }),
    ).toEqual(["decoded-wav", "direct-file", "blob"]);
  });

  it("keeps the existing direct-first strategy outside packaged Windows builds", async () => {
    const { getTrackLoadStrategyOrder } = await import("./audio");

    expect(
      getTrackLoadStrategyOrder(mp3Track, {
        isDev: true,
        isWindows: true,
      }),
    ).toEqual(["direct-file", "blob", "decoded-wav"]);

    expect(
      getTrackLoadStrategyOrder(flacTrack, {
        isDev: false,
        isWindows: false,
      }),
    ).toEqual(["direct-file", "decoded-wav", "blob"]);
  });

  it("tries the direct file source first and then falls back to Rust-decoded WAV for FLAC", async () => {
    mockDecodeAudioForPlayback.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(flacTrack, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(flacTrack.path);
    expect(mockDecodeAudioForPlayback).toHaveBeenCalledWith(flacTrack.path);
    expect(mockReadAudioFile).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe("audio/wav");
  });

  it("does not use blob or decode fallbacks for mp3 when the direct source succeeds", async () => {
    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadAudioFile).not.toHaveBeenCalled();
    expect(mockDecodeAudioForPlayback).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("uses blob fallback for mp3 when the direct file source fails", async () => {
    mockReadAudioFile.mockResolvedValue([1, 2, 3]);
    FakeAudio.failures.set(`file://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadAudioFile).toHaveBeenCalledWith(mp3Track.path);
    expect(mockDecodeAudioForPlayback).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe("audio/mpeg");
  });

  it("uses decoded fallback after direct and blob failures when both are unsupported-source errors", async () => {
    mockReadAudioFile.mockResolvedValue([1, 2, 3]);
    mockDecodeAudioForPlayback.mockResolvedValue([10, 20, 30, 40]);
    FakeAudio.failures.set(`file://${mp3Track.path}`, {
      code: 4,
      message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
    });
    FakeAudio.failures.set("blob:audio/mpeg:0", {
      code: 4,
      message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadAudioFile).toHaveBeenCalledWith(mp3Track.path);
    expect(mockDecodeAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect((createObjectURL.mock.calls[1]?.[0] as Blob).type).toBe("audio/wav");
  });

  it("uses decoded fallback as a final recovery path when direct and blob playback both fail", async () => {
    mockReadAudioFile.mockResolvedValue([1, 2, 3]);
    mockDecodeAudioForPlayback.mockResolvedValue([10, 20, 30, 40]);
    FakeAudio.failures.set(`file://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });
    FakeAudio.failures.set("blob:audio/mpeg:0", {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadAudioFile).toHaveBeenCalledWith(mp3Track.path);
    expect(mockDecodeAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect((createObjectURL.mock.calls[1]?.[0] as Blob).type).toBe("audio/wav");
  });

  it("revokes the previous object URL when switching tracks after a fallback load", async () => {
    mockDecodeAudioForPlayback.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(flacTrack, false);
    await engine.load(mp3Track, false);

    expect(revokeObjectURL).toHaveBeenCalled();
    expect(mockDecodeAudioForPlayback).toHaveBeenCalledTimes(1);
  });

  it("reset clears the active source and startup state after a fallback load", async () => {
    mockDecodeAudioForPlayback.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await engine.load(flacTrack, false);
    const mediaElement = engine.getMediaElement() as unknown as FakeAudio;
    mediaElement.currentTime = 42;

    engine.reset();

    expect(revokeObjectURL).toHaveBeenCalled();
    expect(mediaElement.src).toBe("");
    expect(mediaElement.currentSrc).toBe("");
    expect(mediaElement.currentTime).toBe(0);
    expect((engine as unknown as { loadedTrackId: string | null }).loadedTrackId).toBeNull();
    expect((engine as unknown as { loadingSource: boolean }).loadingSource).toBe(false);
  });

  it("reports the attempted source strategies when playback fails everywhere", async () => {
    mockReadAudioFile.mockResolvedValue([1, 2, 3]);
    mockDecodeAudioForPlayback.mockRejectedValue(new Error("decoder failed"));
    FakeAudio.failures.set(`file://${mp3Track.path}`, {
      code: 2,
      message: "network error while loading media",
    });
    FakeAudio.failures.set("blob:audio/mpeg:0", {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine();

    await expect(engine.load(mp3Track, false)).rejects.toThrow(
      'Playback could not start for "Problematic" after trying direct-file, blob, decoded-wav.',
    );
  });
});
