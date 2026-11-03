/** Keep the Reviewer on the source task's device, including while reconnecting. */
export async function startReviewOnDevice(
  request: Parameters<Window['electronAPI']['maker']['startReview']>[0],
  deviceId: string | null | undefined,
): Promise<void> {
  // Only an explicitly resolved local owner may use local IPC.
  if (deviceId === undefined || deviceId === '') {
    throw new Error('[DEVICE_LINK_NOT_CONNECTED] Review task ownership is unresolved');
  }
  if (deviceId !== null) {
    await window.electronAPI.deviceLink.invoke(deviceId, 'maker:review:start', [request]);
  } else {
    await window.electronAPI.maker.startReview(request);
  }
}
