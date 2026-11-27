import { DeviceLinkError, DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1, type LinkAcceptPayload } from '@cindy/device-link';

const HISTORY_VIEW_CHANNELS = new Set([
  'local-db:messages:view',
  'local-db:messages:work-details',
  'local-db:messages:view-intent',
]);

/** Negotiate before sending projection requests; legacy reads and reachability stay independent. */
export async function invokeWithHistoryViewCapability<T>(
  channel: string,
  openLink: () => Promise<LinkAcceptPayload>,
  invoke: () => Promise<T>,
  legacyHistoryConfirmation?: true,
): Promise<T> {
  // The original Host exposed the page read before advertising history-view-v1.
  // Only outbox confirmation can probe that page; details and intents stay negotiated.
  if (HISTORY_VIEW_CHANNELS.has(channel) && !(legacyHistoryConfirmation && channel === 'local-db:messages:view')) {
    const accepted = await openLink();
    if (!accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1)) {
      // Use the existing unavailable path to retire memory/disk projections and
      // read the raw message window. Do not turn connection failures into fallback.
      throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', '[CHANNEL_NOT_ALLOWED] History view is unavailable');
    }
  }
  return invoke();
}
