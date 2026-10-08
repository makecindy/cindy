import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 'owner',
  meta: {} as Record<string, unknown>,
  visible: true,
  patch: vi.fn(),
  broadcast: vi.fn(),
  jobs: [] as Array<() => Promise<void>>,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../localDb/client/current.js', () => {
  const db = { queryOne: async () => (h.visible ? { meta: JSON.stringify(h.meta) } : undefined) };
  return { getDbClient: () => db };
});
vi.mock('../../localDb/ipc/messages.js', () => ({
  patchMessageAgentMetaWithResult: h.patch,
  broadcastMessageAgentMetaUpdate: h.broadcast,
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  enqueueDurableWrite: (_: unknown, job: () => Promise<void>) => {
    h.jobs.push(job);
    return Promise.resolve();
  },
}));
import { learningReceiptPublisher } from '../botLearningFeedback.js';
const memory = {
  kind: 'memory' as const,
  key: 'preference',
  title: 'Preference',
  action: 'created' as const,
};
async function drain() {
  for (const job of h.jobs.splice(0)) await job();
}
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 'owner';
  h.meta = {};
  h.visible = true;
  h.jobs = [];
  h.patch.mockImplementation(async (_s, _r, patch) => {
    Object.assign(h.meta, patch);
    return {};
  });
});
it('merges receipts onto the original durable message and pushes that full row', async () => {
  const publish = learningReceiptPublisher('session');
  publish('original-reply', [memory]);
  publish('original-reply', [{ kind: 'skill', key: 'report', title: 'Report', action: 'updated' }]);
  await drain();
  expect(h.meta.botLearning).toEqual([memory, expect.objectContaining({ kind: 'skill' })]);
  expect(h.patch).toHaveBeenLastCalledWith('session', 'original-reply', {
    botLearning: h.meta.botLearning,
  });
  expect(h.broadcast).toHaveBeenLastCalledWith('session', 'original-reply', undefined);
});
it('drops queued publication on account switch, source removal, and hidden replies', async () => {
  const publish = learningReceiptPublisher('session');
  publish('reply', [memory]);
  h.owner = 'other';
  await drain();
  h.owner = 'owner';
  publish('reply', [memory]);
  h.visible = false;
  await drain();
  h.visible = true;
  h.meta = { botPrivateReply: {} };
  publish('reply', [memory]);
  await drain();
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.broadcast).not.toHaveBeenCalled();
});
