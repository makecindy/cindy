import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { BotModelChainEditor } from '../../../src/renderer/features/bots/BotModelChainEditor';
import type { BotModelRoute } from '../../../src/shared/botModelChain';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { agentDeviceFavoriteSource } from '@cindy/device-link';
import { addModelFavorite } from '../../../src/renderer/state/modelFavorites';

const model = { id: 'available-model', name: 'Gemini with a very long model display name',
  contextWindow: 200000, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' };
const provider: ProviderView = { ...BUNDLED_CATALOG.providers.find(p => p.id === 'openai')!,
  connected: true, agents: ['codex'], access: { kind: 'subscription' }, models: { codex: [model] } };
const unknown: BotModelRoute = { harness: 'codex', model: 'google/gemini-4-argon', providerId: 'openai', effort: '', fastMode: false };
const sharedModels = [
  { ...model, id: unknown.model, name: 'Shared Gemini' },
  { ...model, id: 'gpt-6.1-terra', name: 'Shared Terra' },
];
const sharedProvider: ProviderView = { ...provider, remoteInvocationEnabled: true,
  agents: ['codex', 'pi'], models: { codex: sharedModels, pi: sharedModels } };
const isSharedCase = ctx.case.startsWith('shared-');

function Fixture() {
  const { t } = useTranslation();
  const primary = isSharedCase ? { ...unknown, agentDeviceId: 'share:fixture', effort: 'high' }
    : ctx.case === 'available' || ctx.case.startsWith('loading') ? { ...unknown, model: model.id, effort: 'high' } : unknown;
  // 伙伴只用一个模型(2026-11-26)。stored-backups：旧版本存下的多项链，编辑器只认第一项。
  const [routes, setRoutes] = useState<BotModelRoute[]>([primary,
    ...(ctx.case === 'stored-backups' ? Array.from({ length: 4 }, (_, i) => ({ ...unknown,
      model: `vendor/very-long-unbroken-model-identifier-${i}-abcdefghijklmnopqrstuvwxyz` })) : [])]);
  return <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <div className="mx-auto w-full max-w-[448px]" data-model-settings-fixture>
      <BotModelChainEditor value={routes} onChange={setRoutes} label={t('bots.model.primary')}
        layout={ctx.case === 'global-settings' ? 'settings' : 'inline'}
        settingsRows={{ primaryLabel: t('bots.model.primary'), primaryHint: t('modelGroups.buddies.defaultHint') }} />
    </div>
  </main>;
}

void mountPage({
  host: () => {
    const owner = getDataOwnerGeneration();
    const localProvider = ctx.case === 'shared-same-id' ? { ...provider,
      models: { codex: sharedModels.map(entry => ({ ...entry, name: `Local ${entry.name}`, efforts: ['low'], defaultEffort: 'low' })) } } : provider;
    const commitCatalog = () => commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation, providers: [localProvider], providerOrder: ['openai'] });
    if (ctx.case.startsWith('loading')) window.addEventListener('fixture:catalog-ready', commitCatalog, { once: true });
    else commitCatalog();
    if (ctx.case === 'loading-remote-favorite') addModelFavorite({
      providerId: agentDeviceFavoriteSource({ deviceId: 'fixture-device', providerId: 'openai' }),
      modelId: sharedModels[0]!.id, agent: 'codex', effort: 'high',
    });
    const capabilities = (shared: boolean) => ({
      hasFastMode: false,
      availableModels: (shared ? sharedModels : [model]).map(entry => ({ ...entry, displayName: entry.name })),
      effortLevels: [], permissionModes: [{ id: 'auto', displayName: 'Auto' }],
      turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] },
    });
    return { maker: {
      listPluginEngines: async () => ctx.case === 'plugin-primary' ? [{
        providerId: 'acp-plugin:sample:engine', key: 'sample:engine', ghostId: 'sample', harnessId: 'engine',
        name: 'Sample Engine', models: [{ id: 'sample-model', displayName: 'Sample Model' }],
        availability: { state: 'available' }, defaultPermissionMode: 'ask', permissionModes: [],
      }] : [],
      onPluginEnginesChanged: subscription('plugin-engines'),
      listAvailableAgents: async () => ['claude-code', 'codex', 'pi'],
      getCapabilities: async () => capabilities(false),
      onProvidersChanged: subscription('providers'),
    }, deviceLink: { invoke: async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [sharedProvider] };
      if (channel === 'maker:get-capabilities') return capabilities(true);
      throw new Error(`Unsupported fixture channel: ${channel}`);
    } } };
  },
  render: () => <Fixture />,
});
