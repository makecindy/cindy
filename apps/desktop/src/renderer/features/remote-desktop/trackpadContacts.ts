import type { NativeTrackpadFrame } from '../../../shared/nativeTrackpad';

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };

/** Two fingers on the device picture, as positions in it (0..1). */
export interface DeviceContacts {
  phase: NativeTrackpadFrame['phase'];
  touches: { id: number; x: number; y: number }[];
}

/**
 * Turns the trackpad's two real fingers into two touches on a device picture,
 * the same way Main does for a plugin page (`main/nativeTrackpad.ts`): the
 * pair lands around the cursor, both axes move by the trackpad's physical
 * proportions against the picture's long edge (so pinch ratios and angles
 * survive, and a portrait picture does not squeeze sideways travel), and a
 * finger stops at the picture's edge without saving up the overshoot.
 */
export function createTrackpadContactMapper() {
  let gesture: {
    rect: Rect;
    centre: Point;
    anchor: Point;
    ratio: number;
    distance: number;
    points: (Point & { id: number })[];
    raw: NativeTrackpadFrame['touches'];
  } | null = null;
  return {
    /** `rect` is the picture and `pointer` the cursor, both in client pixels. */
    map(frame: NativeTrackpadFrame, rect: Rect, pointer: Point): DeviceContacts | null {
      if (frame.phase === 'cancel') {
        const active = gesture;
        gesture = null;
        return active ? { phase: 'cancel', touches: [] } : null;
      }
      if (frame.phase === 'begin') {
        const [a, b] = frame.touches;
        if (
          rect.width < 2 ||
          rect.height < 2 ||
          pointer.x < rect.x ||
          pointer.x >= rect.x + rect.width ||
          pointer.y < rect.y ||
          pointer.y >= rect.y + rect.height
        ) {
          gesture = null;
          return null;
        }
        gesture = {
          rect,
          centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          anchor: { ...pointer },
          ratio: frame.height! / frame.width!,
          distance: Math.max(rect.width, rect.height),
          points: [],
          raw: [],
        };
      }
      const g = gesture;
      if (!g) return null;
      const clip = (v: number, min: number, max: number) =>
        Math.max(min + 0.5, Math.min(max - 0.5, v));
      const r = g.rect;
      const points = frame.touches.map((p) => {
        const previous = g.points.find((t) => t.id === p.id);
        const raw = g.raw.find((t) => t.id === p.id);
        const origin = previous && raw ? previous : g.anchor;
        const from = previous && raw ? raw : g.centre;
        return {
          id: p.id,
          x: clip(origin.x + (p.x - from.x) * g.distance, r.x, r.x + r.width),
          y: clip(origin.y + (p.y - from.y) * g.distance * g.ratio, r.y, r.y + r.height),
        };
      });
      g.raw = frame.touches;
      g.points = points;
      if (frame.phase === 'end') gesture = null;
      return {
        phase: frame.phase,
        touches: points.map((p) => ({
          id: p.id,
          x: (p.x - r.x) / r.width,
          y: (p.y - r.y) / r.height,
        })),
      };
    },
    reset(): void {
      gesture = null;
    },
  };
}
