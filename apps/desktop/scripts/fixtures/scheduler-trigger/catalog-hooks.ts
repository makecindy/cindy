const models = [{ id: 'fixture-model', displayName: 'Fixture model', efforts: ['medium'] }];
const providers = [{ id: 'fixture', name: 'Fixture', connected: true, agents: ['codex'],
  routing: { codex: {} }, models: { codex: models } }];
const capabilities = { availableModels: models };

export const getCachedCapabilities = () => null;
export const useAgentCapabilities = () => ({ capabilities, loading: false });
export const useProviders = () => ({ providers, loading: false });
export const useDeviceProviders = useProviders;
