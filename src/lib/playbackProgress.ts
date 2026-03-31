import { useSyncExternalStore } from "react";
import type { PlaybackState } from "./types";

export type PlaybackProgress = Pick<PlaybackState, "currentTime" | "duration">;

const DEFAULT_PLAYBACK_PROGRESS: PlaybackProgress = {
  currentTime: 0,
  duration: 0,
};

let playbackProgressState: PlaybackProgress = DEFAULT_PLAYBACK_PROGRESS;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function isPlaybackProgressEqual(a: PlaybackProgress, b: PlaybackProgress) {
  return a.currentTime === b.currentTime && a.duration === b.duration;
}

export function getPlaybackProgress() {
  return playbackProgressState;
}

export function setPlaybackProgress(
  update: PlaybackProgress | ((state: PlaybackProgress) => PlaybackProgress),
) {
  const nextState = typeof update === "function" ? update(playbackProgressState) : update;
  if (isPlaybackProgressEqual(playbackProgressState, nextState)) {
    return playbackProgressState;
  }

  playbackProgressState = nextState;
  emitChange();
  return playbackProgressState;
}

export function resetPlaybackProgress() {
  return setPlaybackProgress(DEFAULT_PLAYBACK_PROGRESS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlaybackProgress<T = PlaybackProgress>(
  selector?: (state: PlaybackProgress) => T,
) {
  const select = selector ?? ((state: PlaybackProgress) => state as T);

  return useSyncExternalStore(
    subscribe,
    () => select(playbackProgressState),
    () => select(playbackProgressState),
  );
}
