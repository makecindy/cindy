import { ipcRenderer } from 'electron';
import { CLOUD_LOGIN_WINDOW, type CloudLoginWindowApi } from '../shared/cloudLoginWindow';
import { CLOUD_CLIENT_CHANNELS } from '../shared/cloudSettingsChannels';
import type { CloudSettingsRendererApi } from '../shared/cloudSettingsClient';
import type { HostSettingsRendererApi } from '../shared/hostSettings';
import { readCloudWindowRole } from '../shared/cloudWindow';

/** What the main window may do with the cloud login window: open it and hear it finish. */
export type CloudLoginWindowOpener = Pick<CloudLoginWindowApi, 'open' | 'onCompleted'>;

/**
 * The cloud bridges for the main window, which Main marks with a launch argument. Every other
 * window that loads this preload gets none of them, and no window asks Main synchronously.
 */
export function cloudWindowBridges(argv: readonly string[]): {
  cloudLoginWindow?: CloudLoginWindowOpener;
  cloudSettings?: CloudSettingsRendererApi;
  hostSettings?: HostSettingsRendererApi;
} {
  const role = readCloudWindowRole(argv);
  if (!role) return {};
  return {
    cloudLoginWindow: {
      open: (input) => ipcRenderer.invoke(CLOUD_LOGIN_WINDOW.open, input),
      onCompleted: (cb) => {
        const listener = () => cb();
        ipcRenderer.on(CLOUD_LOGIN_WINDOW.completed, listener);
        return () => ipcRenderer.removeListener(CLOUD_LOGIN_WINDOW.completed, listener);
      },
    },
    cloudSettings: {
      instanceAccess: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceAccess, input),
      instanceList: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceList, input),
      instanceCapacity: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceCapacity, input),
      instanceClaim: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceClaim, input),
      instanceInitialize: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceInitialize, input),
      instanceLoginStart: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceLoginStart, input),
      instanceLoginDispatch: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceLoginDispatch, input),
      instanceLoginPoll: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceLoginPoll, input),
      instanceLoginClose: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceLoginClose, input),
      instanceRead: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceRead, input),
      instanceUpgrade: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instanceUpgrade, input),
      instancePower: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instancePower, input),
      instancePolicy: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.instancePolicy, input),
      open: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.open, input),
      read: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.read, input),
      save: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.save, input),
      receipt: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.receipt, input),
      manage: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.manage, input),
      cancelAuthorizations: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.cancelAuthorizations, input),
      close: (input) => ipcRenderer.invoke(CLOUD_CLIENT_CHANNELS.close, input),
    } satisfies CloudSettingsRendererApi,
    hostSettings: { hostOwned: role.instance },
  };
}
