import { startFilePeerHost } from './filePeerHost';
import type { FilePeerHostApi } from '../shared/filePeer';
import type { DesktopCaptureApi } from '../shared/remoteDesktop';
import { startDesktopCaptureHost } from '../renderer/features/remote-desktop/captureHost';

declare global {
  interface Window {
    desktopCapture: DesktopCaptureApi;
    filePeerHost?: FilePeerHostApi;
  }
}
const dispose = window.filePeerHost
  ? startFilePeerHost(window.filePeerHost)
  : startDesktopCaptureHost(window.desktopCapture);
window.addEventListener('unload', dispose, { once: true });
