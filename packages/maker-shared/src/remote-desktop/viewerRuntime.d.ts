/** Browser-only adapter. No React, Electron, credentials or device-link ownership. */
export function mountRemoteDesktopViewer(
  root: Document | HTMLElement,
  post: (message: Record<string, unknown>) => void,
  config: { net: object; iceServers: readonly object[]; keyCodes: readonly string[]; desktop?: boolean },
): { receive(message: object): void; dispose(): void };
