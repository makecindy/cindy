import { useTranslation } from 'react-i18next';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { AuxiliaryModelSection } from '../../../src/renderer/components/settings/AuxiliaryModelSection';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { encodeRemoteAuxiliaryModelRef } from '../../../src/shared/remoteAuxiliaryModelRef';
import type { AuxiliaryModelSettingsState } from '../../../src/shared/auxiliaryModelSettings';

const model = { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', contextWindow: 200000,
  efforts: ['low', 'medium', 'high'], defaultEffort: 'low', mode: 'chat' as const, defaultEnabled: true };
const remoteModels = [model,
  { ...model, id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek v4 Flash' },
  { ...model, id: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash' }];
const local: ProviderView = { ...BUNDLED_CATALOG.providers.find((provider) => provider.id === 'openai')!,
  id: 'local-api', name: '本机 API', source: 'user', auth: { method: 'none' }, connected: true,
  agents: ['codex'], access: undefined, models: { codex: [model] },
  routing: { codex: { upstream: 'http://127.0.0.1:0/v1', authStrategy: 'none', wireProtocol: 'openai-responses' } } };
const remote: ProviderView = { ...local, id: 'magpie-preview', name: 'MacMiniMagpie', remoteInvocationEnabled: true,
  agents: ['codex', 'pi'], models: { codex: remoteModels, pi: remoteModels } };
const deviceId = 'preview-mini';
const localPin = 'cat:local-api:codex:gpt-5.4-mini';
const remotePin = encodeRemoteAuxiliaryModelRef({ deviceId, providerId: remote.id, agentKind: 'codex', model: model.id });
const allowedRoutes = remote.agents.flatMap((agentKind) => (remote.models[agentKind] ?? []).map((entry) => ({ providerId: remote.id, agentKind, model: entry.id })));

function Fixture() {
  const { t } = useTranslation();
  return <main className="h-screen overflow-auto bg-[var(--surface)] p-8 text-[var(--text-primary)]">
    <div className="mx-auto w-full max-w-[840px]" data-auxiliary-preview>
      <h1 className="mb-6 text-20 font-semibold">{t('settings.tabs.personalization')}</h1>
      <AuxiliaryModelSection />
    </div>
  </main>;
}

void mountPage({
  host: () => {
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation,
      providers: [local], providerOrder: [local.id] });
    let selected = ctx.case === 'pick-remote' ? [localPin] : [remotePin, localPin];
    const settings = (): AuxiliaryModelSettingsState => ({
      models: selected, defaults: { models: [] }, isCustomized: true, customizedKeys: ['models'],
      options: [{ id: localPin, label: 'GPT-5.4 mini · 本机 API', group: '本机 API', providerId: local.id,
        agentKind: 'codex', modelId: model.id, modelName: model.name, available: true,
        budget: false, subscription: false, agentSuffix: 'Codex', defaultEnabled: true }],
    });
    return {
      maker: {
        auxiliaryModelSettingsGet: async () => settings(),
        auxiliaryModelSettingsSet: async ({ models }: { models: string[] }) => { selected = models; return settings(); },
        onProvidersChanged: subscription('providers'),
        listAvailableAgents: async () => ['codex', 'pi'],
        getCapabilities: async () => ({ hasFastMode: false, availableModels: [model], effortLevels: [], permissionModes: [] }),
      },
      deviceLink: {
        getState: async () => ({ remoteControlEnabled: true, linkStatus: 'online', controlledBy: [] }),
        listDevices: async () => ({ devices: [{ deviceId, name: 'Mac Mini', isSelf: false, online: true,
          platform: 'darwin', remoteControlEnabled: true, controlEnabled: true }] }),
        onPresenceChanged: subscription('presence'), onControlTargetChanged: subscription('control-target'),
        invoke: async (_device: string, channel: string) => {
          if (channel === 'maker:provider:list') return { providers: [remote], providerOrder: [remote.id], modelVisibilityOverrides: {} };
          if (channel === 'maker:utility-text:v1') return { version: 1, op: 'caps', ok: true, hostEpoch: 'preview-epoch', allowedRoutes };
          if (channel === 'maker:get-capabilities') return { hasFastMode: false, availableModels: remoteModels, effortLevels: [], permissionModes: [] };
          if (channel === 'maker:list-available-agents') return ['codex', 'pi'];
          return [];
        },
      },
    };
  },
  render: () => <Fixture />,
});
