const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = function withAgentNetNative(config) {
  config = withInfoPlist(config, config => {
    config.modResults.NSBonjourServices = [...new Set([...(config.modResults.NSBonjourServices || []), '_cindy-agentnet._udp'])];
    config.modResults.NSLocalNetworkUsageDescription = 'Cindy finds your paired devices on this network so they can connect directly.';
    config.modResults.NSAppTransportSecurity = { ...(config.modResults.NSAppTransportSecurity || {}), NSAllowsLocalNetworking: true };
    return config;
  });
  // Android already permits 127.0.0.1 via cindy-html-preview's network policy.
  // Keep that existing policy and its release/debug trust settings intact.
  return withDangerousMod(config, ['ios', async (config) => {
    const script = path.resolve(config.modRequest.projectRoot, '../../packages/agent-net-native/build-ios.mjs');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    if (result.error || result.status !== 0) throw new Error('AGENT_NET_NATIVE_IOS_BUILD_FAILED');
    return config;
  }]);
};
