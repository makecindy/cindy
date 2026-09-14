import type { DesktopCaptureApi } from '../shared/remoteDesktop';
import { startDesktopCaptureHost } from '../renderer/features/remote-desktop/captureHost';

declare global {
  interface Window {
    desktopCapture: DesktopCaptureApi;
  }
}
const dispose = startDesktopCaptureHost(window.desktopCapture);
window.addEventListener('unload', dispose, { once: true });
