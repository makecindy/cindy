export interface NativeTrackpadFrame {
  phase: 'begin' | 'change' | 'end' | 'cancel';
  width?: number;
  height?: number;
  touches: { id: number; x: number; y: number }[];
}

export function isNativeTrackpadFrame(value: unknown): value is NativeTrackpadFrame {
  if (!value || typeof value !== 'object') return false;
  const p = value as NativeTrackpadFrame;
  if (
    !['begin', 'change', 'end', 'cancel'].includes(p.phase) ||
    !Array.isArray(p.touches) ||
    p.touches.length > 2
  )
    return false;
  if (p.phase === 'begin' && p.touches.length !== 2) return false;
  if (['end', 'cancel'].includes(p.phase) && p.touches.length !== 0) return false;
  if (
    p.touches.length &&
    (!Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width! <= 0 || p.height! <= 0)
  )
    return false;
  const ids = new Set<number>();
  return p.touches.every((t) => {
    if (
      !t ||
      ![0, 1].includes(t.id) ||
      ids.has(t.id) ||
      !Number.isFinite(t.x) ||
      !Number.isFinite(t.y) ||
      t.x < 0 ||
      t.x > 1 ||
      t.y < 0 ||
      t.y > 1
    )
      return false;
    ids.add(t.id);
    return true;
  });
}
