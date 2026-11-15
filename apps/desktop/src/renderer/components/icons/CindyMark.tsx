import {
  CINDY_MARK_TRANSFORM,
  CINDY_MARK_PATH,
  CINDY_MARK_EARRING_PATH,
  CINDY_MARK_EARRING_COLOR,
} from '@cindy/model-providers/branding';

/** Chrome's compact Cindy artwork, with foreground inherited from the surrounding theme. */
export function CindyMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <g transform={CINDY_MARK_TRANSFORM}>
        <path d={CINDY_MARK_PATH} fill="currentColor" />
        <path d={CINDY_MARK_EARRING_PATH} fill={CINDY_MARK_EARRING_COLOR} />
      </g>
    </svg>
  );
}
