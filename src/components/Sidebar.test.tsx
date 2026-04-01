import { createRef, type ComponentProps } from "react";
import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Album, ArtistGroup, Track } from "../lib/types";
import { Sidebar } from "./Sidebar";

type ActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

vi.mock("@react-spring/web", async () => {
  const React = await import("react");

  return {
    animated: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
        <div ref={ref} {...props} />
      )),
    },
    useReducedMotion: () => false,
    useSpring: () => [
      {
        opacity: {
          to: (map: (value: number) => string) => map(1),
        },
        x: {
          to: (map: (value: number) => string) => map(0),
        },
      },
    ],
  };
});

const firstTrack: Track = {
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

const firstAlbum: Album = {
  id: "album-1",
  title: "Eyes Red",
  artist: "Berrymane",
  artPath: null,
  releaseYear: 2022,
  tracks: [firstTrack],
  trackCount: 1,
  totalDurationMs: firstTrack.durationMs,
};

const firstArtist: ArtistGroup = {
  id: "artist-1",
  name: "Berrymane",
  albums: [firstAlbum],
  trackCount: 1,
};

const secondTrack: Track = {
  id: "track-2",
  path: "/music/daydream/daylight/01.flac",
  artPath: null,
  filename: "01.flac",
  title: "Daylight",
  artist: "Daydream",
  album: "Daylight",
  releaseYear: 2021,
  trackNumber: 1,
  durationMs: 124000,
  format: "flac",
  modifiedAt: 2,
};

const secondAlbum: Album = {
  id: "album-2",
  title: "Daylight",
  artist: "Daydream",
  artPath: null,
  releaseYear: 2021,
  tracks: [secondTrack],
  trackCount: 1,
  totalDurationMs: secondTrack.durationMs,
};

const secondArtist: ArtistGroup = {
  id: "artist-2",
  name: "Daydream",
  albums: [secondAlbum],
  trackCount: 1,
};

function findArtistButton(container: HTMLDivElement, artistName: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".nav-item")).find((button) =>
    button.textContent?.includes(artistName),
  );
}

function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  let props: ComponentProps<typeof Sidebar> = {
    artists: [firstArtist, secondArtist],
    activeArtistId: null,
    selectedArtistId: null,
    selectedAlbumId: null,
    currentTrackId: null,
    searchQuery: "",
    searchInputRef: createRef<HTMLInputElement>(),
    musicFoldersCount: 1,
    collapsed: false,
    onSelectArtist: vi.fn(),
    onSelectAlbum: vi.fn(),
    onSelectTrack: vi.fn(),
    onAddSource: vi.fn(),
    onSearchChange: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onFocusSearch: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  function render(nextProps: ComponentProps<typeof Sidebar>) {
    act(() => {
      root.render(<Sidebar {...nextProps} />);
    });
  }

  render(props);

  return {
    container,
    props,
    root,
    rerender(nextOverrides: Partial<ComponentProps<typeof Sidebar>>) {
      props = {
        ...props,
        ...nextOverrides,
      };
      render(props);
      return props;
    },
  };
}

describe("Sidebar", () => {
  let originalClientHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        return element.classList.contains("artist-list") ? 40 : 0;
      },
    });
  });

  afterEach(() => {
    if (originalClientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeightDescriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
    document.body.innerHTML = "";
  });

  it("collapses the active artist without clearing the selected album", async () => {
    const { container, props, root } = renderSidebar({
      activeArtistId: firstArtist.id,
      selectedArtistId: firstArtist.id,
      selectedAlbumId: firstAlbum.id,
    });

    await act(async () => {
      findArtistButton(container, firstArtist.name)?.click();
    });

    expect(props.onSelectArtist).toHaveBeenCalledWith(null);
    expect(props.onSelectAlbum).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("re-expands the active collapsed artist without clearing the selected album", async () => {
    const { container, props, root } = renderSidebar({
      activeArtistId: firstArtist.id,
      selectedArtistId: null,
      selectedAlbumId: firstAlbum.id,
    });

    await act(async () => {
      findArtistButton(container, firstArtist.name)?.click();
    });

    expect(props.onSelectArtist).toHaveBeenCalledWith(firstArtist.id);
    expect(props.onSelectAlbum).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("clears the selected album when switching to a different artist", async () => {
    const { container, props, root } = renderSidebar({
      activeArtistId: firstArtist.id,
      selectedArtistId: null,
      selectedAlbumId: firstAlbum.id,
    });

    await act(async () => {
      findArtistButton(container, secondArtist.name)?.click();
    });

    expect(props.onSelectArtist).toHaveBeenCalledWith(secondArtist.id);
    expect(props.onSelectAlbum).toHaveBeenCalledWith(null);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a clear button only when the search query has text", async () => {
    const { container, rerender, root } = renderSidebar({
      searchQuery: "",
    });

    expect(container.querySelector('[aria-label="Clear search"]')).toBeNull();

    rerender({
      searchQuery: "day",
    });

    expect(container.querySelector('[aria-label="Clear search"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("clears search and restores focus to the input when the clear button is clicked", async () => {
    const { container, props, root } = renderSidebar({
      searchQuery: "day",
    });
    const input = container.querySelector<HTMLInputElement>("input");
    input?.focus();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')?.click();
    });

    expect(props.onSearchChange).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(input);

    await act(async () => {
      root.unmount();
    });
  });

  it("scrolls the active artist to the top after clearing search", async () => {
    const { container, rerender, root } = renderSidebar({
      artists: [secondArtist],
      activeArtistId: secondArtist.id,
      searchQuery: "day",
    });

    const initialArtistList = container.querySelector<HTMLDivElement>(".artist-list");
    expect(initialArtistList?.scrollTop ?? 0).toBe(0);

    rerender({
      artists: [firstArtist, secondArtist],
      activeArtistId: secondArtist.id,
      searchQuery: "",
    });

    const artistList = container.querySelector<HTMLDivElement>(".artist-list");
    expect(artistList?.scrollTop).toBe(24);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not force tree scrolling when search clears without an active artist", async () => {
    const { container, rerender, root } = renderSidebar({
      artists: [secondArtist],
      searchQuery: "day",
    });

    rerender({
      artists: [firstArtist, secondArtist],
      searchQuery: "",
    });

    const artistList = container.querySelector<HTMLDivElement>(".artist-list");
    expect(artistList?.scrollTop ?? 0).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });
});
