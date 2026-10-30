import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { BotModelChainEditor } from '../../../src/renderer/features/bots/BotModelChainEditor';
import { BotTaskModelEditor } from '../../../src/renderer/features/bots/BotTaskModelEditor';
import type { BotModelRoute } from '../../../src/shared/botModelChain';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';

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
    : ctx.case === 'available' ? { ...unknown, model: model.id, effort: 'high' } : unknown;
  const [routes, setRoutes] = useState<BotModelRoute[]>([primary,
    ...Array.from({ length: ctx.case === 'four-backups' ? 4 : 1 }, (_, i) => ({ ...(isSharedCase ? primary : unknown),
      model: isSharedCase ? sharedModels[1]!.id
        : i ? `vendor/very-long-unbroken-model-identifier-${i}-abcdefghijklmnopqrstuvwxyz` : 'google/gemini-4-argon-backup' }))]);
  const [task, setTask] = useState<BotModelRoute | null>(ctx.case === 'inherited' ? null : { ...(isSharedCase ? primary : unknown), harness: 'pi' });
  return <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <div className="mx-auto w-full max-w-[448px]" data-model-settings-fixture>
      <BotModelChainEditor value={routes} onChange={setRoutes} label={t('bots.model.primary')}
        layout={ctx.case === 'global-settings' ? 'settings' : 'inline'}
        settingsRows={{ primaryLabel: t('bots.model.primary'), primaryHint: t('bots.modelChain.description') }} />
      <BotTaskModelEditor value={task} inheritedRoute={routes[0]} onChange={setTask} />
    </div>
  </main>;
}

void mountPage({
  host: () => {
    const owner = getDataOwnerGeneration();
    const localProvider = ctx.case === 'shared-same-id' ? { ...provider,
      models: { codex: sharedModels.map(entry => ({ ...entry, name: `Local ${entry.name}`, efforts: ['low'], defaultEffort: 'low' })) } } : provider;
    commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation, providers: [localProvider], providerOrder: ['openai'] });
    const capabilities = (shared: boolean) => ({
      hasFastMode: false,
      availableModels: (shared ? sharedModels : [model]).map(entry => ({ ...entry, displayName: entry.name })),
      effortLevels: [], permissionModes: [{ id: 'auto', displayName: 'Auto' }],
      turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] },
    });
    return { maker: {
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
