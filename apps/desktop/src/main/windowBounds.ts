export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const DROP_WINDOW_POINTER_OFFSET = { x: 80, y: 24 };
const SESSION_DRAG_PREVIEW_POINTER_OFFSET = { x: 8, y: 8 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Window bounds use a half-open rectangle, matching Electron's screen space. */
export function isPointInWindowBounds(point: ScreenPoint, bounds: WindowBounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

export function isPointInsideAnyWindow(
  point: ScreenPoint,
  windows: readonly WindowBounds[],
): boolean {
  return windows.some((bounds) => isPointInWindowBounds(point, bounds));
}

/**
 * Place a newly detached task window with its title-bar area near the release
 * point, while keeping the complete window visible on the nearest display.
 */
export function resolveWindowBoundsNearPoint(
  point: ScreenPoint,
  requestedSize: Pick<WindowBounds, 'width' | 'height'>,
  workArea: WindowBounds,
): WindowBounds {
  const width = Math.min(Math.max(1, Math.round(requestedSize.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(requestedSize.height)), workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: clamp(Math.round(point.x - DROP_WINDOW_POINTER_OFFSET.x), workArea.x, maxX),
    y: clamp(Math.round(point.y - DROP_WINDOW_POINTER_OFFSET.y), workArea.y, maxY),
    width,
    height,
  };
}

/** Place the transient drag preview just below/right of the cursor. */
export function resolveSessionDragPreviewBounds(
  point: ScreenPoint,
  workArea: WindowBounds,
  requestedSize: Pick<WindowBounds, 'width' | 'height'> = { width: 320, height: 68 },
): WindowBounds {
  const width = Math.min(Math.max(1, Math.round(requestedSize.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(requestedSize.height)), workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: clamp(point.x + SESSION_DRAG_PREVIEW_POINTER_OFFSET.x, workArea.x, maxX),
    y: clamp(point.y + SESSION_DRAG_PREVIEW_POINTER_OFFSET.y, workArea.y, maxY),
    width,
    height,
  };
}
