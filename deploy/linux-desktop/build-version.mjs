/** The image's cloud revision is also the Electron/package/renderer version.
 * This module is used only by the cloud image build, never by local releases. */
export function cloudAppVersion(value, upstream) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(upstream)
    || typeof value !== 'string' || !value.startsWith(`${upstream}-cloud.`)
    || !/^[1-9]\d*$/.test(value.slice(`${upstream}-cloud.`.length))) {
    throw new Error('CLOUD_APP_VERSION_MISMATCH');
  }
  return value;
}
