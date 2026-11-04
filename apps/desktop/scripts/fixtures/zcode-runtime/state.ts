export * from '../cindy-ai-identity/state';
import type { ProviderView } from '@cindy/model-providers';

const state = globalThis as typeof globalThis & { __zcodeUiConnected?: boolean };
export function setZCodeScenario(connected: boolean) { state.__zcodeUiConnected = connected; }
export const useProviders = () => ({
  providers: [{ id: 'zcode-native', name: 'ZCode', source: 'builtin', nativeAgent: 'zcode',
    agents: ['zcode'], auth: { method: 'managed' }, routing: {}, connected: state.__zcodeUiConnected === true,
    models: { zcode: state.__zcodeUiConnected ? [{ id: 'native-example', name: 'Example Team Model',
      mode: 'chat', contextWindow: 1000000, efforts: [], defaultEffort: null }] : [] },
  } as ProviderView],
  providerOrder: ['zcode-native'], ownerGeneration: 1, loading: false, refetch: async () => true,
});
