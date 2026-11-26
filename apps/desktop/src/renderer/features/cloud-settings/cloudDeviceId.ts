/** Device ids CIS assigns to managed cloud instances; dependency-free so startup code can test ids. */
export const isCloudDeviceId = (deviceId: string | null | undefined): deviceId is string =>
  !!deviceId && /^cloud-device-[a-f0-9]{24}$/.test(deviceId);
