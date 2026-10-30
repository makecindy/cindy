import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { BotRosterView } from '../../../src/renderer/features/bots/BotRosterView';
import { BotTaskOriginHistory } from '../../../src/renderer/features/bots/BotTaskOriginHistory';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';

const source = { id: 'source', title: 'Novel', source: 'desktop', agentKind: 'codex', model: 'gpt-5.5',
  providerId: 'openai', effort: 'high', fastMode: false, workingDir: null } as Session;
const bot = { id: 'editor', name: 'Editor', sourceTask: { sourceSessionId: 'source', title: 'Novel',
  createdAt: 1000, workingDir: null } } as BotProfile;
const rows = [
  { id: 'a', clientId: 'a', sessionId: 'source', role: 'assistant', content: 'The narrator uses first person.',
    agentMeta: { turnCompleted: true }, createdAt: '2026-10-29T00:01:00Z' },
  { id: 'u', clientId: 'u', sessionId: 'source', role: 'user', content: 'Keep the narrator in first person.',
    createdAt: '2026-10-29T00:00:00Z' },
];
void mountPage({
  route: '/bots/editor',
  host: {
    localDb: { bots: { list: async () => [], getModelChainSettings: async () => ({ modelChain: [], isCustomized: false }) },
      messages: { list: async () => rows, onDeleted: subscription('deleted') },
      sessionsPush: { onPatched: subscription('patched') }, subagentRuns: { onChanged: subscription('subagents') } },
    maker: { onBotProfileChanged: subscription('bots'), onProvidersChanged: subscription('providers'),
      listAvailableAgents: async () => ['codex'], getCapabilities: async () => ({ availableModels: [], permissionModes: [] }) },
  },
  render: () => ctx.case === 'history'
    ? <main className="h-screen p-4"><BotTaskOriginHistory bot={bot} onOpenSession={() => {}} /></main>
    : <BotRosterView sourceTask={source} onClose={() => {}} onCreated={() => {}} />,
});
