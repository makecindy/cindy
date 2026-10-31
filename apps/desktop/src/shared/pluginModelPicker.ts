import type { PluginTaskRoute } from './pluginTasks.js';
import type { PluginModelPickerRequest } from '@cindy/device-link';
export {
  isPluginModelSelection as isPluginModelPickerRoute,
  type PluginModelPickerRequest,
} from '@cindy/device-link';

export interface PluginModelPickerOptions {
  initial?: PluginTaskRoute;
  /** Host-issued origin; never use the most recently active phone. */
  mobilePageId?: string;
}

export interface PluginModelPickerPresentation extends PluginModelPickerRequest {
  deviceId?: string;
  remoteViewId?: string;
}

export type PluginModelPickerResult =
  | { ok: true; route: PluginTaskRoute }
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
