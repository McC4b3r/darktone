import { describe, expect, it } from "vitest";
import { getNextQueueIndex, getPreviousQueueIndex, makeQueue, moveQueueItem, removeQueueItem } from "./queue";

describe("queue helpers", () => {
  it("creates queue items for track ids", () => {
    const queue = makeQueue(["a", "b"]);
    expect(queue).toHaveLength(2);
    expect(queue[0].trackId).toBe("a");
  });

  it("moves queue items", () => {
    const queue = makeQueue(["a", "b", "c"]);
    const moved = moveQueueItem(queue, 0, 2);
    expect(moved.map((item) => item.trackId)).toEqual(["b", "c", "a"]);
  });

  it("removes queue items", () => {
    const queue = makeQueue(["a", "b", "c"]);
    const trimmed = removeQueueItem(queue, 1);
    expect(trimmed.map((item) => item.trackId)).toEqual(["a", "c"]);
  });

  it("loops correctly for repeat all", () => {
    const queue = makeQueue(["a", "b"]);
    expect(getNextQueueIndex(queue, 1, "all", false)).toBe(0);
  });

  it("restarts the current track when enough time has elapsed", () => {
    expect(getPreviousQueueIndex(2, 4)).toBe(2);
    expect(getPreviousQueueIndex(2, 1)).toBe(1);
  });
});
