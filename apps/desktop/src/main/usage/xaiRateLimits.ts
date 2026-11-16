import type { XaiRateLimitSnapshot } from '../../shared/xaiRateLimit.js';

export const USAGE_XAI_RATE_LIMIT_CHANGED = 'usage:xai-rate-limit-changed';
export const USAGE_XAI_PROVIDER_RATE_LIMIT_CHANGED = 'usage:xai-provider-rate-limit-changed';

/** Account-scoped wire projection shared by local windows and remote clients. */
export function createXaiRateLimitPublisher(publish: (channel: string, payload: unknown) => void) {
  const send = (snapshot: XaiRateLimitSnapshot | null, providerId: string) => {
    if (providerId === 'xai') publish(USAGE_XAI_RATE_LIMIT_CHANGED, snapshot);
    else publish(USAGE_XAI_PROVIDER_RATE_LIMIT_CHANGED, { providerId, snapshot });
  };
  return {
    recordXaiRateLimitSnapshot(info: Omit<XaiRateLimitSnapshot, 'updatedAt'>, providerId = 'xai') {
      send({ ...info, updatedAt: Date.now() }, providerId);
    },
    clearXaiRateLimitSnapshot(providerId = 'xai') { send(null, providerId); },
  };
}
