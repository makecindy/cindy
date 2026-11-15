import { createDirectRtcRuntime, createDirectRuntimeHost } from '@cindy/device-link';
import type { DirectLinkHostApi } from '../shared/directLink';

/** No UI, media capture, filesystem or credentials in this data-only process. */
export function startDirectLinkHost(api: DirectLinkHostApi) {
  const host = createDirectRuntimeHost(createDirectRtcRuntime(), api.event);
  const off = api.onCommand((command) => { void host.command(command); });
  void api.register().catch(() => host.dispose());
  return () => { off(); host.dispose(); };
}
