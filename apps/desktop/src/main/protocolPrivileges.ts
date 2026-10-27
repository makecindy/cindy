import { app, protocol, type CustomScheme } from 'electron';

/** Pure declarations: importing this early must not load auth, storage or handlers. */
function mediaPrivilege(scheme: string): CustomScheme {
  return {
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true,
      bypassCSP: false, stream: false, corsEnabled: false },
  };
}
export const imageSchemePrivilege = mediaPrivilege('xdt-image');
export const videoSchemePrivilege = mediaPrivilege('xdt-video');
export const localFileSchemePrivilege = mediaPrivilege('xdt-file');
export const audioFileSchemePrivilege = mediaPrivilege('xdt-audio');
export const modelSchemePrivilege = mediaPrivilege('xdt-model');
export const remoteMediaSchemePrivilege = mediaPrivilege('cindy-remote-media');
export const cindyGhostSchemePrivilege = mediaPrivilege('cindy-ghost');
export const cindyMediaSchemePrivilege = mediaPrivilege('cindy-media');
export const mcpAppSchemePrivilege: CustomScheme = {
  scheme: 'cindy-mcp-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

let registered = false;
/** Electron replaces this entire list per call. Declare once before any async startup barrier. */
export function registerDesktopSchemePrivileges(): void {
  if (registered) return;
  if (app.isReady()) throw new Error('PROTOCOL_PRIVILEGES_REGISTERED_AFTER_READY');
  protocol.registerSchemesAsPrivileged([
    { scheme: 'cindy-desktop-capture', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    imageSchemePrivilege,
    videoSchemePrivilege,
    localFileSchemePrivilege,
    audioFileSchemePrivilege,
    modelSchemePrivilege,
    remoteMediaSchemePrivilege,
    cindyGhostSchemePrivilege,
    cindyMediaSchemePrivilege,
    mcpAppSchemePrivilege,
  ]);
  registered = true;
}

/** A startup barrier can settle after Electron ready. The initializer must still run once. */
export function initializeAtElectronReady<T>(electronApp: { whenReady(): Promise<void> }, initialize: () => T): Promise<T> {
  return electronApp.whenReady().then(initialize);
}
