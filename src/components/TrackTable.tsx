import { formatDuration } from "../lib/library";
import type { Track } from "../lib/types";

interface TrackTableProps {
  tracks: Track[];
  currentTrackId: string | null;
  title: string;
  subtitle: string;
  onPlayTrack: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onPlayNext: (track: Track) => void;
}

export function TrackTable({
  tracks,
  currentTrackId,
  title,
  subtitle,
  onPlayTrack,
  onAddToQueue,
  onPlayNext,
}: TrackTableProps) {
  return (
    <section className="track-table panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Now Browsing</p>
          <h2>{title}</h2>
        </div>
        <p className="section-heading__meta">{subtitle}</p>
      </div>

      <div className="track-table__head">
        <span>#</span>
        <span>Title</span>
        <span>Album</span>
        <span>Length</span>
        <span>Actions</span>
      </div>

      <div className="track-table__body">
        {tracks.map((track, index) => {
          const isCurrent = currentTrackId === track.id;
          return (
            <div
              key={track.id}
              className={`track-row ${isCurrent ? "track-row--active" : ""}`}
              onDoubleClick={() => onPlayTrack(track)}
            >
              <span className="track-row__index">{track.trackNumber ?? index + 1}</span>
              <div className="track-row__title">
                <strong>{track.title}</strong>
                <span>{track.artist}</span>
              </div>
              <span className="track-row__album">{track.album}</span>
              <span className="track-row__duration">{formatDuration(track.durationMs)}</span>
              <div className="track-row__actions">
                <button className="button button--ghost" onClick={() => onPlayTrack(track)}>
                  Play
                </button>
                <button className="button button--ghost" onClick={() => onPlayNext(track)}>
                  Next
                </button>
                <button className="button button--ghost" onClick={() => onAddToQueue(track)}>
                  Queue
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
