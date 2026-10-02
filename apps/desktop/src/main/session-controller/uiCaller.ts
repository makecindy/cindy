import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { withSessionCaller } from './callerContext.js';

/** The transport authenticates its sender; domain ports never accept sender claims in JSON. */
export function withUiSessionCaller<T>(
  event: Parameters<typeof assertTrustedAppRendererEvent>[0],
  run: () => Promise<T>,
): Promise<T> {
  const remote = getDeviceLinkInvokeContext();
  return withSessionCaller({
    source: 'ui',
    assertCurrent: () => remote?.assertCurrent?.(),
    authorize: async () => {
      if (remote) await remote.revalidate?.();
      else assertTrustedAppRendererEvent(event);
    },
  }, run);
}
