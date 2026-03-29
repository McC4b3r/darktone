import type { QueueItem, RepeatMode, Track } from "./types";

function createQueueId(trackId: string, index: number) {
  return `${trackId}-${index}-${Math.random().toString(16).slice(2, 8)}`;
}

export function makeQueue(trackIds: string[]): QueueItem[] {
  return trackIds.map((trackId, index) => ({
    queueId: createQueueId(trackId, index),
    trackId,
  }));
}

export function moveQueueItem(queue: QueueItem[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) {
    return queue;
  }

  const next = [...queue];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function removeQueueItem(queue: QueueItem[], index: number) {
  if (index < 0 || index >= queue.length) return queue;
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

export function getQueueTrack(
  queue: QueueItem[],
  index: number,
  tracksById: Map<string, Track>,
) {
  const item = queue[index];
  if (!item) return null;
  return tracksById.get(item.trackId) ?? null;
}

export function getNextQueueIndex(
  queue: QueueItem[],
  currentIndex: number,
  repeatMode: RepeatMode,
  shuffle: boolean,
) {
  if (!queue.length) return -1;
  if (repeatMode === "one" && currentIndex >= 0) return currentIndex;

  if (shuffle && queue.length > 1) {
    const available = queue
      .map((_, index) => index)
      .filter((index) => index !== currentIndex);
    return available[Math.floor(Math.random() * available.length)];
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex < queue.length) return nextIndex;
  if (repeatMode === "all") return 0;
  return -1;
}

export function getPreviousQueueIndex(currentIndex: number, currentTime: number) {
  if (currentTime > 3) return currentIndex;
  return Math.max(currentIndex - 1, 0);
}
