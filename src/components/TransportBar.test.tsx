import { act } from "react";
import ReactDOM from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlaybackProgress, setPlaybackProgress } from "../lib/playbackProgress";
import { TransportBar } from "./TransportBar";

type ActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("TransportBar", () => {
  beforeEach(() => {
    (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    resetPlaybackProgress();
    setPlaybackProgress({
      currentTime: 30,
      duration: 120,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetPlaybackProgress();
  });

  it("updates the displayed scrub position immediately but commits the real seek on blur", async () => {
    const onSeek = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(
        <TransportBar
          volume={0.8}
          muted={false}
          onSeek={onSeek}
          onVolumeChange={vi.fn()}
          onToggleMute={vi.fn()}
        />,
      );
    });

    const timeline = container.querySelector<HTMLInputElement>(".range--timeline");
    if (!timeline) {
      throw new Error("Expected timeline input to render.");
    }

    await act(async () => {
      Simulate.change(timeline, {
        target: {
          value: "60",
        },
      });
    });

    expect(onSeek).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1:00");

    await act(async () => {
      Simulate.blur(timeline);
    });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(60);

    await act(async () => {
      root.unmount();
    });
  });
});
