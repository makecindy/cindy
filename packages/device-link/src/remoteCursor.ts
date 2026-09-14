/** Bounded raster cursor data, never markup or a remote URL. Sizes/hotspot in desktop points. */
export interface RemoteDesktopCursor {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  png: string;
}
export interface RemoteDesktopCursorFrame { jpeg: string; cursor: RemoteDesktopCursor | null }
export function isRemoteDesktopCursor(value: unknown): value is RemoteDesktopCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as RemoteDesktopCursor;
  return typeof v.visible === "boolean" &&
    [v.x, v.y, v.width, v.height, v.hotX, v.hotY].every(Number.isFinite) &&
    v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1 &&
    v.width > 0 && v.width <= 256 && v.height > 0 && v.height <= 256 &&
    v.hotX >= 0 && v.hotX <= v.width && v.hotY >= 0 && v.hotY <= v.height &&
    typeof v.png === "string" && v.png.length <= 65536 &&
    /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.png);
}
