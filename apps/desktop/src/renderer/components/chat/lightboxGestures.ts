/**
 * Pure gesture math shared by the full-screen lightboxes (MermaidLightbox,
 * ImageLightbox).
 *
 * These helpers are side-effect free so the wheel/pinch behaviour can be unit
 * tested without a DOM: the React components own the stateful glue (refs,
 * listeners, timers) and delegate the arithmetic here. Per-surface scale
 * bounds are passed in by callers (e.g. images do not zoom below fit while
 * mermaid diagrams may shrink to 0.2x).
 */

/** Current transform of the lightbox stage: `scale` plus a center-origin translate. */
export interface LightboxViewport {
  scale: number;
  tx: number;
  ty: number;
}

/** Zoom focal point, expressed relative to the stage center (the transform origin). */
export interface LightboxPoint {
  cx: number;
  cy: number;
}

export const LIGHTBOX_MIN_SCALE = 0.2;
export const LIGHTBOX_MAX_SCALE = 8;
export const LIGHTBOX_ZOOM_STEP = 1.2;
// Continuous-zoom slope for `exp(-deltaY * k)`. Tuned against trackpad PINCH
// (small per-event deltas, well under the clamp), where ~0.01 is the common
// "natural" feel — a comfortable pinch reaches ~300%. It also drives ctrl/⌘
// +mouse-wheel, where the clamped notch (deltaY=40) becomes ~exp(0.4)≈+49%/notch.
export const LIGHTBOX_ZOOM_WHEEL_SENSITIVITY = 0.01;
export const LIGHTBOX_WHEEL_DELTA_CLAMP = 40;
export const LIGHTBOX_WHEEL_IDLE_MS = 120;

const WHEEL_DELTA_PIXEL = 0;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_PAGE_HEIGHT_PX = 800;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Clamp a scale into the lightbox's allowed zoom range. */
export function clampScale(
  value: number,
  min = LIGHTBOX_MIN_SCALE,
  max = LIGHTBOX_MAX_SCALE,
) {
  return clamp(value, min, max);
}

/**
 * Normalize a wheel delta to pixels. Line- and page-mode wheels (rare in
 * Chromium, but possible with some mice) are scaled up so zoom and pan feel
 * consistent regardless of the event's delta unit. Pixel-mode deltas (trackpad,
 * most mice) pass through unchanged.
 */
export function normalizeWheelDelta(delta: number, deltaMode: number) {
  if (deltaMode === WHEEL_DELTA_LINE) return delta * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === WHEEL_DELTA_PAGE) return delta * WHEEL_PAGE_HEIGHT_PX;
  return delta;
}

/**
 * Continuous zoom factor for one wheel event: `exp(-deltaY * sensitivity)`.
 * deltaY is normalized to pixels then clamped, so a single coarse mouse notch
 * can't jump the zoom while a stream of small pinch deltas stays smooth.
 * Negative deltaY (pinch-out / scroll-up) returns >1 (zoom in); positive <1.
 */
export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number = WHEEL_DELTA_PIXEL,
  sensitivity = LIGHTBOX_ZOOM_WHEEL_SENSITIVITY,
  maxDelta = LIGHTBOX_WHEEL_DELTA_CLAMP,
) {
  const normalizedDeltaY = normalizeWheelDelta(deltaY, deltaMode);
  const clampedDeltaY = clamp(normalizedDeltaY, -maxDelta, maxDelta);
  return Math.exp(-clampedDeltaY * sensitivity);
}

/**
 * Apply `factor` to the viewport's scale while keeping the content point under
 * `point` visually fixed (focal zoom). Returns the SAME viewport reference when
 * the scale is already clamped at a bound, so callers can skip a no-op update.
 */
