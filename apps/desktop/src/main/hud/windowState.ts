/** Local geometry and transient motion; independent of Electron and chat state. */
export interface HudBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface HudWindowState {
  bounds: HudBounds | null;
}
export function normalizeHudWindowState(raw: unknown): HudWindowState {
  const bounds = (raw as Partial<HudWindowState> | null)?.bounds;
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    Math.abs(bounds.x) > 10000000 || Math.abs(bounds.y) > 10000000 ||
    bounds.width <= 0 || bounds.height <= 0 || bounds.width > 100000 || bounds.height > 100000
  ) return { bounds: null };
  return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
}
export function fitHudBounds(bounds: HudBounds, area: HudBounds): HudBounds {
  const width = Math.min(area.width, Math.max(420, bounds.width));
  const height = Math.min(area.height, Math.max(280, bounds.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}
/** Debounce OS movement bursts, persisting only the last actual HUD bounds. */
export function createHudWindowTracking(deps: {
  save(bounds: HudBounds): void;
  changed(): void;
}) {
  let last: HudBounds | null = null;
  let dirty = false;
  let moving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setMoving = (value: boolean) => {
    if (moving === value) return;
    moving = value;
    deps.changed();
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (dirty && last) {
      deps.save({ ...last });
      dirty = false;
    }
    setMoving(false);
  };
  return {
    isMoving: () => moving,
    start(bounds: HudBounds) {
      clearTimeout(timer);
      last = { ...bounds };
      dirty = true;
      setMoving(false);
      timer = setTimeout(flush, 200);
    },
    observe(bounds: HudBounds, positionChanged: boolean) {
      if (!last) return;
      const moved = bounds.x !== last.x || bounds.y !== last.y;
      if (!moved && bounds.width === last.width && bounds.height === last.height) return;
      last = { ...bounds };
      dirty = true;
      if (positionChanged && moved) setMoving(true);
      clearTimeout(timer);
      timer = setTimeout(flush, 200);
    },
    stop() {
      flush();
      last = null;
    },
  };
}
