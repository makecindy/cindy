import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import type { BotModelRoute } from '../../../src/shared/botModelChain';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { TeammatesSection } from '../../../src/renderer/features/bots/TeammatesSection';
import { TeammateSearchResults, useTeammateSearchMatches } from '../../../src/renderer/features/bots/TeammateSearchResults';
import { RemoteBotSessionView } from '../../../src/renderer/features/bots/RemoteBotSessionView';

const model = { id: 'fixture-model', name: 'Fixture model', efforts: [], defaultEffort: null };
const state = { recovered: false, profileReads: [] as string[], saved: null as { botId: string; actorId: string; route: BotModelRoute } | null };
Object.assign(window, { fixtureRecovery: state });
function Content() {
  const location = useLocation();
  const navigate = useNavigate();
  const matches = useTeammateSearchMatches('Mia', null);
  return <><TeammateSearchResults matches={matches} /><button onClick={() => navigate(-1)}>Fixture back</button><span hidden data-testid="fixture-route">{location.pathname + location.search}</span><Routes><Route path="/bots/remote/:deviceId/:botId" element={<RemoteBotSessionView />} /></Routes></>;
}
mountPage({
  route: '/bots',
  host: (ctx) => {
    const owner = getDataOwnerGeneration();
    const provider = { ...BUNDLED_CATALOG.providers.find(item => item.id === 'openai')!, connected: true,
      agents: ['codex'] as const, models: { codex: [model] } };
    commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation,
      providers: [provider], providerOrder: ['openai'] });
    return { localDb: { bots: {
    get: async (id: string) => { state.profileReads.push(id); return id === 'mia' && state.recovered ? ctx.data.profiles[0] : null; },
  } }, maker: {
    getCompanionCloudState: async () => null,
    listAvailableAgents: async () => ['codex'],
    getCapabilities: async () => ({ hasFastMode: false, availableModels: [{ ...model, displayName: model.name }],
      effortLevels: [], permissionModes: [{ id: 'auto', displayName: 'Auto' }] }),
    onProvidersChanged: subscription('providers'),
    saveCompanionRecoveryModel: async (botId: string, actorId: string, route: BotModelRoute) => {
      state.saved = { botId, actorId, route };
      return { ok: true };
    },
    getCompanionTranscript: async () => ({ messages: [
      { id: 'one', seq: '1', role: 'user', text: 'Synthetic question', createdAt: 1 },
      { id: 'two', seq: '2', role: 'assistant', text: 'Synthetic answer', createdAt: 2 },
    ] }),
    chatDisplayCache: async () => null,
    takeOverCompanion: forbid('maker.takeOverCompanion'),
    }, deviceLink: { invoke: forbid('deviceLink.invoke') } };
  },
  render: (ctx) => {
    Object.assign(window, { fixtureCompleteRecovery: () => {
      state.recovered = true;
      ctx.data.cloud = { ...ctx.data.cloud, demotedBotIds: [] };
      window.dispatchEvent(new Event('fixture-cloud-changed'));
    } });
    return <AppFrame header={false} sidebar={<TeammatesSection />}><Content /></AppFrame>;
  },
});