export function zoomAtPoint(
  viewport: LightboxViewport,
  point: LightboxPoint,
  factor: number,
  min = LIGHTBOX_MIN_SCALE,
  max = LIGHTBOX_MAX_SCALE,
): LightboxViewport {
  const nextScale = clampScale(viewport.scale * factor, min, max);
  if (nextScale === viewport.scale) return viewport;

  const ratio = nextScale / viewport.scale;
  return {
    scale: nextScale,
    tx: point.cx - (point.cx - viewport.tx) * ratio,
    ty: point.cy - (point.cy - viewport.ty) * ratio,
  };
}

/** Physical device behind a wheel event, as far as it can be inferred. */
export type WheelInputSource = 'mouse' | 'trackpad';

/** The wheel event fields the source heuristic reads (legacy `wheelDeltaY` is Chromium-only). */
export interface WheelSample {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  wheelDeltaY?: number;
}

/** A gap longer than this starts a new wheel stream (re-classified from scratch). */
export const WHEEL_SOURCE_IDLE_MS = 250;

/**
 * Best-effort guess of whether one wheel event came from a mouse wheel or a
 * multi-touch surface (trackpad / precision touchpad). Browsers expose no
 * device type, so this combines the signals that hold in Chromium:
 *
 * - line/page delta units only come from wheels;
 * - a horizontal component without Shift is a two-finger scroll (wheels only
 *   scroll sideways with Shift or a tilt wheel);
 * - macOS accelerated wheels produce fractional pixel deltas, trackpads whole ones;
 * - Chromium encodes the legacy `wheelDeltaY` as ±120 per wheel notch, and as
 *   `-3 × deltaY` for continuous (precise) scrolling devices.
 *
 * Anything undecided counts as a mouse wheel, i.e. keeps the zoom behaviour.
 */
export function classifyWheelSample(e: WheelSample): WheelInputSource {
  if (e.deltaMode !== WHEEL_DELTA_PIXEL) return 'mouse';
  if (e.deltaX !== 0 && !e.shiftKey) return 'trackpad';
  if (!Number.isInteger(e.deltaY)) return 'mouse';
  const legacy = e.wheelDeltaY;
  if (typeof legacy === 'number' && legacy !== 0) {
    if (legacy % 120 === 0) return 'mouse';
    if (legacy === -3 * e.deltaY) return 'trackpad';
  }
  return 'mouse';
}

/**
 * Classify once per wheel stream so a gesture never flips mid-way (e.g. the
 * momentum tail of a two-finger fling). A later horizontal component upgrades a
 * stream to trackpad. `now` is the event timestamp in ms.
 */
export function createWheelSourceTracker(idleMs = WHEEL_SOURCE_IDLE_MS) {
  let source: WheelInputSource | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  return (e: WheelSample, now: number): WheelInputSource => {
    if (source === null || now - lastAt > idleMs) {
      source = classifyWheelSample(e);
    } else if (source === 'mouse' && e.deltaMode === WHEEL_DELTA_PIXEL && e.deltaX !== 0 && !e.shiftKey) {
      source = 'trackpad';
    }
    lastAt = now;
    return source;
  };
}

/** What a single wheel event should do in the image lightbox. */
export type ImageLightboxWheelIntent = 'zoom' | 'pan' | 'none';

/**
 * Route one wheel event for ImageLightbox, the same on every OS:
 *
 * - pinch (Chromium delivers it as wheel + ctrlKey), ⌘/Ctrl + wheel, and a plain
 *   mouse wheel zoom at the cursor;
 * - a two-finger scroll on a trackpad pans while zoomed in and does nothing at
 *   fit scale.
 */
export function imageLightboxWheelIntent(
  event: { ctrlKey: boolean; metaKey: boolean; deltaX: number; deltaY: number },
  source: WheelInputSource,
  scale: number,
): ImageLightboxWheelIntent {
  if (event.ctrlKey || event.metaKey || source === 'mouse') {
    return event.deltaY === 0 ? 'none' : 'zoom';
  }
  if (scale <= 1 || (event.deltaX === 0 && event.deltaY === 0)) return 'none';
  return 'pan';
}
