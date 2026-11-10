if (typeof globalThis.SharedArrayBuffer === 'undefined') {
  // Expo Go on iOS/Hermes does not expose SharedArrayBuffer, but some shared
  // JS packages probe the global during module initialization.
  globalThis.SharedArrayBuffer = ArrayBuffer;
}

require('./src/debug/quietDevLogs').installDevLogFilters();
if (__DEV__ && process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK === '1'
    && process.env.EXPO_PUBLIC_CINDY_AGENT_NET_SMOKE === '1') {
  void require('./src/debug/agentNetNativeSmoke').runAgentNetNativeSmoke();
}
require('expo-router/entry');
