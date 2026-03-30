import type { LibraryScanProgress } from "../lib/types";

interface SyncStatusCardProps {
  loading: boolean;
  isSyncing: boolean;
  message: string;
  progress: LibraryScanProgress | null;
}

function formatProgressLabel(progress: LibraryScanProgress | null) {
  if (!progress) return null;

  if (progress.phase === "discovering") {
    return `${progress.current} track${progress.current === 1 ? "" : "s"} found`;
  }

  if (!progress.total) {
    return "Preparing index";
  }

  const percent = Math.min(100, Math.round((progress.current / progress.total) * 100));
  return `${percent}% complete`;
}

export function SyncStatusCard({ loading, isSyncing, message, progress }: SyncStatusCardProps) {
  const progressValue =
    progress?.phase === "scanning" && progress.total && progress.total > 0
      ? Math.min(100, (progress.current / progress.total) * 100)
      : null;
  const progressLabel = formatProgressLabel(progress);
  const busy = loading || isSyncing;

  return (
    <section className={`sync-status panel ${busy ? "sync-status--active" : ""}`}>
      <div className="sync-status__head">
        <div>
          <p className="eyebrow">Library Sync</p>
          <h2 className="sync-status__title">{busy ? "Updating your collection" : "Library ready"}</h2>
        </div>
        <div className="sync-status__badge">
          <span className={`status-dot ${busy ? "status-dot--active" : "status-dot--idle"}`} aria-hidden="true" />
          <span>{busy ? "Syncing" : "Idle"}</span>
        </div>
      </div>

      <p className="sync-status__message">{message}</p>

      {progress ? (
        <div className="sync-status__details">
          {progressLabel ? <span>{progressLabel}</span> : null}
          <span>
            {progress.foldersCompleted} of {progress.folderCount} folder{progress.folderCount === 1 ? "" : "s"} traversed
          </span>
        </div>
      ) : null}

      <div
        className={`sync-status__bar ${
          progressValue === null && busy ? "sync-status__bar--indeterminate" : ""
        }`}
        aria-hidden="true"
      >
        <span style={progressValue === null ? undefined : { width: `${progressValue}%` }} />
      </div>
    </section>
  );
}
