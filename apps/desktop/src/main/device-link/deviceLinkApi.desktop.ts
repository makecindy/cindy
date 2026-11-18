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
  officialDeviceLinkApiFetch, officialDeviceListFetch, deviceLinkApiFetch,
} = createDeviceLinkApi({
  getClientEndpoint: key => getClientEndpoint(key),
  serverApiFetch: (...args) => serverApiFetch(...args),
  activeSelfHostedRelay: () => activeSelfHostedRelay(),
  readCurrentDeviceDirectory: (...args) => readCurrentDeviceDirectory(...args),
  legacyDeviceView: (...args) => projectAgentNetDevice(...args),
  managementScopeKey: () => JSON.stringify([ownerScope.activeOwnerScopeKey(), agentNetRuntime.agentNetSelectionKey()]),
  prepareAgentNetRuntime: async () => agentNetRuntime,
  prepareOwnerScope: async () => ownerScope,
  prepareRelayConfig: async () => relayConfig,
});

// Agent-Net 判断哪些设备在 Device Link 里删掉了时读的列表：官方服务、设备号与平台（packages/agent-net/src/membership.ts；平台用来知道
// 有哪些手机，Agent-Net 送不到的经 Device Link 补发推送，notifyFallback.ts）。
agentNetRuntime.useDeviceLinkDeviceList(async () => {
  const listed = await officialDeviceListFetch<{ devices?: Array<{ deviceId?: unknown; platform?: unknown }> }>({ timeoutMs: 10_000 });
  return Array.isArray(listed?.devices)
    ? listed.devices.flatMap(device => (typeof device?.deviceId === 'string'
      ? [{ deviceId: device.deviceId, platform: typeof device.platform === 'string' ? device.platform : null }] : []))
    : null;
});
