import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUpstreamMergeSession, assertUpstreamMergeSession } from '../upstreamMergeSession';
import { mergeWorktree } from '../upstreamMerge';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import { setMainLocale } from '../../i18n';

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
const userData = path.resolve('fake-data');
const createdAt = new Date(2026, 8, 20, 14, 7).getTime();
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
  title: '09-19 09:00 Resolve Source Update Conflicts',
};
beforeEach(() => {
  setMainLocale('en');
  h.reads.length = 0;
  h.current = true;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(createdAt);
  h.insert.mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());
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
        title: '09-20 14:07 Resolve Source Update Conflicts',
        createdAt,
        workingDir: normalizeWorkingDirForStorage(row.workingDir),
        model: 'test-model',
      }),
    );
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(h.insert.mock.invocationCallOrder[0]);
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.dispatch.mock.calls[0][1]).toContain('确保不丢失本地已有功能');
    expect(h.dispatch.mock.calls[0][1]).toContain(state.upstreamCommit);
  });
  it('distinguishes later conflicts of the same kind using their own creation times', async () => {
    await ensureUpstreamMergeSession(userData, state, undefined, vi.fn(), () => true);
    const later = new Date(2026, 8, 21, 0, 3).getTime();
    vi.mocked(Date.now).mockReturnValue(later);
    await ensureUpstreamMergeSession(userData, state, undefined, vi.fn(), () => true);
    expect(h.insert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: '09-20 14:07 Resolve Source Update Conflicts',
        createdAt,
      }),
    );
    expect(h.insert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: '09-21 00:03 Resolve Source Update Conflicts',
        createdAt: later,
      }),
    );
  });
  it.each([
    {
      locale: 'en',
      titles: [
        'Resolve Source Update Conflicts',
        'Resolve Integration Conflicts',
        'Resolve Undo Integration Conflicts',
      ],
    },
    {
      locale: 'zh-CN',
      titles: ['处理源码更新冲突', '处理合入冲突', '处理撤销合入冲突'],
    },
    {
      locale: 'zh-TW',
      titles: ['處理原始碼更新衝突', '處理合入衝突', '處理撤銷合入衝突'],
    },
    {
      locale: 'ja',
      titles: [
        'ソース更新時の競合を解決',
        '取り込み時の競合を解決',
        '取り込み取り消し時の競合を解決',
      ],
    },
    {
      locale: 'ko',
      titles: ['소스 업데이트 충돌 해결', '반영 충돌 해결', '반영 취소 충돌 해결'],
    },
  ] as const)(
    'creates localized conflict titles with their local creation time in $locale',
    async ({ locale, titles }) => {
      setMainLocale(locale);
      for (const action of [undefined, 'integrate', 'reapply', 'revert'] as const) {
        await ensureUpstreamMergeSession(
          userData,
          {
            ...state,
            feature: action
              ? {
                  action,
                  runId: 'feature-run',
                  taskSessionId: 'feature-task',
                  taskTree: 'c'.repeat(40),
                  steps: [],
                  nextStep: 0,
                }
              : undefined,
          },
          { agentKind: 'codex' },
          vi.fn(),
          () => true,
        );
        expect(h.insert).toHaveBeenLastCalledWith(
          expect.objectContaining({
            title: `09-20 14:07 ${titles[action === undefined ? 0 : action === 'revert' ? 2 : 1]}`,
            createdAt,
          }),
        );
      }
    },
  );
  it('reopens an existing task without changing its timestamp or dispatching the first message twice', async () => {
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
    expect(row.title).toBe('09-19 09:00 Resolve Source Update Conflicts');
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
