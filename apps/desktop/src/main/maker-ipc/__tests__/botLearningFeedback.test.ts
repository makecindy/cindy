import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 'owner',
  meta: {} as Record<string, unknown>,
  visible: true,
  /** The Session the reply belongs to: its source and, when linked to a teammate, the link role. */
  session: { source: 'bot', botRole: 'canonical' } as { source: string; botRole: string | null },
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
  const db = {
    queryOne: async () => (h.visible ? { meta: JSON.stringify(h.meta), ...h.session } : undefined),
  };
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
  h.session = { source: 'bot', botRole: 'canonical' };
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
/**
 * 测试价值(普通任务的保存回执, docs/product-rules/cindy-memory.md §4)
 * - 生产入口与可观察结果: learningReceiptPublisher 是否把回执写进那条回复的 agent_meta 并广播。
 * - 规则依据: 回执原先只落在伙伴主对话 / 历史对话; 现在普通任务的回复也落, 子 Agent 消息、
 *   伙伴的群专线 / 渠道 / 话题 / 例行 / 委派 Session 仍不落。
 * - 现有覆盖缺口: 上面的用例不区分回复属于哪种 Session。
 * - 最小失败输入: 一条 source 不是 bot、没有伙伴关联的 Session 里的 assistant 回复。
 * - tier: unit(数据库与持久化队列为替身, 判定在被测函数内)。
 */
it.each([
  ['an ordinary task reply', { source: 'desktop', botRole: null }, {}, true],
  ['an ordinary task reply from an IM channel', { source: 'feishu', botRole: null }, {}, true],
  ['a sub-agent message in an ordinary task', { source: 'desktop', botRole: null }, { parentUuid: 'parent' }, false],
  ['a teammate main chat reply', { source: 'bot', botRole: 'canonical' }, {}, true],
  ['a teammate history chat reply', { source: 'bot', botRole: 'history' }, {}, true],
  ['a teammate sub-agent message', { source: 'bot', botRole: 'canonical' }, { parentUuid: 'parent' }, false],
  ['a teammate group lane', { source: 'bot', botRole: 'group' }, {}, false],
  ['a teammate topic', { source: 'bot', botRole: 'thread' }, {}, false],
  ['a task a teammate delegated', { source: 'desktop', botRole: 'delegation' }, {}, false],
  ['a teammate Session without its link', { source: 'bot', botRole: null }, {}, false],
] as const)('persists the receipt on %s: %o %o -> %s', async (_name, session, meta, persisted) => {
  h.session = { ...session };
  h.meta = { ...meta };
  const receipt = { ...memory, scope: 'project' as const };
  learningReceiptPublisher('session')('reply', [receipt]);
  await drain();
  if (persisted) {
    expect(h.patch).toHaveBeenCalledWith('session', 'reply', { botLearning: [receipt] });
    expect(h.broadcast).toHaveBeenCalledWith('session', 'reply', undefined);
  } else {
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  }
});
