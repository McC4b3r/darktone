import { formatTime } from "../lib/library";
import type { Album, PlaybackState, Track } from "../lib/types";

interface LibraryStageProps {
  album: Album | null;
  track: Track | null;
  playback: PlaybackState;
  queueCount: number;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onPlayAlbum: (album: Album) => void;
  onPlayTrack: (track: Track, album: Album) => void;
  onQueueTrack: (track: Track) => void;
}

export function LibraryStage({
  album,
  track,
  playback,
  queueCount,
  onTogglePlay,
  onPrevious,
  onNext,
  onPlayAlbum,
  onPlayTrack,
  onQueueTrack,
}: LibraryStageProps) {
  if (!album) {
    return null;
  }

  const spotlightTrack = track && track.album === album.title ? track : album.tracks[0] ?? null;
  const coverGlyph = album.title.slice(0, 1) || album.artist.slice(0, 1) || "•";
  const statTrack = track ?? spotlightTrack;
  const remaining = Math.max(playback.duration - playback.currentTime, 0);
  const mirroredBars = [...playback.spectrum.slice().reverse(), ...playback.spectrum];

  return (
    <section className="library-stage panel">
      <div className="library-stage__shell">
        <div className="library-stage__hero">
          <div className="library-stage__cover">
            <span>{coverGlyph}</span>
          </div>

          <div className="library-stage__details">
            <div className="library-stage__overlay">
              <p className="eyebrow">Now Playing</p>
              <h2>{statTrack?.title ?? album.title}</h2>
              <p className="library-stage__meta">{statTrack?.artist ?? album.artist}</p>
              <p className="library-stage__submeta">
                {album.title} • {statTrack?.format.toUpperCase() ?? "LOCAL"} • {formatTime(remaining)} left
              </p>
            </div>

            <div className="library-stage__transport">
              <button className="icon-button icon-button--transport" onClick={onPrevious} aria-label="Previous">
                ◀◀
              </button>
              <button
                className="button button--primary library-stage__play-toggle"
                onClick={onTogglePlay}
                aria-label={playback.isPlaying ? "Pause" : "Play"}
              >
                {playback.isPlaying ? "▮▮" : "▶"}
              </button>
              <button className="icon-button icon-button--transport" onClick={onNext} aria-label="Next">
                ▶▶
              </button>
            </div>

            <div className="library-stage__stats">
              <div className="stage-stat">
                <span className="stage-stat__label">Elapsed</span>
                <strong>{formatTime(playback.currentTime)}</strong>
              </div>
              <div className="stage-stat">
                <span className="stage-stat__label">Duration</span>
                <strong>{formatTime(playback.duration)}</strong>
              </div>
              <div className="stage-stat">
                <span className="stage-stat__label">Volume</span>
                <strong>{Math.round(playback.volume * 100)}%</strong>
              </div>
              <div className="stage-stat">
                <span className="stage-stat__label">Queue</span>
                <strong>{queueCount}</strong>
              </div>
              <div className="stage-stat">
                <span className="stage-stat__label">Mode</span>
                <strong>{playback.repeatMode}</strong>
              </div>
              <div className="stage-stat">
                <span className="stage-stat__label">Album</span>
                <strong>{album.trackCount}</strong>
              </div>
            </div>

            <div className="library-stage__actions">
              <button className="button button--primary" onClick={() => onPlayAlbum(album)}>
                Play Album
              </button>
              {spotlightTrack ? (
                <>
                  <button className="button" onClick={() => onPlayTrack(spotlightTrack, album)}>
                    Play Track
                  </button>
                  <button className="button" onClick={() => onQueueTrack(spotlightTrack)}>
                    Queue Track
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="library-stage__meter panel">
          <div className="library-stage__meter-head">
            <span className="eyebrow">Spectrum</span>
            <span className="library-stage__meter-time">
              {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
            </span>
          </div>
          <div className="library-stage__bars" aria-hidden="true">
            {mirroredBars.map((bar, index) => (
              <span
                key={index}
                className={`library-stage__bar ${bar > 0.14 ? "library-stage__bar--active" : ""}`}
                style={{ height: `${Math.max(4, Math.round(bar * 100))}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
