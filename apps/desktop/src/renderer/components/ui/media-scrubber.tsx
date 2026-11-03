import { Slider } from './slider';

/** Seconds in/out; playback remains owned by the caller and its existing media bus. */
export function MediaScrubber({
  currentTime,
  duration,
  onSeek,
  label,
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  label: string;
}) {
  const seekable = Number.isFinite(duration) && duration > 0;
  const time = Number.isFinite(currentTime) ? Math.max(0, Math.min(duration, currentTime)) : 0;
  return (
    <Slider
      className="cindy-slider-media"
      aria-label={label}
      aria-valuetext={`${clock(time)} / ${clock(duration)}`}
      min={0}
      max={seekable ? duration : 1}
      step={0.01}
      value={[seekable ? time : 0]}
      disabled={!seekable}
      onValueChange={([next]) => {
        if (seekable) onSeek(next);
      }}
      onKeyDown={(event) => {
        if (!seekable) return;
        const delta = {
          ArrowRight: 1,
          ArrowUp: 1,
          ArrowLeft: -1,
          ArrowDown: -1,
          PageUp: 10,
          PageDown: -10,
        }[event.key];
        if (delta === undefined) return; // Radix supplies Home / End.
        event.preventDefault();
        onSeek(Math.max(0, Math.min(duration, time + delta)));
      }}
    />
  );
}

function clock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
