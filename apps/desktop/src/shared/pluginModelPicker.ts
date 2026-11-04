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
