import { resolveRemoteInvokeTimeoutMs } from '@cindy/device-link';
export { MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS, MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS } from '@cindy/device-link';

export function resolveMobileInvokeTimeoutMs(channel: string, args?: unknown[]): number | undefined {
  return resolveRemoteInvokeTimeoutMs(channel, args, 'mobile');
}
