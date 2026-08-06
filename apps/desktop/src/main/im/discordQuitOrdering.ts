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

/**
 * Keep the DbClient alive through Device Link ownership release. The ownership
 * DELETE uses that client, so disposing it concurrently would force surviving
 * Desktop instances to wait for the stale-owner timeout before taking over.
 */
export async function stopImAndDeviceLinkBeforeDbClient(
  stopIm: () => Promise<void>,
  stopDeviceLink: () => Promise<void>,
  stopDbClient: () => Promise<void>,
): Promise<void> {
  try {
    await stopImBeforeDeviceLink(stopIm, stopDeviceLink);
  } finally {
    // Run even when an earlier shutdown step rejects, but never before Device
    // Link has finished its ownership release attempt.
    await stopDbClient();
  }
}

/**
 * The lifecycle async phase is time-bounded. If it advances to post-async while
 * Discord/Device Link cleanup is still running, local DB close must keep
 * waiting instead of racing the ownership DELETE that still needs DbClient.
 */
export async function closeLocalDbAfterDiscordShutdown(
  discordShutdown: Promise<void>,
  closeLocalDb: () => void | Promise<void>,
): Promise<void> {
  await discordShutdown.catch(() => undefined);
  await closeLocalDb();
}
