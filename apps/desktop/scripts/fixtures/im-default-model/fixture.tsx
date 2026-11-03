import { mountPage, subscription } from '../../ui-page/harness';
import { ImDefaultSettingsSection } from '../../../src/renderer/components/settings/ImDefaultSettingsSection';
import {
  IM_DEFAULT_SETTINGS,
  type ImDefaultSettingsPatch,
} from '../../../src/shared/imDefaultSettings';
import {
  resolveAutomaticImSettings,
  usesAutomaticImModel,
} from '../../../src/shared/imAutomaticModel';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
} from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';

const provider: ProviderView = {
  ...BUNDLED_CATALOG.providers.find((p) => p.id === 'openai')!,
  connected: true,
  agents: ['codex'],
  access: { kind: 'subscription' },
  models: {
    codex: [
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        contextWindow: 200000,
        group: 'gpt',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
    ],
  },
};

void mountPage({
  host: (ctx) => {
    const providers = ctx.case === 'im-unavailable' ? [] : [provider];
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), {
      dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation,
      providers,
      providerOrder: ['openai'],
    });
    let stored = structuredClone(IM_DEFAULT_SETTINGS);
    if (ctx.case === 'im-fixed') stored = resolveAutomaticImSettings(stored, providers)!;
    const state = () => ({
      ...(usesAutomaticImModel(stored)
        ? (resolveAutomaticImSettings(stored, providers) ?? stored)
        : stored),
      automaticModel: usesAutomaticImModel(stored),
      isCustomized: !usesAutomaticImModel(stored),
      customizedKeys: [],
      defaults: IM_DEFAULT_SETTINGS,
    });
    return {
      maker: {
        imDefaultSettingsGet: async () => state(),
        imDefaultSettingsSet: async (patch: ImDefaultSettingsPatch) => {
          stored = { ...stored, ...patch, agents: { ...stored.agents, ...patch.agents } };
          return state();
        },
        imDefaultSettingsReset: async () => {
          stored = structuredClone(IM_DEFAULT_SETTINGS);
          return state();
        },
        listAvailableAgents: async () => ['claude-code', 'codex', 'pi'],
        getCapabilities: async () => ({
          availableModels: provider.models.codex.map((m) => ({ ...m, displayName: m.name })),
          effortLevels: [],
          permissionModes: [{ id: 'auto', displayName: 'Auto' }],
          turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] },
        }),
        onProvidersChanged: subscription('providers'),
      },
    };
  },
  render: () => (
    <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
      <ImDefaultSettingsSection channel="discord" />
    </main>
  ),
});
