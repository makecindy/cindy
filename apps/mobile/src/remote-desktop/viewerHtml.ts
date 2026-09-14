import { remoteDesktopViewerHtml as createHtml } from '@cindy/maker-shared/remote-desktop-mobile';
import { DESKTOP_KEY_CODES, REMOTE_DESKTOP_NETWORK, REMOTE_DESKTOP_ICE_SERVERS } from '@cindy/device-link';
export function remoteDesktopViewerHtml(surface: string, foreground: string): string {
  return createHtml(surface, foreground, {net: REMOTE_DESKTOP_NETWORK, iceServers: REMOTE_DESKTOP_ICE_SERVERS, keyCodes: DESKTOP_KEY_CODES});
}
