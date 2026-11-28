import type { CloudLoginWindowApi } from '../../../shared/cloudLoginWindow';

/**
 * The cloud login window bridge: the whole API in the login window, open and completion in the
 * main window. Other windows have none; the pages that call this only mount where it exists.
 */
export function cloudLoginWindowApi(): CloudLoginWindowApi {
  const api = window.electronAPI?.cloudLoginWindow;
  if (!api) throw new Error('CLOUD_LOGIN_WINDOW_UNAVAILABLE');
  return api;
}

/** Instance operations for the main window, with first sign-in through the cloud login window. */
export function cloudInstancesApi() {
  const settings = window.electronAPI?.cloudSettings;
  if (!settings) throw new Error('CLOUD_SETTINGS_UNAVAILABLE');
  const login = cloudLoginWindowApi();
  return {
    ...settings,
    instanceInitialize: async ({ deviceId }: { deviceId: string }) => {
      await login.open({ deviceId });
    },
    onLoginCompleted: (cb: () => void) => login.onCompleted(cb),
  };
}
