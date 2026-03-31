import { act } from "react";
import ReactDOM from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Album, ArtistGroup, PlaybackState, Track } from "./lib/types";

const mockListen = vi.fn().mockResolvedValue(() => undefined);
const mockUsePlayerApp = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("@react-spring/web", async () => {
  const React = await import("react");

  return {
    animated: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
        <div ref={ref} {...props} />
      )),
    },
    useReducedMotion: () => false,
    useSpring: (factoryOrConfig: unknown) => {
      const resolved = typeof factoryOrConfig === "function" ? factoryOrConfig() : factoryOrConfig;

      if (
        resolved &&
        typeof resolved === "object" &&
        "sidebarWidth" in resolved
      ) {
        return [
          {
            sidebarWidth: {
              to: (map: (value: number) => string) => map(242),
            },
          },
        ];
      }

      if (
        resolved &&
        typeof resolved === "object" &&
        ("opacity" in resolved || "x" in resolved)
      ) {
        return [
          {
            opacity: {
              to: (_map: (value: number) => string) => "auto",
            },
            x: {
              to: (map: (value: number) => string) => map(0),
            },
          },
        ];
      }

      if (resolved && typeof resolved === "object" && "from" in resolved) {
        return Object.fromEntries(
          Object.entries(resolved.from as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === "number"
              ? {
                  to: (map: (input: number) => string) => map(value),
                }
              : value,
          ]),
        );
      }

      return resolved ?? {};
    },
  };
});

vi.mock("./hooks/usePlayerApp", () => ({
  usePlayerApp: () => mockUsePlayerApp(),
}));

vi.mock("./components/Sidebar", () => ({
  Sidebar: () => <aside>Sidebar</aside>,
}));

vi.mock("./components/QueuePanel", () => ({
  QueuePanel: () => <aside>Queue</aside>,
}));

vi.mock("./components/TransportBar", () => ({
  TransportBar: () => <footer>Transport</footer>,
}));

vi.mock("./components/SyncStatusCard", () => ({
  SyncStatusCard: () => <section>Sync</section>,
}));

vi.mock("./components/LibraryStage", () => ({
  LibraryStage: ({ artist, album }: { artist: ArtistGroup | null; album: Album | null }) => (
    <section>{`Library Stage:${artist?.name ?? "none"}:${album?.title ?? "none"}`}</section>
  ),
}));

const track: Track = {
  id: "track-1",
  path: "/music/berrymane/eyes-red/01.flac",
  artPath: null,
  filename: "01.flac",
  title: "Eyes Red",
  artist: "Berrymane",
  album: "Eyes Red",
  releaseYear: 2022,
  trackNumber: 1,
  durationMs: 111942,
  format: "flac",
  modifiedAt: 1,
};

const album: Album = {
  id: "album-1",
  title: "Eyes Red",
  artist: "Berrymane",
  artPath: null,
  releaseYear: 2022,
  tracks: [track],
  trackCount: 1,
  totalDurationMs: track.durationMs,
};

const artist: ArtistGroup = {
  id: "artist-1",
  name: "Berrymane",
  albums: [album],
  trackCount: 1,
};

const playback: PlaybackState = {
  currentTrackId: null,
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  volume: 0.8,
  muted: false,
  repeatMode: "all",
  shuffle: false,
};

function makePlayerState(overrides: Partial<ReturnType<typeof mockUsePlayerApp>> = {}) {
  return {
    error: null,
    loading: false,
    isSyncing: false,
    syncMessage: "",
    scanProgress: null,
    artists: [artist],
    visibleAlbums: [album],
    selectedArtist: null,
    focusedArtist: null,
    selectedAlbum: null,
    currentAlbum: null,
    selectedArtistId: null,
    selectedAlbumId: null,
    currentTrack: null,
    currentIndex: -1,
    queue: [],
    tracksById: new Map<string, Track>(),
    playback,
    settings: {
      musicFolders: ["/music/berrymane"],
      volume: 0.8,
      muted: false,
      repeatMode: "all" as const,
      shuffle: false,
      queueTrackIds: [],
      currentTrackId: null,
    },
    searchQuery: "",
    setSearchQuery: vi.fn(),
    setSelectedArtistId: vi.fn(),
    setSelectedAlbumId: vi.fn(),
    addFolders: vi.fn(),
    refreshLibrary: vi.fn(),
    playTrack: vi.fn(),
    playQueueIndex: vi.fn(),
    togglePlay: vi.fn(),
    playNext: vi.fn(),
    playPrevious: vi.fn(),
    moveQueue: vi.fn(),
    removeFromQueue: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    seek: vi.fn(),
    ...overrides,
  };
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;
  });

  it("renders the main panel zero state when the stage has no active content", async () => {
    mockUsePlayerApp.mockReturnValue(makePlayerState());
    const { default: App } = await import("./App");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("Signal Awaits");
    expect(container.textContent).not.toContain("Library Stage");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the normal library stage when active stage content exists", async () => {
    mockUsePlayerApp.mockReturnValue(
      makePlayerState({
        focusedArtist: artist,
      }),
    );
    const { default: App } = await import("./App");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("Library Stage:Berrymane:none");
    expect(container.textContent).not.toContain("Signal Awaits");

    await act(async () => {
      root.unmount();
    });
  });

  it("passes the selected album through when an artist is focused", async () => {
    mockUsePlayerApp.mockReturnValue(
      makePlayerState({
        selectedArtist: null,
        focusedArtist: artist,
        selectedAlbum: album,
      }),
    );
    const { default: App } = await import("./App");
    const container = document.createElement("div");
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).toContain("Library Stage:Berrymane:Eyes Red");

    await act(async () => {
      root.unmount();
    });
  });
});
