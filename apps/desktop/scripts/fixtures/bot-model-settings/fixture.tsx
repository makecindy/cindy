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

function Fixture() {
  const { t } = useTranslation();
  const primary = ctx.case === 'available' ? { ...unknown, model: model.id, effort: 'high' } : unknown;
  const [routes, setRoutes] = useState<BotModelRoute[]>([primary,
    ...Array.from({ length: ctx.case === 'four-backups' ? 4 : 1 }, (_, i) => ({ ...unknown,
      model: i ? `vendor/very-long-unbroken-model-identifier-${i}-abcdefghijklmnopqrstuvwxyz` : 'google/gemini-4-argon-backup' }))]);
  const [task, setTask] = useState<BotModelRoute | null>(ctx.case === 'inherited' ? null : { ...unknown, harness: 'pi' });
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
    commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation, providers: [provider], providerOrder: ['openai'] });
    return { maker: {
      listAvailableAgents: async () => ['claude-code', 'codex', 'pi'],
      getCapabilities: async () => ({ availableModels: [{ ...model, displayName: model.name }],
        effortLevels: [], permissionModes: [{ id: 'auto', displayName: 'Auto' }],
        turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] } }),
      onProvidersChanged: subscription('providers'),
    } };
  },
  render: () => <Fixture />,
});
