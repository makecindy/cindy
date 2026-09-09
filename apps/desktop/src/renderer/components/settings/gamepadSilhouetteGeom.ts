/**
 * Geometry primitives for colleague gamepad SVGs (viewBox 0 0 1050 660).
 * Layout components own stroke/fill theming; these files are coordinates only.
 */

export type GamepadPaint = 'stroke' | 'fill';

interface GamepadGeomBase {
  paint: GamepadPaint;
  strokeWidth?: number;
}

export type GamepadGeom =
  | (GamepadGeomBase & { kind: 'path'; d: string })
  | (GamepadGeomBase & { kind: 'line'; x1: number; y1: number; x2: number; y2: number })
  | (GamepadGeomBase & { kind: 'polyline'; points: string })
  | (GamepadGeomBase & { kind: 'polygon'; points: string })
  | (GamepadGeomBase & { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number })
  | (GamepadGeomBase & { kind: 'circle'; cx: number; cy: number; r: number })
  | (GamepadGeomBase & {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      ry?: number;
      transform?: string;
    });
