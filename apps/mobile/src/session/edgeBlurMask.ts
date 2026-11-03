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

/**
 * Mask geometry for a backdrop whose chrome sits at `edge` and whose feather faces the content.
 * `fadeInside` is how far the feather reaches back into the chrome; chrome whose own text runs
 * to its edge (the two-line chat identity) passes 0 so that text stays over solid blur.
 */
export function edgeBlurMask(chromeHeight: number, edge: 'top' | 'bottom', fadeInside: number = EDGE_BLUR_FADE_INSIDE): EdgeBlurMask {
  const height = chromeHeight + EDGE_BLUR_FADE_OUTSIDE;
  const fadeLength = Math.min(fadeInside, chromeHeight / 2) + EDGE_BLUR_FADE_OUTSIDE;
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

/** The header feather reaches further than the composer's, closer to the system soft scroll edge. */
export const HEADER_BLUR_FADE_OUTSIDE = spacing.xl;
/** Each of the three stacked header layers; together they read about as strong as one 55 layer. */
export const HEADER_BLUR_LAYER_INTENSITY = 32;
/** Where each layer's feather ends, as a share of the whole fade. */
const HEADER_BLUR_LAYER_REACH = [1 / 3, 2 / 3, 1] as const;

/**
 * Top chrome only: a progressive blur. Three equal blur layers start fading at the same point and
 * finish at a third, two thirds and the end of the fade, so the blur itself thins toward the
 * content instead of one sharp layer cross-fading over a clear one (which reads as a double image).
 */
export function headerBlurLayers(chromeHeight: number, fadeInside: number = EDGE_BLUR_FADE_INSIDE): EdgeBlurMask[] {
  const height = chromeHeight + HEADER_BLUR_FADE_OUTSIDE;
  const fadeLength = Math.min(fadeInside, chromeHeight / 2) + HEADER_BLUR_FADE_OUTSIDE;
  const start = 1 - fadeLength / height;
  return HEADER_BLUR_LAYER_REACH.map((reach) => ({
    height,
    colors: FADE_STOPS,
    startPoint: { x: 0.5, y: start },
    endPoint: { x: 0.5, y: start + reach * fadeLength / height },
  }));
}
