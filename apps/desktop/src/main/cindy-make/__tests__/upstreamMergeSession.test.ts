import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUpstreamMergeSession, assertUpstreamMergeSession } from '../upstreamMergeSession';
import { mergeWorktree } from '../upstreamMerge';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';

const h = vi.hoisted(() => {
  const reads: unknown[][] = [];
  const insert = vi.fn(async (_row: unknown) => {});
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => reads.shift() ?? [] }) }) }),
    insert: () => ({ values: insert }),
  };
  return {
    reads,
    insert,
    client: { drizzle: db },
    dispatch: vi.fn(async (..._args: unknown[]) => {}),
    emit: vi.fn(),
    current: true,
  };
});
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => h.client }));
vi.mock('../taskRuntime.js', () => ({ dispatchCindyMakeMergeTask: h.dispatch }));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({ emitSessionCreated: h.emit }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'alice' }),
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
vi.mock('../../sessionIds.js', () => ({ createBusinessSessionId: () => 'new-merge-task' }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
const userData = path.resolve('fake-data');
const state: CindyMakeMergeState = {
  id: '12345678-1234-1234-1234-123456789abc',
  status: 'conflict',
  ref: 'main',
  upstreamCommit: 'a'.repeat(40),
  baselineCommit: 'b'.repeat(40),
  hasWorkspace: true,
};
const row = {
  id: 'old-task',
  source: 'cindy-make-merge',
  status: 'active',
  workingDir: mergeWorktree(userData, state.id),
  remoteHostId: null,
  clearedAt: null,
  agentKind: 'codex',
};
beforeEach(() => {
  h.reads.length = 0;
  h.current = true;
  vi.clearAllMocks();
  h.insert.mockImplementation(async () => {});
});
describe('dedicated upstream merge session', () => {
  it('creates the new source, binds before INSERT, preserves preferences, and sends a trusted first request', async () => {
    const bind = vi.fn();
    await ensureUpstreamMergeSession(
      userData,
      state,
      { agentKind: 'codex', model: 'test-model' },
      bind,
      () => true,
    );
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'cindy-make-merge',
        workingDir: normalizeWorkingDirForStorage(row.workingDir),
        model: 'test-model',
      }),
    );
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(h.insert.mock.invocationCallOrder[0]);
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.dispatch.mock.calls[0][1]).toContain('确保不丢失本地已有功能');
    expect(h.dispatch.mock.calls[0][1]).toContain(state.upstreamCommit);
  });
  it('reopens an existing task without dispatching the first message twice', async () => {
    h.reads.push([row], [{ id: 'first-message' }]);
    expect(
      await ensureUpstreamMergeSession(
        userData,
        { ...state, sessionId: row.id },
        undefined,
        vi.fn(),
        () => true,
      ),
    ).toBe(row.id);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('keeps the workspace and creates a new task only after explicitly reopening removed work', async () => {
    h.reads.push([{ ...row, status: 'deleted' }], []);
    expect(
      await ensureUpstreamMergeSession(
        userData,
        { ...state, sessionId: row.id },
        undefined,
        vi.fn(),
        () => true,
      ),
    ).toBe('new-merge-task');
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: normalizeWorkingDirForStorage(row.workingDir),
        source: 'cindy-make-merge',
      }),
    );
  });
  it('never sends into an account switched during creation', async () => {
    h.insert.mockImplementation(async () => {
      h.current = false;
    });
    await expect(
      ensureUpstreamMergeSession(userData, state, undefined, vi.fn(), () => true),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
  it('does not apply results from a deleted or repurposed task', async () => {
    for (const changed of [
      { ...row, status: 'deleted' },
      { ...row, source: 'cindy-make' },
      { ...row, workingDir: '/unrelated' },
    ]) {
      h.reads.push([changed]);
      await expect(
        assertUpstreamMergeSession(userData, { ...state, sessionId: row.id }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
});
