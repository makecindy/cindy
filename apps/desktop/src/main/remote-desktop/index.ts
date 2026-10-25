import { createRemoteDesktopPlatform } from './platform';
import { loadDesktopIceServers } from './iceConfig';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { readDeviceLinkSettings, writeDeviceLinkSetting } from '../device-link/settings-store';
import { getInputHandoffService } from '../input-handoff/service';
import { onQuit } from '../lifecycle';
import { getDeepLinkMainWindow } from '../deepLink';

export type { RemoteDesktopControllerDirectory } from './platform';
export const { remoteDesktop, requestRemoteDesktop, registerRemoteDesktopIpc } =
  createRemoteDesktopPlatform({
    readDeviceLinkSettings: () => readDeviceLinkSettings(),
    writeDeviceLinkSetting,
    loadDesktopIceServers,
    getInputHandoffService,
    onQuit,
    assertTrustedAppRendererEvent,
    showGuide: () => {
      const window = getDeepLinkMainWindow();
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    },
  });
