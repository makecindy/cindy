import { useEffect } from 'react';
import { GhostToolCard } from '../../../src/renderer/components/chat/GhostToolCard';
import { PrRefsProvider, usePrActions } from '../../../src/renderer/contexts/PrRefsContext';
import { enableGhostCardTaskAutoArchive } from '../../../src/renderer/cindy-brain/ghostCardTaskArchive';
import { mountPage, ctx, subscription } from '../../ui-page/harness';
import cards from './cards.json';

// HTML snapshots emitted by cindy-github's renderPrCard; actual host canvas,
// PR provider, state filling and archive hints run unchanged.
const sessionId = 'pr-task-archive-preview';
const refs = [
  { id: 'host', owner: 'makecindy', repo: 'cindy', prNumber: 9213 },
  { id: 'plugin', owner: 'makecindy', repo: 'cindy-official-plugins', prNumber: 298 },
].map(ref => ({ ...ref, sessionId, firstSeenAt: 1, lastSeenAt: 1, url: '' }));
function Preview() {
  const { registerPrConsumer } = usePrActions();
  useEffect(() => registerPrConsumer(sessionId), [registerPrConsumer]);
  useEffect(() => enableGhostCardTaskAutoArchive(sessionId), []);
  return <div className="p-6 flex flex-col gap-5" style={{ maxWidth: 900, margin: '0 auto' }}>
    {cards.map((html, index) => <GhostToolCard key={index} callId={`archive-card-${index}`}
      ghostId="cindy-github" toolName="pr_card" toolInput={{}} html={html} height={124}
      running={false} sessionId={sessionId} />)}
  </div>;
}
void mountPage({
  host: {
    ghosts: {
      listSync: () => ({ ghosts: [] }), onChanged: subscription('ghostsChanged'),
      onCardUpdated: subscription('cardUpdated'), updateCardHeight: async () => ({}),
    },
    gitContext: {
      listAllPrRefs: async () => refs, listPrRefs: async () => refs,
      onPrRefsChanged: subscription('prRefsChanged'), onGithubConnected: subscription('githubConnected'),
      getPrStatuses: async () => refs.map((ref, index) => ({ ...ref, ok: true,
        status: index === 0 || ctx.data.allMerged ? 'merged' : 'open',
        title: '', htmlUrl: '', branch: '', unresolvedCount: 0,
        checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 },
        mergeState: 'CLEAN', reviewDecision: 'APPROVED',
      })),
    },
  },
  render: () => <PrRefsProvider><Preview /></PrRefsProvider>,
});
