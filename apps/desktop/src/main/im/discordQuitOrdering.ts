/**
 * Keep Device Link presence alive until the IM aggregate has closed Discord's
 * Gateway. The aggregate owns every personal IM transport, but this ordering
 * exists specifically to prevent a remote Desktop from taking over Discord
 * while the old Gateway is still finishing its normal shutdown.
 */
export async function stopImBeforeDeviceLink(
  stopIm: () => Promise<void>,
  stopDeviceLink: () => Promise<void>,
): Promise<void> {
  try {
    await stopIm();
  } finally {
    // Even a failed/expired IM shutdown must not leak the relay connection or
    // ownership row for the remainder of the process lifetime.
    await stopDeviceLink();
  }
}
