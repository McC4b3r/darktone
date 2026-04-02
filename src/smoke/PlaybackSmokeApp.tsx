import { useEffect, useRef, useState } from "react";
import type AudioMotionAnalyzer from "audiomotion-analyzer";
import { audioEngine } from "../lib/audio";
import { createNowPlayingAnalyzer, createSpectrumAnalyzer } from "../lib/analyzerPresets";
import {
  exitApp,
  writePlaybackSmokeReport,
  type PlaybackSmokeConfig,
  type PlaybackSmokeReport,
  type PlaybackSmokeTrackResult,
} from "../lib/tauri";
import type { Track } from "../lib/types";

const FIRST_PLAYING_TIMEOUT_MS = 2_500;
const SEEK_TIMEOUT_MS = 1_500;
const PROGRESS_SAMPLE_MS = 350;
const PAUSE_HOLD_MS = 300;
const PAUSE_DRIFT_TOLERANCE_SECONDS = 0.05;
const SEEK_TOLERANCE_SECONDS = 0.35;

type SmokeState = {
  currentTime: number;
  duration: number;
  error: string | null;
  status: string;
};

const INITIAL_SMOKE_STATE: SmokeState = {
  currentTime: 0,
  duration: 0,
  error: null,
  status: "idle",
};

function roundDurationMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function sleep(durationMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function buildSmokeTrack(path: string, format: Track["format"]): Track {
  return {
    id: `playback-smoke:${format}`,
    path,
    artPath: null,
    filename: path.split(/[\\/]/).pop() ?? `smoke.${format}`,
    title: `Playback Smoke ${format.toUpperCase()}`,
    artist: "Darktone Diagnostics",
    album: "Playback Smoke",
    releaseYear: null,
    trackNumber: 1,
    durationMs: 5_000,
    format,
    modifiedAt: 0,
    fileSize: null,
  };
}

export function PlaybackSmokeApp({ config }: { config: PlaybackSmokeConfig }) {
  const heroAnalyzerContainerRef = useRef<HTMLDivElement>(null);
  const spectrumAnalyzerContainerRef = useRef<HTMLDivElement>(null);
  const analyzersRef = useRef<AudioMotionAnalyzer[]>([]);
  const smokeStateRef = useRef<SmokeState>(INITIAL_SMOKE_STATE);
  const activeFormatRef = useRef<string>("boot");
  const statusTransitionsRef = useRef<string[]>([]);
  const [statusMessage, setStatusMessage] = useState("Preparing playback smoke test…");
  const [analyzersReady, setAnalyzersReady] = useState(false);
  const [analyzerError, setAnalyzerError] = useState<string | null>(null);

  useEffect(() => {
    audioEngine.setCallbacks({
      onStatusChange: (status) => {
        smokeStateRef.current = {
          ...smokeStateRef.current,
          status,
        };
        statusTransitionsRef.current.push(`${activeFormatRef.current}:${status}`);
      },
      onTimeUpdate: (currentTime, duration) => {
        smokeStateRef.current = {
          ...smokeStateRef.current,
          currentTime,
          duration,
        };
      },
      onError: (message) => {
        smokeStateRef.current = {
          ...smokeStateRef.current,
          error: message,
          status: "error",
        };
      },
      onPlayStateChange: () => undefined,
      onEnded: () => undefined,
    });

    return () => {
      audioEngine.setCallbacks({});
    };
  }, []);

  useEffect(() => {
    if (!heroAnalyzerContainerRef.current || !spectrumAnalyzerContainerRef.current) {
      return;
    }

    try {
      analyzersRef.current = [
        createNowPlayingAnalyzer(heroAnalyzerContainerRef.current),
        createSpectrumAnalyzer(spectrumAnalyzerContainerRef.current),
      ];
      setAnalyzersReady(true);
    } catch (error) {
      setAnalyzerError(error instanceof Error ? error.message : `${error}`);
    }

    return () => {
      for (const analyzer of analyzersRef.current) {
        analyzer.destroy();
      }
      analyzersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!analyzersReady || analyzerError) {
      return;
    }

    let cancelled = false;

    const waitFor = async (predicate: () => boolean, timeoutMs: number, message: string) => {
      const startedAt = performance.now();

      while (performance.now() - startedAt <= timeoutMs) {
        if (smokeStateRef.current.error) {
          throw new Error(smokeStateRef.current.error);
        }

        if (predicate()) {
          return;
        }

        await sleep(25);
      }

      throw new Error(message);
    };

    const didProgressAdvance = async (sampleWindowMs: number) => {
      const startTime = smokeStateRef.current.currentTime;
      await sleep(sampleWindowMs);
      return smokeStateRef.current.currentTime > startTime + 0.05;
    };

    const runStep = async (format: Track["format"], path: string) => {
      activeFormatRef.current = format;
      setStatusMessage(`Running ${format.toUpperCase()} playback smoke…`);
      smokeStateRef.current = INITIAL_SMOKE_STATE;
      const track = buildSmokeTrack(path, format);
      const loadStartedAt = performance.now();

      await audioEngine.load(track, true);
      const openMs = roundDurationMs(loadStartedAt);
      await waitFor(
        () => smokeStateRef.current.status === "playing",
        FIRST_PLAYING_TIMEOUT_MS,
        `${format} did not reach playing.`,
      );
      const firstPlayingMs = roundDurationMs(loadStartedAt);

      const progressAdvancedBeforePause = await didProgressAdvance(PROGRESS_SAMPLE_MS);
      if (!progressAdvancedBeforePause) {
        throw new Error(`${format} progress did not advance while playing.`);
      }

      await audioEngine.pause();
      const pausedAt = smokeStateRef.current.currentTime;
      await sleep(PAUSE_HOLD_MS);
      const pauseHeld =
        Math.abs(smokeStateRef.current.currentTime - pausedAt) <= PAUSE_DRIFT_TOLERANCE_SECONDS;

      await audioEngine.resume(track, smokeStateRef.current.currentTime);
      await waitFor(
        () => smokeStateRef.current.status === "playing",
        SEEK_TIMEOUT_MS,
        `${format} did not resume playback.`,
      );
      const resumedAdvanced = await didProgressAdvance(PROGRESS_SAMPLE_MS);

      const targetSeconds = Math.max(
        0.25,
        smokeStateRef.current.duration > 0 ? smokeStateRef.current.duration / 2 : 1,
      );
      const seekStartedAt = performance.now();
      await audioEngine.seek(targetSeconds);
      await waitFor(
        () => Math.abs(smokeStateRef.current.currentTime - targetSeconds) <= SEEK_TOLERANCE_SECONDS,
        SEEK_TIMEOUT_MS,
        `${format} seek did not land near ${targetSeconds.toFixed(2)}s.`,
      );
      const seekMs = roundDurationMs(seekStartedAt);
      const postSeekAdvanced = await didProgressAdvance(PROGRESS_SAMPLE_MS);

      return {
        format,
        openMs,
        firstPlayingMs,
        seekMs,
        pauseResumeOk: pauseHeld && resumedAdvanced,
        progressAdvancedOk: progressAdvancedBeforePause && resumedAdvanced && postSeekAdvanced,
      } satisfies PlaybackSmokeTrackResult;
    };

    void (async () => {
      const trackResults: PlaybackSmokeTrackResult[] = [];
      const failures: string[] = [];

      try {
        audioEngine.setTransportMode(config.transportMode);
        if (analyzersRef.current.length !== 2) {
          throw new Error("Expected both playback analyzers to be initialized.");
        }

        trackResults.push(await runStep("wav", config.fixturePaths.wav));
        trackResults.push(await runStep("mp3", config.fixturePaths.mp3));
        trackResults.push(await runStep("flac", config.fixturePaths.flac));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${error}`);
      } finally {
        audioEngine.reset();
      }

      if (cancelled) {
        return;
      }

      const report: PlaybackSmokeReport = {
        passed:
          failures.length === 0 &&
          trackResults.length === 3 &&
          trackResults.every((track) => track.pauseResumeOk && track.progressAdvancedOk),
        failures,
        tracks: trackResults,
        transportMode: config.transportMode,
        statusTransitions: statusTransitionsRef.current,
      };

      try {
        await writePlaybackSmokeReport(report);
      } catch (error) {
        console.error("Could not write playback smoke report.", error);
      }

      await exitApp(report.passed ? 0 : 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [analyzerError, analyzersReady, config]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at top, rgba(124, 36, 52, 0.35), transparent 42%), #080b12",
        color: "#dbe2ed",
        fontFamily: "\"Segoe UI\", sans-serif",
      }}
    >
      <section
        style={{
          width: "min(960px, calc(100vw - 48px))",
          padding: 24,
          borderRadius: 24,
          background: "rgba(12, 16, 23, 0.84)",
          border: "1px solid rgba(187, 200, 225, 0.1)",
          boxShadow: "0 24px 90px rgba(0, 0, 0, 0.35)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            opacity: 0.72,
          }}
        >
          Packaged Playback Verification
        </p>
        <h1 style={{ margin: "8px 0 16px", fontSize: 30 }}>Darktone Smoke Run</h1>
        <p style={{ margin: "0 0 20px", opacity: 0.82 }}>{analyzerError ?? statusMessage}</p>
        <div style={{ display: "grid", gap: 18 }}>
          <div ref={heroAnalyzerContainerRef} style={{ minHeight: 190, borderRadius: 18, overflow: "hidden" }} />
          <div ref={spectrumAnalyzerContainerRef} style={{ minHeight: 148, borderRadius: 18, overflow: "hidden" }} />
        </div>
      </section>
    </main>
  );
}
