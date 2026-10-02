import { spacing } from '@/theme/tokens';

/**
 * The feather straddles the chrome edge: it begins inside the chrome and only
 * reaches a short way past it, so content starts to soften as it arrives at the
 * chrome rather than well before it.
 */
export const EDGE_BLUR_FADE_INSIDE = spacing.xl;
export const EDGE_BLUR_FADE_OUTSIDE = spacing.lg;

/**
 * Mask opacity from fully blurred to clear along a smoothstep curve. A linear
 * ramp reads as a visible band at both of its ends; easing both ends lets the
 * frosting emerge from transparent instead. Ordered from the chrome side.
 */
const FADE_STOP_COUNT = 9;
const FADE_STOPS = Array.from({ length: FADE_STOP_COUNT }, (_, index) => {
  const t = index / (FADE_STOP_COUNT - 1);
  const opacity = 1 - t * t * (3 - 2 * t);
  return `rgba(0, 0, 0, ${opacity.toFixed(3)})`;
});

export interface EdgeBlurMask {
  /** Backdrop height: the chrome plus the outside feather. */
  height: number;
  /** Mask colors encode alpha only; they never tint the content. */
  colors: string[];
  /** Unit points; outside them the end colors extend. */
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
}

/** Mask geometry for a backdrop whose chrome sits at `edge` and whose feather faces the content. */
export function edgeBlurMask(chromeHeight: number, edge: 'top' | 'bottom'): EdgeBlurMask {
  const height = chromeHeight + EDGE_BLUR_FADE_OUTSIDE;
  const fadeLength = Math.min(EDGE_BLUR_FADE_INSIDE, chromeHeight / 2) + EDGE_BLUR_FADE_OUTSIDE;
  const fadeFraction = fadeLength / height;
  return edge === 'top'
    ? {
      height,
      colors: FADE_STOPS,
      startPoint: { x: 0.5, y: 1 - fadeFraction },
      endPoint: { x: 0.5, y: 1 },
    }
    : {
      height,
      colors: [...FADE_STOPS].reverse(),
      startPoint: { x: 0.5, y: 0 },
      endPoint: { x: 0.5, y: fadeFraction },
    };
}
