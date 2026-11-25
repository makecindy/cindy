import type { SupportedLocale } from './locale';
import type { CloudSettingsRendererApi } from './cloudSettingsClient';

/** Local window chrome only; these channels are not remote/device-link capabilities. */
export const CLOUD_LOGIN_WINDOW = {
  open: 'cloud-login-window:open',
  state: 'cloud-login-window:state',
  ready: 'cloud-login-window:ready',
  presented: 'cloud-login-window:presented',
  close: 'cloud-login-window:close',
  start: 'cloud-login-window:start',
  dispatch: 'cloud-login-window:dispatch',
  poll: 'cloud-login-window:poll',
  end: 'cloud-login-window:end',
  changed: 'cloud-login-window:changed',
  locale: 'cloud-login-window:locale',
  completed: 'cloud-login-window:completed',
} as const;

export interface CloudLoginWindowState {
  generation: number;
  target: { deviceId: string; name: string | null; ordinal: number | null } | null;
}
export type CloudLoginApi = Pick<
  CloudSettingsRendererApi,
  'instanceLoginStart' | 'instanceLoginDispatch' | 'instanceLoginPoll' | 'instanceLoginClose'
>;
export interface CloudLoginWindowApi {
  open(input: { deviceId: string }): Promise<void>;
  onCompleted(cb: () => void): () => void;
  getState(): Promise<CloudLoginWindowState>;
  rendererReady(): Promise<void>;
  presentationReady(): Promise<void>;
  close(generation: number): Promise<void>;
  onChanged(cb: (state: CloudLoginWindowState) => void): () => void;
  onLocaleChanged(cb: (locale: SupportedLocale) => void): () => void;
  start(generation: number): ReturnType<CloudLoginApi['instanceLoginStart']>;
  dispatch(
    generation: number,
    input: Parameters<CloudLoginApi['instanceLoginDispatch']>[0],
  ): ReturnType<CloudLoginApi['instanceLoginDispatch']>;
  poll(
    generation: number,
    input: { handle: string },
  ): ReturnType<CloudLoginApi['instanceLoginPoll']>;
  end(generation: number, input: { handle: string }): Promise<void>;
}
