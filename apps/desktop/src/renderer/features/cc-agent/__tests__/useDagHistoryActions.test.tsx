// @vitest-environment jsdom
// Renderer unit: a preview token cannot be redirected to a sibling with identical text;
// a lost reply must query that token, never submit another deletion.
import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { useDagHistoryActions } from '../useDagHistoryActions';
import type { DagNode } from '../session-dag/types';
vi.mock('../DagRecallDraft', () => ({ prepareDagRecall: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { getSnapshot: () => ({ messages: [] }) },
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const node: DagNode = {
  id: 'one',
  parentId: null,
  userMessageId: 'u1',
  sessionId: 's',
  question: '同文',
  answer: '答',
};
const sibling = { ...node, id: 'two', userMessageId: 'u2' };
const receipt = { operationId: 'op1', sessionId: 's', removedSessionIds: [], status: 'committed' };
function harness() {
  const api = {
    preview: vi.fn(async () => ({
      ...receipt,
      canCommit: true,
      clientId: 'u1',
      action: 'delete',
      turnCount: 1,
      branchCount: 0,
    })),
    commit: vi.fn(async () => receipt),
    undo: vi.fn(async () => ({ ...receipt, status: 'undone' })),
    status: vi.fn(async () => receipt),
  };
  vi.stubGlobal('electronAPI', {
    maker: { dagHistory: api },
    safeStorageRead: vi.fn(async () => null),
    safeStorageStore: vi.fn(async () => true),
  });
  const refresh = vi.fn();
  const { result } = renderHook(() =>
    useDagHistoryActions({
      key: 'view',
      ready: true,
      nodes: [node, sibling],
      writable: () => ({ id: 's' }) as Session,
      refresh,
    }),
  );
  return { api, result, refresh };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('refuses a sibling and commits the previewed card only once after an ambiguous transport response', async () => {
  const { api, result, refresh } = harness();
  const { token } = await result.current!.preview(node, 'delete');
  await expect(result.current!.commit(sibling, 'delete', token)).rejects.toThrow('预览');
  expect(api.commit).not.toHaveBeenCalled();
  api.commit.mockRejectedValueOnce(Error('connection lost'));
  await act(async () => {
    expect(await result.current!.commit(node, 'delete', token)).toEqual({ undoId: 'op1' });
  });
  expect(api.commit).toHaveBeenCalledOnce();
  expect(api.status).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledWith('s', [], false);
  await act(async () => {
    await result.current!.undo(token);
  });
  expect(api.undo).toHaveBeenCalledOnce();
});
it('refuses when the host cannot restore, rather than hiding a card', async () => {
  const { api, result, refresh } = harness();
  api.preview.mockResolvedValueOnce({
    ...receipt,
    canCommit: false,
    clientId: 'u1',
    action: 'delete',
    turnCount: 0,
    branchCount: 0,
  });
  await expect(result.current!.preview(node, 'delete')).rejects.toThrow('不能安全恢复');
  expect(refresh).not.toHaveBeenCalled();
  expect(api.commit).not.toHaveBeenCalled();
});
