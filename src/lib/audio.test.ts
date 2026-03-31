import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "./types";

const mockPrepareDecodedAudioForPlayback = vi.fn<[string], Promise<string>>();
const mockReadPreparedPlaybackAudioBytes = vi.fn<[string], Promise<number[]>>();
const mockConvertFileSrc = vi.fn(
  (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
);
let blobUrlCounter = 0;
const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blobUrlCounter++}`);
const revokeObjectURL = vi.fn();

vi.mock("./tauri", () => ({
  prepareDecodedAudioForPlayback: (path: string) => mockPrepareDecodedAudioForPlayback(path),
  readPreparedPlaybackAudioBytes: (path: string) => mockReadPreparedPlaybackAudioBytes(path),
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

const wavTrack: Track = {
  ...flacTrack,
  id: "wav-track",
  path: "C:/music/clean.wav",
  filename: "clean.wav",
  format: "wav",
};

const PACKAGED_WINDOWS = {
  isDev: false,
  isWindows: true,
} as const;

const DEV_WINDOWS = {
  isDev: true,
  isWindows: true,
} as const;

const PACKAGED_NON_WINDOWS = {
  isDev: false,
  isWindows: false,
} as const;

beforeEach(() => {
  vi.resetModules();
  mockPrepareDecodedAudioForPlayback.mockReset();
  mockReadPreparedPlaybackAudioBytes.mockReset();
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
  it.each([mp3Track, wavTrack, flacTrack])(
    "chooses decoded WAV first for packaged Windows %s tracks",
    async (track) => {
      const { getTrackLoadStrategyOrder } = await import("./audio");

      expect(getTrackLoadStrategyOrder(track, PACKAGED_WINDOWS)).toEqual([
        "decoded-wav",
        "native-file",
        "direct-file",
      ]);
    },
  );

  it("keeps the direct-first strategy outside packaged Windows builds", async () => {
    const { getTrackLoadStrategyOrder } = await import("./audio");

    expect(getTrackLoadStrategyOrder(mp3Track, DEV_WINDOWS)).toEqual([
      "direct-file",
      "native-file",
      "decoded-wav",
    ]);

    expect(getTrackLoadStrategyOrder(flacTrack, PACKAGED_NON_WINDOWS)).toEqual([
      "direct-file",
      "native-file",
      "decoded-wav",
    ]);
  });

  it("uses Blob-backed decoded audio as the primary packaged Windows source", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    mockReadPreparedPlaybackAudioBytes.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await engine.load(mp3Track, false);

    expect(mockPrepareDecodedAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadPreparedPlaybackAudioBytes).toHaveBeenCalledWith("C:/app/playback/working.wav");
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe("audio/wav");
  });

  it("does not use fallbacks for mp3 when the direct source succeeds outside packaged Windows", async () => {
    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(DEV_WINDOWS);

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenCalledWith(mp3Track.path, undefined);
    expect(mockPrepareDecodedAudioForPlayback).not.toHaveBeenCalled();
    expect(mockReadPreparedPlaybackAudioBytes).not.toHaveBeenCalled();
  });

  it("falls back to the native-file source when packaged Windows decoded playback fails", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    mockReadPreparedPlaybackAudioBytes.mockRejectedValue(new Error("read failed"));

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await engine.load(mp3Track, false);

    expect(mockPrepareDecodedAudioForPlayback).toHaveBeenCalledWith(mp3Track.path);
    expect(mockReadPreparedPlaybackAudioBytes).toHaveBeenCalledWith("C:/app/playback/working.wav");
    expect(mockConvertFileSrc).toHaveBeenCalledTimes(1);
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(1, mp3Track.path, "playback");
  });

  it("falls back to the direct-file source when packaged Windows decoded and native playback both fail", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    mockReadPreparedPlaybackAudioBytes.mockRejectedValue(new Error("read failed"));
    FakeAudio.failures.set(`http://playback.localhost/${encodeURIComponent(mp3Track.path)}`, {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await engine.load(mp3Track, false);

    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(1, mp3Track.path, "playback");
    expect(mockConvertFileSrc).toHaveBeenNthCalledWith(2, mp3Track.path, undefined);
  });

  it("revokes the previous Blob URL when packaged Windows decoded playback switches tracks", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/working.wav");
    mockReadPreparedPlaybackAudioBytes.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await engine.load(mp3Track, false);
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/clean.wav");
    await engine.load(wavTrack, false);

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audio/wav:0");
  });

  it("reset clears the active source and revokes the packaged Windows Blob URL", async () => {
    mockPrepareDecodedAudioForPlayback.mockResolvedValue("C:/app/playback/problematic.wav");
    mockReadPreparedPlaybackAudioBytes.mockResolvedValue([10, 20, 30, 40]);

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await engine.load(flacTrack, false);
    const mediaElement = engine.getMediaElement() as unknown as FakeAudio;
    mediaElement.currentTime = 42;

    engine.reset();

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audio/wav:0");
    expect(mediaElement.src).toBe("");
    expect(mediaElement.currentSrc).toBe("");
    expect(mediaElement.currentTime).toBe(0);
    expect((engine as unknown as { loadedTrackId: string | null }).loadedTrackId).toBeNull();
    expect((engine as unknown as { loadingSource: boolean }).loadingSource).toBe(false);
  });

  it("reports the attempted packaged Windows playback strategies when every source fails", async () => {
    mockPrepareDecodedAudioForPlayback.mockRejectedValue(new Error("decoder failed"));
    FakeAudio.failures.set(`http://playback.localhost/${encodeURIComponent(mp3Track.path)}`, {
      code: 2,
      message: "network error while loading media",
    });
    FakeAudio.failures.set(`http://asset.localhost/${encodeURIComponent(mp3Track.path)}`, {
      code: 3,
      message: "media decode error",
    });

    const { AudioEngine } = await import("./audio");
    const engine = new AudioEngine(PACKAGED_WINDOWS);

    await expect(engine.load(mp3Track, false)).rejects.toThrow(
      'Playback could not start for "Problematic" after trying decoded-wav, native-file, direct-file.',
    );
  });
});
