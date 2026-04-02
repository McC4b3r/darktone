import { act, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, LibraryData, PlaybackState, Track } from "../lib/types";
import type { AudioCallbacks } from "../lib/audio";

type ActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type UsePlayerAppState = {
  error: string | null;
  currentTrack: Track | null;
  playback: PlaybackState;
  togglePlay: () => Promise<void>;
  setVolume: (volume: number) => void;
};

const mockListen = vi.fn();
const mockLoadSettings = vi.fn<[], Promise<AppSettings>>();
const mockLoadLibrary = vi.fn<[], Promise<LibraryData>>();
const mockSaveSettings = vi.fn<[AppSettings], Promise<void>>();
const mockWatchMusicFolders = vi.fn<[string[], (paths: string[]) => void], Promise<() => void>>();
const mockPickMusicFolders = vi.fn();
const mockScanLibrary = vi.fn();
const mockSyncLibraryChanges = vi.fn();

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

let audioCallbacks: AudioCallbacks = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("../lib/tauri", () => ({
  LIBRARY_SCAN_PROGRESS_EVENT: "library-scan-progress",
  loadSettings: () => mockLoadSettings(),
  loadLibrary: () => mockLoadLibrary(),
  saveSettings: (settings: AppSettings) => mockSaveSettings(settings),
  watchMusicFolders: (folders: string[], onChange: (paths: string[]) => void) => mockWatchMusicFolders(folders, onChange),
  pickMusicFolders: () => mockPickMusicFolders(),
  scanLibrary: (...args: unknown[]) => mockScanLibrary(...args),
  syncLibraryChanges: (...args: unknown[]) => mockSyncLibraryChanges(...args),
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
    (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

    mockListen.mockResolvedValue(() => undefined);
    mockLoadSettings.mockResolvedValue(settings);
    mockLoadLibrary.mockResolvedValue(library);
    mockSaveSettings.mockResolvedValue(undefined);
    mockWatchMusicFolders.mockResolvedValue(() => undefined);
    mockSyncLibraryChanges.mockResolvedValue({
      library,
      scannedFiles: 0,
      addedFiles: 0,
      updatedFiles: 0,
      removedFiles: 0,
      unreadableEntries: 0,
      unreadableAudioFiles: 0,
    });
    mockAudioEngine.load.mockResolvedValue(undefined);
    mockAudioEngine.resume.mockResolvedValue(undefined);
    mockAudioEngine.pause.mockResolvedValue(undefined);
    mockAudioEngine.seek.mockResolvedValue(undefined);
    mockAudioEngine.setCallbacks.mockImplementation((callbacks: AudioCallbacks) => {
      audioCallbacks = callbacks;
    });
  });

  it("restores the current track on startup without loading audio or surfacing an error", async () => {
    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: UsePlayerAppState | null = null;
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

    if (!latestState) {
      throw new Error("Expected hook state to be available.");
    }
    const state = latestState as UsePlayerAppState;

    expect(mockAudioEngine.reset).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.load).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
    expect(state.currentTrack?.id).toBe(track.id);
    expect(state.playback.currentTrackId).toBe(track.id);
    expect(state.playback.isPlaying).toBe(false);

    await act(async () => {
      await state.togglePlay();
      await flushEffects();
    });

    expect(mockAudioEngine.load).not.toHaveBeenCalled();
    expect(mockAudioEngine.resume).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.resume).toHaveBeenCalledWith(track, 0);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("resumes the paused current track instead of reloading it", async () => {
    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: UsePlayerAppState | null = null;
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

    if (!latestState) {
      throw new Error("Expected hook state to be available.");
    }

    await act(async () => {
      await (latestState as UsePlayerAppState).togglePlay();
      audioCallbacks.onPlayStateChange?.(true);
      await flushEffects();
    });

    expect(mockAudioEngine.resume).toHaveBeenCalledWith(track, 0);

    await act(async () => {
      mockAudioEngine.pause.mockClear();
      mockAudioEngine.resume.mockClear();
      await (latestState as UsePlayerAppState).togglePlay();
      audioCallbacks.onPlayStateChange?.(false);
      await flushEffects();
    });

    expect(mockAudioEngine.pause).toHaveBeenCalledTimes(1);

    await act(async () => {
      await (latestState as UsePlayerAppState).togglePlay();
      audioCallbacks.onPlayStateChange?.(true);
      await flushEffects();
    });

    expect(mockAudioEngine.resume).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.resume).toHaveBeenCalledWith(track, 0);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("does not surface a startup error when folder watching cannot be initialized", async () => {
    mockWatchMusicFolders.mockRejectedValueOnce(new Error("watch unavailable"));

    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: UsePlayerAppState | null = null;
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

    if (!latestState) {
      throw new Error("Expected hook state to be available.");
    }
    const state = latestState as UsePlayerAppState;

    expect(state.error).toBeNull();
    expect(mockAudioEngine.load).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("does not rescan the library on window focus or visibility changes", async () => {
    const { usePlayerApp } = await import("./usePlayerApp");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    function Probe() {
      const state = usePlayerApp();
      return <div>{state.error ?? ""}</div>;
    }

    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await flushEffects();
    });

    expect(mockScanLibrary).not.toHaveBeenCalled();
    expect(mockSyncLibraryChanges).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("does not rerender the app hook when playback progress ticks update", async () => {
    const { usePlayerApp } = await import("./usePlayerApp");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);
    let renderCount = 0;

    function Probe() {
      renderCount += 1;
      usePlayerApp();
      return <div />;
    }

    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    const rendersAfterStartup = renderCount;

    await act(async () => {
      audioCallbacks.onTimeUpdate?.(24, 111);
      await flushEffects();
    });

    expect(renderCount).toBe(rendersAfterStartup);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("batches watcher updates into incremental syncs instead of full rescans", async () => {
    vi.useFakeTimers();

    let watchCallback: ((paths: string[]) => void) | undefined;
    mockWatchMusicFolders.mockImplementationOnce(async (_folders, onChange) => {
      watchCallback = onChange;
      return () => undefined;
    });

    const { usePlayerApp } = await import("./usePlayerApp");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    function Probe() {
      const state = usePlayerApp();
      return <div>{state.error ?? ""}</div>;
    }

    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    await act(async () => {
      watchCallback?.(["/music/berrymane/eyes-red/02.flac"]);
      watchCallback?.(["/music/berrymane/eyes-red/cover.jpg"]);
      vi.advanceTimersByTime(901);
      await flushEffects();
    });

    expect(mockSyncLibraryChanges).toHaveBeenCalledTimes(1);
    expect(mockSyncLibraryChanges).toHaveBeenCalledWith([
      "/music/berrymane/eyes-red/02.flac",
      "/music/berrymane/eyes-red/cover.jpg",
    ]);
    expect(mockScanLibrary).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });

    vi.useRealTimers();
  });

  it("surfaces playback failures when resume fails", async () => {
    mockAudioEngine.resume.mockRejectedValueOnce(new Error("Playback session failed to buffer."));

    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: UsePlayerAppState | null = null;
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

    if (!latestState) {
      throw new Error("Expected hook state to be available.");
    }

    await act(async () => {
      await (latestState as UsePlayerAppState).togglePlay();
      await flushEffects();
    });

    expect((latestState as UsePlayerAppState).error).toContain("Playback session failed to buffer.");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("debounces settings writes and flushes them when the page hides", async () => {
    vi.useFakeTimers();

    const { usePlayerApp } = await import("./usePlayerApp");
    let latestState: UsePlayerAppState | null = null;
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

    expect(mockSaveSettings).not.toHaveBeenCalled();

    await act(async () => {
      (latestState as UsePlayerAppState).setVolume(0.5);
    });

    vi.advanceTimersByTime(299);
    await flushEffects();
    expect(mockSaveSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await flushEffects();
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockSaveSettings.mock.calls[0]?.[0].volume).toBe(0.5);

    mockSaveSettings.mockClear();

    await act(async () => {
      (latestState as UsePlayerAppState).setVolume(0.4);
      await flushEffects();
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await flushEffects();
    });

    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockSaveSettings.mock.calls[0]?.[0].volume).toBe(0.4);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });

    vi.useRealTimers();
  });
});
