import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppFrame, forbid, mountPage } from '../../ui-page/harness';
import { TeammatesSection } from '../../../src/renderer/features/bots/TeammatesSection';
import { TeammateSearchResults, useTeammateSearchMatches } from '../../../src/renderer/features/bots/TeammateSearchResults';
import { RemoteBotSessionView } from '../../../src/renderer/features/bots/RemoteBotSessionView';

function Content() {
  const location = useLocation();
  const navigate = useNavigate();
  const matches = useTeammateSearchMatches('Mia', null);
  return <><TeammateSearchResults matches={matches} /><button data-ui-page-control onClick={() => navigate(-1)}>Fixture back</button><span hidden data-testid="fixture-route">{location.pathname + location.search}</span><Routes><Route path="/bots/remote/:deviceId/:botId" element={<RemoteBotSessionView />} /></Routes></>;
}
mountPage({
  route: '/bots',
  host: () => ({ maker: {
    getCompanionCloudState: async () => null,
    getCompanionTranscript: async () => ({ messages: [
      { id: 'one', seq: '1', role: 'user', text: 'Synthetic question', createdAt: 1 },
      { id: 'two', seq: '2', role: 'assistant', text: 'Synthetic answer', createdAt: 2 },
    ] }),
    chatDisplayCache: async () => null,
    takeOverCompanion: forbid('maker.takeOverCompanion'),
  }, deviceLink: { invoke: forbid('deviceLink.invoke') } }),
  render: (ctx) => {
    Object.assign(window, { fixtureCompleteRecovery: () => {
      ctx.data.cloud = { ...ctx.data.cloud, demotedBotIds: [] };
      window.dispatchEvent(new Event('fixture-cloud-changed'));
    } });
    return <AppFrame header={false} sidebar={<TeammatesSection />}><Content /></AppFrame>;
  },
});
