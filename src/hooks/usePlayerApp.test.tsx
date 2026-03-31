import { act, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, LibraryData } from "../lib/types";

const mockListen = vi.fn();
const mockLoadSettings = vi.fn<[], Promise<AppSettings>>();
const mockLoadLibrary = vi.fn<[], Promise<LibraryData>>();
const mockSaveSettings = vi.fn<[AppSettings], Promise<void>>();
const mockWatchMusicFolders = vi.fn<[string[], () => void], Promise<() => void>>();
const mockPickMusicFolders = vi.fn();
const mockScanLibrary = vi.fn();

const mockAudioEngine = {
  setCallbacks: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  reset: vi.fn(),
  load: vi.fn<[unknown], Promise<void>>(),
  resume: vi.fn<[unknown, number?], Promise<void>>(),
  pause: vi.fn(),
  seek: vi.fn(),
};

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("../lib/tauri", () => ({
  LIBRARY_SCAN_PROGRESS_EVENT: "library-scan-progress",
  loadSettings: () => mockLoadSettings(),
  loadLibrary: () => mockLoadLibrary(),
  saveSettings: (settings: AppSettings) => mockSaveSettings(settings),
  watchMusicFolders: (folders: string[], onChange: () => void) => mockWatchMusicFolders(folders, onChange),
  pickMusicFolders: () => mockPickMusicFolders(),
  scanLibrary: (...args: unknown[]) => mockScanLibrary(...args),
}));

vi.mock("../lib/audio", () => ({
  audioEngine: mockAudioEngine,
}));

const track = {
  id: "/music/berrymane/eyes-red/01.flac",
  path: "/music/berrymane/eyes-red/01.flac",
  artPath: null,
  filename: "01.flac",
  title: "Eyes Red",
  artist: "Berrymane",
  album: "Eyes Red",
  releaseYear: 2022,
  trackNumber: 1,
  durationMs: 111942,
  format: "flac" as const,
  modifiedAt: 1,
};

const settings: AppSettings = {
  musicFolders: ["/music/berrymane"],
  volume: 0.7,
  muted: false,
  repeatMode: "all",
  shuffle: false,
  queueTrackIds: [],
  currentTrackId: track.id,
};

const library: LibraryData = {
  tracks: [track],
  scannedAt: null,
};

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("usePlayerApp", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    mockListen.mockResolvedValue(() => undefined);
    mockLoadSettings.mockResolvedValue(settings);
    mockLoadLibrary.mockResolvedValue(library);
    mockSaveSettings.mockResolvedValue(undefined);
    mockWatchMusicFolders.mockResolvedValue(() => undefined);
    mockAudioEngine.load.mockResolvedValue(undefined);
    mockAudioEngine.resume.mockResolvedValue(undefined);
  });

  it("restores the current track on startup without loading audio or surfacing an error", async () => {
    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: ReturnType<typeof usePlayerApp> | null = null;
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    function Probe() {
      const state = usePlayerApp();
      useEffect(() => {
        latestState = state;
      }, [state]);
      return <div>{state.error ?? ""}</div>;
    }

    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    expect(mockAudioEngine.reset).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.load).not.toHaveBeenCalled();
    expect(latestState?.error).toBeNull();
    expect(latestState?.currentTrack?.id).toBe(track.id);
    expect(latestState?.playback.currentTrackId).toBe(track.id);
    expect(latestState?.playback.isPlaying).toBe(false);

    await act(async () => {
      await latestState?.togglePlay();
      await flushEffects();
    });

    expect(mockAudioEngine.load).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.load).toHaveBeenCalledWith(track);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("does not surface a startup error when folder watching cannot be initialized", async () => {
    mockWatchMusicFolders.mockRejectedValueOnce(new Error("watch unavailable"));

    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: ReturnType<typeof usePlayerApp> | null = null;
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    function Probe() {
      const state = usePlayerApp();
      useEffect(() => {
        latestState = state;
      }, [state]);
      return <div>{state.error ?? ""}</div>;
    }

    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    expect(latestState?.error).toBeNull();
    expect(mockAudioEngine.load).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
