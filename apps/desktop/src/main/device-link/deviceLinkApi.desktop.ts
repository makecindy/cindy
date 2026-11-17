import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';
import { readCurrentDeviceDirectory, projectAgentNetDevice } from './agentNetDeviceDirectory.js';
import { createDeviceLinkApi } from './deviceLinkApi.js';
import * as agentNetRuntime from './agentNetRuntime.js';
import * as ownerScope from '../appSessionState.js';
import * as relayConfig from './selfHostedRelayConfig.js';

// The directory already loads these modules statically. Preserve the request's
// async preparation boundaries without reintroducing runtime module loading.
export const {
  resolveDeviceLinkApiBase, officialDeviceLinkApiBase,
  officialDeviceLinkApiFetch, deviceLinkApiFetch,
} = createDeviceLinkApi({
  getClientEndpoint: key => getClientEndpoint(key),
  serverApiFetch: (...args) => serverApiFetch(...args),
  activeSelfHostedRelay: () => activeSelfHostedRelay(),
  readCurrentDeviceDirectory: (...args) => readCurrentDeviceDirectory(...args),
  legacyDeviceView: (...args) => projectAgentNetDevice(...args),
  prepareAgentNetRuntime: async () => agentNetRuntime,
  prepareOwnerScope: async () => ownerScope,
  prepareRelayConfig: async () => relayConfig,
});
