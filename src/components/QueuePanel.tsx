import type { QueueItem, Track } from "../lib/types";
import { VirtualList } from "./VirtualList";

interface QueuePanelProps {
  open: boolean;
  queue: QueueItem[];
  currentIndex: number;
  tracksById: Map<string, Track>;
  onToggleOpen: () => void;
  onPlayIndex: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

export function QueuePanel({
  open,
  queue,
  currentIndex,
  tracksById,
  onToggleOpen,
  onPlayIndex,
  onMove,
  onRemove,
}: QueuePanelProps) {
  const queueEntries = queue.flatMap((item, index) => {
    const track = tracksById.get(item.trackId);
    return track ? [{ item, index, track }] : [];
  });

  return (
    <aside className={`queue-rail ${open ? "queue-rail--open" : ""}`}>
      <button className="queue-rail__toggle panel" onClick={onToggleOpen}>
        <span>Queue</span>
        <strong>{queue.length}</strong>
      </button>

      {open ? (
        <div className="queue panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Playback</p>
              <h2>Queue</h2>
            </div>
            <button className="icon-button" onClick={onToggleOpen}>
              Close
            </button>
          </div>

          <VirtualList
            items={queueEntries}
            className="queue__list"
            itemClassName="queue__item"
            virtualizationThreshold={20}
            getKey={({ item }) => item.queueId}
            getItemSize={() => 82}
            renderItem={({ index, track }) => (
              <div className={`queue-row ${currentIndex === index ? "queue-row--active" : ""}`}>
                <button className="queue-row__meta" onClick={() => onPlayIndex(index)}>
                  <strong>{track.title}</strong>
                  <span>
                    {track.artist} • {track.album}
                  </span>
                </button>
                <div className="queue-row__actions">
                  <button
                    className="icon-button"
                    onClick={() => onMove(index, Math.max(index - 1, 0))}
                    disabled={index === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => onMove(index, Math.min(index + 1, queue.length - 1))}
                    disabled={index === queue.length - 1}
                  >
                    ↓
                  </button>
                  <button className="icon-button" onClick={() => onRemove(index)}>
                    ×
                  </button>
                </div>
              </div>
            )}
          />
        </div>
      ) : null}
    </aside>
  );
}
