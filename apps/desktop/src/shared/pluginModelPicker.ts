import type { PluginModelPickerRequest, PluginModelSelection } from '@cindy/device-link';
export type PluginModelPickerRoute = PluginModelSelection;
export {
  isPluginModelSelection as isPluginModelPickerRoute,
  type PluginModelPickerRequest,
} from '@cindy/device-link';

export interface PluginModelPickerOptions {
  allowRemote?: boolean;
  initial?: PluginModelPickerRoute;
  /** Host-issued origin; never use the most recently active phone. */
  mobilePageId?: string;
}

export interface PluginModelPickerPresentation extends PluginModelPickerRequest {
  deviceId?: string;
  remoteViewId?: string;
  /** Local page presentation, authored by Main, never sent over device-link. */
  pageAnchor?: { guestId: number; rect: PluginModelPickerRect; zoomFactor?: number };
}

export interface PluginModelPickerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page-local CSS pixels from the trigger's getBoundingClientRect(). */
export interface PluginPageModelPickerOptions {
  anchor: PluginModelPickerRect;
  initial?: PluginModelPickerRoute;
  /** New page API includes all execution sources by default. */
  allowRemote?: boolean;
}

export function isPluginModelPickerRect(value: unknown): value is PluginModelPickerRect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rect = value as Record<string, unknown>;
  return (
    Object.keys(rect).length === 4 &&
    ['x', 'y', 'width', 'height'].every(
      (key) =>
        typeof rect[key] === 'number' &&
        Number.isFinite(rect[key]) &&
        Math.abs(rect[key] as number) <= 100_000,
    ) &&
    (rect.width as number) > 0 &&
    (rect.height as number) > 0
  );
}

export type PluginModelPickerResult =
  | { ok: true; route: PluginModelPickerRoute }
  | {
      ok: false;
      errorCode:
        | 'INVALID_REQUEST'
        | 'PERMISSION_DENIED'
        | 'BUSY'
        | 'RATE_LIMITED'
        | 'CANCELLED'
        | 'UNAVAILABLE';
      message: string;
    };
