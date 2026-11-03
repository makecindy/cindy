import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 1,
  busy: false,
  preparing: false,
  profile: '',
  session: {} as Record<string, unknown>,
  anchor: {} as Record<string, unknown>,
  collect: vi.fn(),
  create: vi.fn(),
  capture: vi.fn(),
  broadcast: vi.fn(),
  project: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.profile } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => client }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => h.owner,
  isDataOwnerBroadcastScopeCurrent: (owner: number) => owner === h.owner,
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.create }));
vi.mock('../completion.js', () => ({ collectCindyMakeChanges: h.collect }));
vi.mock('../manager.js', () => ({
  cindyMakeManager: { isTaskPreparing: () => h.preparing, withProject: h.project },
}));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: async () => ({}),
  resolveMakeToolEnvironment: async () => ({}),
}));
vi.mock('../historyOwner.js', () => ({ captureMakeHistoryStore: () => ({}) }));
vi.mock('../historyCapture.js', () => ({ captureMakeHistoryCompletion: h.capture }));
vi.mock('../remoteBroadcast.js', () => ({ broadcastMakeRemoteChanged: h.broadcast }));
import { sessions } from '../../localDb/schema';
import { setSessionRouteLockImplementation } from '../../localDb/sessionRouteLock';
import { prepareCindyMakeTest } from '../testRecovery';
const client = {
  drizzle: {
    select: () => {
      let session = false;
      const query = {
        from: (table: unknown) => {
          session = table === sessions;
          return query;
        },
        where: () => query,
        orderBy: () => query,
        limit: async () => [structuredClone(session ? h.session : h.anchor)],
      };
      return query;
    },
  },
};
const prepare = () => prepareCindyMakeTest('task', 'reply', () => h.busy);
beforeEach(() => {
  vi.resetAllMocks();
  h.owner = 1;
  h.busy = false;
  h.preparing = false;
  h.profile = path.join(os.tmpdir(), 'make-recovery-test');
  h.session = {
    id: 'task',
    source: 'cindy-make',
    status: 'active',
    workingDir: path.join(h.profile, 'cindy-make', 'worktrees', 'run'),
    clearedAt: null,
  };
  h.anchor = {
    clientId: 'reply',
    role: 'assistant',
    createdAt: 100,
    agentMeta: JSON.stringify({ turnCompleted: true }),
  };
  h.project.mockImplementation(async (_root, run) => run());
  h.collect.mockResolvedValue({ commit: 'b'.repeat(40), tree: 'c'.repeat(40), changedFiles: 2 });
  h.create.mockImplementation(async (_id, body) => {
    h.anchor = { ...body, agentMeta: JSON.stringify(body.agentMeta) };
  });
  let tail = Promise.resolve();
  setSessionRouteLockImplementation((_id, run) => {
    const task = tail.then(run);
    tail = task.then(
      () => {},
      () => {},
    );
    return task;
  });
});
afterEach(() => setSessionRouteLockImplementation(null));

describe('native on-demand Make snapshot', () => {
  it.each(['reply', 'continued'])(
    'captures current files for an explicit action on a %s result',
    async (kind) => {
      if (kind === 'continued')
        h.anchor.agentMeta = JSON.stringify({
          cindyMakeCompletion: {
            reportedAt: 1,
            continuedAt: 2,
            commit: 'a'.repeat(40),
            personal: { status: 'ready' },
          },
        });
      const result = await prepare();
      expect(result.completionId).not.toBe('reply');
      expect(h.collect).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        h.profile,
        h.session.workingDir,
      );
      expect(h.create).toHaveBeenCalledWith(
        'task',
        expect.objectContaining({
          content: '',
          clientId: result.completionId,
          agentMeta: {
            cindyMakeCompletion: {
              reportedAt: expect.any(Number),
              commit: 'b'.repeat(40),
              tree: 'c'.repeat(40),
              changedFiles: 2,
            },
          },
        }),
        expect.objectContaining({ expectedClearBoundaryMs: null, broadcastOwnerScope: 1 }),
      );
      expect(h.capture).toHaveBeenCalledOnce();
      expect(h.broadcast).toHaveBeenCalledWith('task', 1);
    },
  );
  it('does not duplicate a snapshot when two controls click the same old result', async () => {
    const results = await Promise.allSettled([prepare(), prepare()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(h.collect).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it.each([
    { source: 'chat' },
    { status: 'archived' },
    { remoteHostId: 'ssh' },
    { workingDir: '/other' },
    { clearedAt: 100 },
  ])('rejects an ineligible task: %s', async (patch) => {
    Object.assign(h.session, patch);
    await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each([
    { role: 'user' },
    { clientId: 'newer-reply' },
    { agentMeta: JSON.stringify({ turnCompleted: false }) },
    { agentMeta: '{}' },
    { agentMeta: '{invalid' },
  ])('rejects a superseded or unfinished result: %s', async (patch) => {
    Object.assign(h.anchor, patch);
    await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.collect).not.toHaveBeenCalled();
  });
  it.each(['owner', 'message', 'workdir', 'busy', 'clear'])(
    'rechecks %s after collecting files and never publishes stale facts',
    async (change) => {
      h.collect.mockImplementationOnce(async () => {
        if (change === 'owner') h.owner++;
        if (change === 'message') h.anchor.clientId = 'new-message';
        if (change === 'workdir')
          h.session.workingDir = path.join(h.profile, 'cindy-make', 'worktrees', 'other');
        if (change === 'busy') h.busy = true;
        if (change === 'clear') h.session.clearedAt = 50;
        return { commit: 'a'.repeat(40) };
      });
      await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.capture).not.toHaveBeenCalled();
    },
  );
  it.each(['busy', 'preparing'])('does not capture while the task is %s', async (state) => {
    h[state as 'busy' | 'preparing'] = true;
    await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.collect).not.toHaveBeenCalled();
  });
  it('leaves editing untouched when files cannot be checked', async () => {
    h.collect.mockRejectedValueOnce(new Error('Git failed'));
    await expect(prepare()).rejects.toThrow('Git failed');
    expect(h.create).not.toHaveBeenCalled();
  });
});
