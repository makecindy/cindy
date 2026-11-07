import type { ProviderView } from '@cindy/model-providers';
import i18n from '../../../src/renderer/i18n';
import { cindyAiAccountName, cindyAiAccountLogoKind } from '../../../src/shared/cindyAiPresentation';

// Stubbed hooks are separate modules; share only this public fixture selector.
const fixtureState = globalThis as typeof globalThis & { __cindyAiScenario?: string };
export const setScenario = (value: string) => { fixtureState.__cindyAiScenario = value === 'default' ? 'personal' : value; };
const user = () => fixtureState.__cindyAiScenario === 'personal'
  ? { membershipKind: 'personal' as const, orgSlug: null, orgName: null }
  : { membershipKind: 'org' as const, orgSlug: fixtureState.__cindyAiScenario === 'xd' ? 'xd' : 'example', orgName: 'Example International Game Studio' };

export const useAuth = () => ({ mode: 'cloud', dataOwnerId: 'fixture', dataOwnerGeneration: 1, user: user() });
export const useOptionalAuthDeviceId = () => 'fixture-device';
export const useOptionalAuthUser = () => user();
export const useProviders = () => ({
  providers: [{
    id: 'xd', name: cindyAiAccountName(user(), key => i18n.t(key)), source: 'builtin',
    logoKind: cindyAiAccountLogoKind(user()),
    agents: ['codex'], auth: { method: 'managed' }, routing: { codex: {} }, connected: true,
    models: { codex: [{ id: 'auto', name: 'Auto', group: 'gpt', contextWindow: 272000, efforts: [] }] },
  } as ProviderView],
  providerOrder: ['xd'], ownerGeneration: 1, loading: false, refetch: async () => true,
});
export const useApiKey = () => ({ key: 'fixture-key', hasSavedKey: true, clearKey: async () => true });
export const useModelAccessStatus = () => ({ state: 'ok', source: 'server', accountTier: null, endpoint: null });
export const useModelAccessCreditUsageResult = () => ({ usage: null, loading: false, refresh: async () => {} });
export const useClaudeAccountUsageResult = () => ({ usage: null, unlimited: true, loading: false, refresh: async () => {} });
export const useXdAssetPrimaryAction = () => null;
export const isChatGptConnectionConnected = () => false;
export const useCodexAuth = () => ({ state: { kind: 'unauthenticated' }, recoveryCheck: 'idle', refresh: async () => {} });
