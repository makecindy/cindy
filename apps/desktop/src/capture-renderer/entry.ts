import { startFilePeerHost } from './filePeerHost';
import { startDirectLinkHost } from './directLinkHost';
import type { DirectLinkHostApi } from '../shared/directLink';
import type { FilePeerHostApi } from '../shared/filePeer';
import type { DesktopCaptureApi } from '../shared/remoteDesktop';
import { startDesktopCaptureHost } from '../renderer/features/remote-desktop/captureHost';

declare global {
  interface Window {
    desktopCapture: DesktopCaptureApi;
    filePeerHost?: FilePeerHostApi;
    directLinkHost?: DirectLinkHostApi;
  }
}
const dispose = window.directLinkHost ? startDirectLinkHost(window.directLinkHost) : window.filePeerHost
  ? startFilePeerHost(window.filePeerHost)
  : startDesktopCaptureHost(window.desktopCapture);
window.addEventListener('unload', dispose, { once: true });
