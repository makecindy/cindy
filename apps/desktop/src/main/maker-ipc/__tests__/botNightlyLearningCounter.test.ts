/**
 * 夜间学习计数的真实入口 countNightlyLearningTurn。计数决定到点是否调用模型，口径错了要么白花
 * 用量，要么把例行任务的产出、群里旁人的话当成主人的对话学进去（2026-10-23 主人裁决）。
 */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as null | { botId: string; role: string; createdAt: number; meta: string; inputMeta: string | null; inputContent?: string },
  record: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/owner',
}));
vi.mock('../../localDb/client/current.js', () => {
  const db = { queryOne: vi.fn(async () => h.row && { ...h.row }) };
  return { getDbClient: () => db };
});
vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: async () => {},
  enqueueDurableWrite: async (_key: string, run: () => unknown) => run(),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  patchMessageAgentMetaWithResult: async (_s: string, _r: string, patch: Record<string, unknown>) => {
    h.row!.meta = JSON.stringify({ ...JSON.parse(h.row!.meta), ...patch });
    return {};
  },
}));
vi.mock('../botNightlyLearningState.js', () => ({ recordNightlyLearningTurn: h.record }));

import { countNightlyLearningTurn } from '../botNightlyLearningCounter.js';

const owner = JSON.stringify({ imSource: { origin: { sender: { isOwner: true } } } });
beforeEach(() => {
  vi.clearAllMocks();
  h.row = { botId: 'bot', role: 'canonical', createdAt: 1000, meta: JSON.stringify({ turnCompleted: true }), inputMeta: '{}' };
});

it('counts an owner turn once even when the terminal is replayed', async () => {
  await countNightlyLearningTurn('main', 'reply');
  await countNightlyLearningTurn('main', 'reply');
  expect(h.record).toHaveBeenCalledOnce();
  expect(h.record).toHaveBeenCalledWith('/owner', 'bot', 'main', 1000);
});

it.each([
  ['a routine run', { inputMeta: JSON.stringify({ origin: { kind: 'scheduler', scheduleId: 'routine-x' } }) }],
  ['a guest in an IM channel', { role: 'channel', inputMeta: JSON.stringify({ imSource: { origin: { sender: { isOwner: false } } } }) }],
  ['a subagent reply', { meta: JSON.stringify({ turnCompleted: true, parentUuid: 'p' }) }],
  ['an unfinished turn', { meta: JSON.stringify({}) }],
  // 真机验收发现：新伙伴的开场问候由隐藏的 [UI_ACTION_TRIGGER] 行触发，曾被算成主人的一轮对话。
  ['the host-triggered greeting', { inputContent: JSON.stringify('[UI_ACTION_TRIGGER]The user has just invited you.') }],
])('does not count %s', async (_label, patch) => {
  Object.assign(h.row!, patch);
  await countNightlyLearningTurn('main', 'reply');
  expect(h.record).not.toHaveBeenCalled();
});

it('counts the owner speaking in an IM channel', async () => {
  Object.assign(h.row!, { role: 'channel', inputMeta: owner });
  await countNightlyLearningTurn('lane', 'reply');
  expect(h.record).toHaveBeenCalledWith('/owner', 'bot', 'lane', 1000);
});
