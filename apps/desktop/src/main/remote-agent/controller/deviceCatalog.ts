import type { AgentKind } from '@cindy/model-providers';
import { readRemoteProviderRoute as readRoute } from '@cindy/remote-agent/controller/deviceCatalog';
export { parseDeviceProviderViews, readDeviceProviderViews } from '@cindy/remote-agent/controller/deviceCatalog';

/** Desktop owns the transport; route validation is shared with the terminal host. */
export async function readRemoteProviderRoute(route: {
  agentDeviceId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string;
}) {
  const { remoteBackgroundInvoke } = await import('../../device-link');
  return readRoute(route, remoteBackgroundInvoke);
}
