import { createDirectRtcRuntime, createDirectRuntimeHost } from '@cindy/device-link';
import type { DirectLinkHostApi } from '../shared/directLink';
import { createRtcTrafficObserver } from './rtcTraffic';

/** No UI, media capture, filesystem or credentials in this data-only process. */
export function startDirectLinkHost(api: DirectLinkHostApi) {
  const traffic = createRtcTrafficObserver(api.traffic);
  const host = createDirectRuntimeHost(createDirectRtcRuntime(traffic.observe), api.event);
  const off = api.onCommand((command) => { void host.command(command); });
  api.onFinishTraffic(() => {
    off();
    return traffic.finish(host.dispose);
  });
  void api.register().catch(() => host.dispose());
  return () => { off(); host.dispose(); };
}
