const models = [{ id: 'fixture-model', displayName: 'Fixture model', defaultEnabled: true, efforts: ['medium'] }];
const providers = [{ id: 'fixture', name: 'Fixture', connected: true, agents: ['codex'],
  auth: { method: 'oauth', native: 'codex' }, source: 'builtin', access: { kind: 'subscription' },
  routing: { codex: {} }, models: { codex: models } }];
const capabilities = { availableModels: models };

export const getCachedCapabilities = () => null;
export const evictDeviceCapabilities = () => {};
export const prefetchDeviceCapabilities = async () => {};
export const refreshLocalCapabilities = async () => {};
export const useAgentCapabilities = () => ({ capabilities, loading: false });
export const useProviders = () => ({ providers, loading: false });
export const useDeviceProviders = useProviders;
