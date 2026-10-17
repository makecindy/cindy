import { beforeEach, it, expect, vi } from 'vitest';
import { getDbClient } from '../../localDb/client/current.js';
const h = vi.hoisted(() => ({
  owner: 'owner',
  enabled: true,
  visible: true,
  meta: { turnCompleted: true } as Record<string, unknown>,
  model: vi.fn(),
  write: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  saveSkill: vi.fn(),
  refresh: vi.fn(),
  memories: [] as any[],
  skills: [] as any[],
  working: null as any,
  writeWorking: vi.fn(),
  /** 上一条完成回复的 rowid;当前回复是它 + 2(默认 5)。 */
  prevCompleted: 3 as number | null,
  /** 缺口回补查询(ORDER BY rowid ASC)返回的行。 */
  gapRows: [] as any[],
  /** 本轮取材查询返回的行;null = 默认一条用户消息。 */
  turnRows: null as any[] | null,
  /** 按账本 client_id 解析水位时返回的当前 rowid;null = 解析不到。 */
  floorRowid: null as number | null,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/test-owner',
}));
vi.mock('../../localDb/client/current.js', () => {
  const db = {
    queryOne: vi.fn(async (sql: string) =>
      sql.includes('prev-completed')
        ? h.prevCompleted ? { id: 'prev', rowid: h.prevCompleted } : undefined
        : sql.includes('ledger-floor')
          ? h.floorRowid === null ? undefined : { rowid: h.floorRowid }
          : h.visible
          ? {
              botId: 'bot',
              capabilities: JSON.stringify({ memory: h.enabled }),
              // 当前回复:上一条完成回复 + 2(中间隔一条用户消息);默认 5。
              rowid: (h.prevCompleted ?? 0) + 2,
              meta: JSON.stringify(h.meta),
            }
          : undefined),
    query: vi.fn(async (sql: string) =>
      sql.includes('ORDER BY rowid ASC')
        ? h.gapRows
        : h.turnRows ?? [
            {
              id: 'user',
              role: 'user',
              content: JSON.stringify('Please always summarize the conclusion first.'),
              // 本轮的用户消息:紧跟在上一条完成回复之后。
              order: (h.prevCompleted ?? 0) + 1,
            },
          ],
    ),
  };
  return { getDbClient: () => db };
});
vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: async () => {},
  enqueueDurableWrite: async (_: unknown, run: () => unknown) => run(),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  patchMessageAgentMetaWithResult: async (_s: string, _r: string, patch: any) => {
    Object.assign(h.meta, patch);
    return {};
  },
}));
vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({
    makerMemory: {
      getStore: async () => ({ list: async () => h.memories, write: h.write, update: h.update }),
    },
  }),
}));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.model }));
vi.mock('../botLearningFeedback.js', () => ({ learningReceiptPublisher: () => h.publish }));
vi.mock('../botSkillStore.js', () => ({
  listBotSkills: async () => h.skills,
  readBotSkill: async (_r: string, _b: string, slug: string) =>
    h.skills.find((s) => s.slug === slug),
}));
vi.mock('../botSkillService.js', () => ({ saveBotSkillForSession: h.saveSkill }));
vi.mock('../botRuntimeEpochRefreshSignal.js', () => ({ requestBotRuntimeEpochRefresh: h.refresh }));
vi.mock('../botWorkingMemory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../botWorkingMemory.js')>();
  return {
    ...actual,
    readBotWorkingMemory: async () => h.working,
    writeBotWorkingMemory: h.writeWorking,
  };
});
import { reviewTeammateLearning } from '../botLearningReview.js';
const proposal = {
  type: 'feedback',
  name: 'conclusion_first',
  title: 'Conclusion first',
  description: 'Reporting preference',
  body: '**Why:** User requested this.\n**How to apply:** Lead with conclusions.',
  evidence: { messageId: 'user', quote: 'always summarize the conclusion first' },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 'owner';
  h.enabled = true;
  h.visible = true;
  h.meta = { turnCompleted: true };
  h.memories = [];
  h.skills = [];
  h.working = null;
  h.writeWorking.mockResolvedValue({ revision: 1 });
  h.write.mockResolvedValue({ ok: true });
  h.model.mockResolvedValue({
    ok: true,
    text: JSON.stringify({ memories: [proposal], skills: [] }),
  });
});
it('applies evidence-backed missing learning and publishes only to the frozen reply ID', async () => {
  await reviewTeammateLearning('session', 'original-reply');
  expect(h.write).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'conclusion_first', mode: 'create' }),
  );
  expect(h.publish).toHaveBeenCalledWith('original-reply', [
    expect.objectContaining({ kind: 'memory', title: 'Conclusion first' }),
  ]);
  await reviewTeammateLearning('session', 'original-reply');
  expect(h.model).toHaveBeenCalledOnce();
});
it('does not claim failed saves or apply memories when retention is disabled', async () => {
  h.write.mockRejectedValueOnce(new Error('disk full'));
  await reviewTeammateLearning('session', 'reply');
  expect(h.publish).not.toHaveBeenCalled();
  h.enabled = false;
  h.meta = { turnCompleted: true };
  h.write.mockClear();
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});
it('uses conditional updates and preserves edits made during the review', async () => {
  h.memories = [
    {
      filename: 'feedback_conclusion_first.md',
      slug: 'conclusion_first',
      body: 'old',
      frontmatter: { type: 'feedback', title: 'old', updatedAt: 'v1' },
    },
  ];
  h.update.mockRejectedValueOnce(new Error('version conflict'));
  await reviewTeammateLearning('session', 'reply');
  expect(h.update).toHaveBeenCalledWith('feedback_conclusion_first.md', 'v1', expect.anything());
  expect(h.write).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it('drops model output after account switching or source reply removal', async () => {
  h.model.mockImplementationOnce(async () => {
    h.owner = 'new-owner';
    return { ok: true, text: JSON.stringify({ memories: [proposal], skills: [] }) };
  });
  await reviewTeammateLearning('session', 'reply');
  expect(h.write).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  h.owner = 'owner';
  h.meta = { turnCompleted: true };
  h.model.mockImplementationOnce(async () => {
    h.visible = false;
    return { ok: true, text: JSON.stringify({ memories: [proposal], skills: [] }) };
  });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});
it('empty and unsupported-evidence proposals produce no saves', async () => {
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [] }) });
  await reviewTeammateLearning('session', 'reply');
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  h.meta = { turnCompleted: true };
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [
        { ...proposal, evidence: { messageId: 'user', quote: 'not in the conversation' } },
      ],
      skills: [],
    }),
  });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});

it('updates an existing Skill using its snapshot version and ignores disabled Skills', async () => {
  const skill = {
    slug: 'weekly-report',
    title: 'Weekly report',
    description: 'Reusable report format',
    body: 'Lead with the conclusion and then provide evidence.',
    evidence: proposal.evidence,
  };
  h.skills = [{ slug: skill.slug, name: skill.title, body: 'old format', updatedAt: 'v1' }];
  h.saveSkill.mockResolvedValue({
    ok: true,
    created: false,
    skill: { slug: skill.slug, name: skill.title },
  });
  h.model.mockResolvedValue({ ok: true, text: JSON.stringify({ memories: [], skills: [skill] }) });
  await reviewTeammateLearning('session', 'reply');
  expect(h.saveSkill).toHaveBeenCalledWith(
    expect.objectContaining({ slug: skill.slug, expectedUpdatedAt: 'v1' }),
  );
  expect(h.publish).toHaveBeenCalledWith('reply', [
    expect.objectContaining({ kind: 'skill', action: 'updated' }),
  ]);
  h.meta = { turnCompleted: true };
  h.skills[0].enabled = false;
  h.saveSkill.mockClear();
  await reviewTeammateLearning('session', 'reply2');
  expect(h.saveSkill).not.toHaveBeenCalled();
});

it('feeds the working memory to the review and writes an evidence-filtered ledger with CAS', async () => {
  h.working = { version: 1, revision: 4, coveredThroughRowid: 1, updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [],
      skills: [],
      working: {
        commitments: [
          { text: 'Lead every report with the conclusion', evidence: { messageId: 'user', quote: 'summarize the conclusion first' } },
          { text: 'Invented promise', evidence: { messageId: 'user', quote: 'not in the conversation' } },
        ],
      },
    }),
  });
  await reviewTeammateLearning('session', 'reply');
  const input = JSON.parse(h.model.mock.calls[0]![1] as string);
  expect(input.workingMemory).toEqual({ threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] });
  // 本轮取材从上一条完成回复(3)接起;旧账本没有 client_id,存下的 rowid(1)不作数,缺口从对话开头(0)
  // 按升序分批回补;都不取 /clear 之前的消息。
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  const recent = query.mock.calls.slice(-2);
  expect(recent.map((call) => call[1])).toEqual([
    ['session', 5, 3, 'session'],
    ['session', 0, 3, 'session', 41],
  ]);
  expect(recent.every((call) => String(call[0]).includes('cleared_at'))).toBe(true);
  expect(h.writeWorking).toHaveBeenCalledWith(
    '/test-owner',
    'bot',
    expect.objectContaining({
      coveredThroughRowid: 5,
      // 水位同时记下当前回复的 client_id,作为瘦身重排后仍然可靠的持久判据。
      coveredThroughMessageId: 'reply',
      commitments: [expect.objectContaining({ text: 'Lead every report with the conclusion', messageId: 'user' })],
    }),
    4,
  );
  // 模型省略 working(本轮没改动):条目不加不删,但水位仍要跟上这一轮,否则一句问候就让账本不新鲜。
  h.meta = { turnCompleted: true };
  h.writeWorking.mockClear();
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [] }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.writeWorking).toHaveBeenCalledWith(
    '/test-owner',
    'bot',
    expect.objectContaining({ coveredThroughRowid: 5, coveredThroughMessageId: 'reply2', commitments: [], corrections: [] }),
    4,
  );
});

it('advances the ledger watermark only through the contiguous backfilled prefix while a gap is still being caught up', async () => {
  const ledger = { version: 1, revision: 4, coveredThroughRowid: 1, updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  const gap = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ id: `g${from + i}`, role: 'assistant', content: JSON.stringify(`gap ${from + i}`), order: from + i }));
  h.working = { ...ledger };
  h.prevCompleted = 100;
  // 缺口 (1,100] 里有 41 条,超过每批 40 条:只补前 40 条,水位停在第 40 条(rowid 41),不推进到当前回复。
  h.gapRows = gap(2, 42);
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  const input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  expect(input.messages.filter((m: { id: string }) => m.id.startsWith('g')).map((m: { id: string }) => m.id)).toEqual(
    gap(2, 41).map((m) => m.id),
  );
  expect(input.messages.at(-1).id).toBe('user');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 41, coveredThroughMessageId: 'g41' }), 4);
  // 下一轮按 client_id 'g41' 解析回当前 rowid(41)接上,剩余一条补完:水位推进到当前回复(102)。
  h.meta = { turnCompleted: true };
  h.working = { ...ledger, coveredThroughRowid: 41, coveredThroughMessageId: 'g41' };
  h.floorRowid = 41;
  h.gapRows = gap(42, 42);
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 102, coveredThroughMessageId: 'reply2' }), 4);
  h.prevCompleted = 3;
  h.gapRows = [];
  h.floorRowid = null;
});

it('walks an over-long user message in chunks and only counts it covered once the whole text was reviewed', async () => {
  const ledger = { version: 1, revision: 4, coveredThroughRowid: 1, coveredThroughMessageId: 'r1', updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  const longRow = { id: 'long', role: 'user', content: JSON.stringify('x'.repeat(9000)), order: 2 };
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  // 缺口里有一条 9000 字的用户消息:第一次只看前 6000 字,水位停在这条消息的 6000 偏移,不算整条覆盖。
  h.working = { ...ledger };
  h.floorRowid = 1;
  h.gapRows = [longRow];
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  let input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  expect(input.messages.find((m: { id: string }) => m.id === 'long').text).toHaveLength(6000);
  expect(input.messages.find((m: { id: string }) => m.id === 'long')).not.toHaveProperty('partial');
  // 水位记到块尾往回 200 字(重叠),跨块句子和短尾段都能在下一块里完整出现。
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 2, coveredThroughMessageId: 'long', coveredThroughOffset: 5800 }), 4);
  // 下一次从同一条消息的 5800 偏移接着取(查询下界 rowid > 2-1 以把它本身取回来),剩余 3200 字看完:整条覆盖,水位推进到当前回复且不再带偏移。
  h.meta = { turnCompleted: true };
  h.working = { ...ledger, coveredThroughRowid: 2, coveredThroughMessageId: 'long', coveredThroughOffset: 5800 };
  h.floorRowid = 2;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 1, 3, 'session', 41]);
  input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  expect(input.messages.find((m: { id: string }) => m.id === 'long').text).toHaveLength(3200);
  const written = h.writeWorking.mock.calls.at(-1)![2] as { coveredThroughRowid: number; coveredThroughMessageId?: string; coveredThroughOffset?: number };
  expect(written).toMatchObject({ coveredThroughRowid: 5, coveredThroughMessageId: 'reply2' });
  expect(written.coveredThroughOffset).toBeUndefined();
  // 分块水位恰好停在上一条完成回复上(后面的轮次被 rewind 掉了):带偏移时取等号,仍把那条回复取回来补完剩余部分。
  h.meta = { turnCompleted: true };
  h.working = { ...ledger, coveredThroughRowid: 3, coveredThroughMessageId: 'prev', coveredThroughOffset: 6000 };
  h.floorRowid = 3;
  h.gapRows = [{ id: 'prev', role: 'assistant', content: JSON.stringify('z'.repeat(9000)), order: 3 }];
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply-after-rewind');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 2, 3, 'session', 41]);
  input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  expect(input.messages.find((m: { id: string }) => m.id === 'prev').text).toHaveLength(3000);
  expect(h.writeWorking.mock.calls.at(-1)![2]).toMatchObject({ coveredThroughRowid: 5, coveredThroughMessageId: 'reply-after-rewind' });
  expect((h.writeWorking.mock.calls.at(-1)![2] as { coveredThroughOffset?: number }).coveredThroughOffset).toBeUndefined();
  // 本轮取材里的长用户消息同样算截断:水位停在上一条完成回复,交给下一次分块回补。
  h.meta = { turnCompleted: true };
  h.working = { ...ledger, coveredThroughRowid: 3, coveredThroughMessageId: 'prev' };
  h.floorRowid = 3;
  h.turnRows = [{ id: 'user', role: 'user', content: JSON.stringify('y'.repeat(7000)), order: 4 }];
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply3');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 3, coveredThroughMessageId: 'prev' }), 4);
  h.turnRows = null;
  h.gapRows = [];
  h.floorRowid = null;
});

it('resolves the ledger floor by client_id so a VACUUM-renumbered rowid cannot fake freshness, and starts a brand-new ledger from the beginning', async () => {
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  // 瘦身后 rowid 重排:账本存的 500 已经没有意义,按 client_id 解析回当前的 1 接上,写回当前库的水位(5)而不是保留 500。
  h.working = { version: 1, revision: 4, coveredThroughRowid: 500, coveredThroughMessageId: 'old-reply', updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  h.floorRowid = 1;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 1, 3, 'session', 41]);
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 5, coveredThroughMessageId: 'reply' }), 4);
  // 有 client_id 但解析不到(水位消息已被删 / 撤回):同样不信存下的 500,从对话开头回补。
  h.meta = { turnCompleted: true };
  h.floorRowid = null;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply-gone');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 0, 3, 'session', 41]);
  // 游标解析只认可见时间线上的行:被 rewind / 删成墓碑 / 落在 /clear 之前的都算解析不到。
  const queryOne = (getDbClient() as unknown as { queryOne: ReturnType<typeof vi.fn> }).queryOne;
  const floorSql = String(queryOne.mock.calls.find((call) => String(call[0]).includes('ledger-floor'))![0]);
  expect(floorSql).toContain('rewind_at IS NULL');
  expect(floorSql).toContain("role != 'message_tombstone'");
  expect(floorSql).toContain('cleared_at');
  // 没有账本:从对话开头起算,整段历史按缺口分批回补,而不是从上一条完成回复直接跳过去。
  h.meta = { turnCompleted: true };
  h.working = null;
  h.floorRowid = null;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 0, 3, 'session', 41]);
});

it('feeds interaction answers (AskUserQuestion / plan review) to the review as user text and skips empty ones without counting truncation', async () => {
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  h.working = { version: 1, revision: 4, coveredThroughRowid: 3, coveredThroughMessageId: 'prev', updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  h.floorRowid = 3;
  h.turnRows = [
    { id: 'user', role: 'user', content: JSON.stringify('Which format?'), order: 4 },
    { id: 'ask', role: 'ask_user', content: JSON.stringify({ requestId: 'r', questions: [], status: 'answered', answers: { '用哪种格式?': '先结论后细节' } }), order: 5 },
    { id: 'plan-ok', role: 'plan_review', content: JSON.stringify({ requestId: 'p', plan: '1. 改模板', planFilePath: '', status: 'approved', feedback: null }), order: 6 },
    { id: 'plan-no', role: 'plan_review', content: JSON.stringify({ requestId: 'q', plan: 'x', planFilePath: '', status: 'revised', feedback: '先别动样式' }), order: 7 },
    { id: 'ask-cancel', role: 'ask_user', content: JSON.stringify({ requestId: 's', questions: [], status: 'cancelled', answers: {} }), order: 8 },
  ];
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [],
      skills: [],
      // 用户在 AskUserQuestion 里的选择可以作为账本证据(按用户消息对待)。
      working: { corrections: [{ text: '周报先结论后细节', evidence: { messageId: 'ask', quote: '用哪种格式? → 先结论后细节' } }] },
    }),
  });
  await reviewTeammateLearning('session', 'reply');
  expect(String(query.mock.calls.at(-1)![0])).toContain("'ask_user'");
  const input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  const byId = Object.fromEntries(input.messages.map((m: { id: string; role: string; text: string }) => [m.id, m]));
  expect(byId.ask).toMatchObject({ role: 'user', text: 'Clarifications:\n- 用哪种格式? → 先结论后细节' });
  expect(byId['plan-ok']).toMatchObject({ role: 'user', text: 'Approved plan:\n1. 改模板' });
  expect(byId['plan-no']).toMatchObject({ role: 'user', text: '先别动样式' });
  expect(byId['ask-cancel']).toBeUndefined();
  // 空的取消行被丢掉不算截断:水位照常推进到当前回复;纠正条目带上 ask 行作为来源。
  expect(h.writeWorking).toHaveBeenLastCalledWith(
    '/test-owner',
    'bot',
    expect.objectContaining({
      coveredThroughRowid: 5,
      coveredThroughMessageId: 'reply',
      corrections: [expect.objectContaining({ text: '周报先结论后细节', messageId: 'ask' })],
    }),
    4,
  );
  h.turnRows = null;
  h.floorRowid = null;
});

it('does not advance the watermark past the previous completed reply when the current turn itself was truncated, and defers deletions/rewrites', async () => {
  // 本轮取材取满 80 条 = 可能被 LIMIT 截断:水位停在上一条完成回复(3),留给下一次的缺口回补。
  h.working = {
    version: 1, revision: 4, coveredThroughRowid: 3, coveredThroughMessageId: 'prev', updatedAt: 0,
    threads: [], waiting: [], corrections: [], recentlyDone: [],
    commitments: [{ id: 'c-old', text: 'Old promise still open', messageId: 'u-old', updatedAt: 1, trigger: 'Friday' }],
  };
  h.floorRowid = 3;
  h.turnRows = [
    { id: 'user', role: 'user', content: JSON.stringify('Please always summarize the conclusion first.'), order: 4 },
    ...Array.from({ length: 79 }, (_, i) => ({ id: `t${i}`, role: 'tool_result', content: JSON.stringify(`result ${i}`), order: 4 + i })),
  ];
  const evidence = { messageId: 'user', quote: 'summarize the conclusion first' };
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [],
      skills: [],
      // 截断轮次里的删除(resolved)与改写(trigger)都延后;新条目照常追加。
      working: {
        commitments: [
          { text: 'Old promise still open', trigger: 'Monday', evidence },
          { text: 'New promise from this turn', evidence },
        ],
        resolved: [{ text: 'Old promise still open', evidence }],
      },
    }),
  });
  await reviewTeammateLearning('session', 'reply');
  const written = h.writeWorking.mock.calls.at(-1)![2] as { coveredThroughRowid: number; coveredThroughMessageId?: string; commitments: Array<{ text: string; trigger?: string }> };
  expect(written).toMatchObject({ coveredThroughRowid: 3, coveredThroughMessageId: 'prev' });
  expect(written.commitments.map((c) => [c.text, c.trigger])).toEqual([
    ['New promise from this turn', undefined],
    ['Old promise still open', 'Friday'],
  ]);
  h.turnRows = null;
  h.floorRowid = null;
});

it('commits deletions evidenced inside the backfilled prefix even while the gap is incomplete, but still defers those evidenced by the current turn', async () => {
  // 缺口 (1,100] 有 41 条、分两批回补:取消旧承诺的用户消息只出现在第一批,错过就补不上。
  h.working = {
    version: 1, revision: 4, coveredThroughRowid: 1, coveredThroughMessageId: 'r1', updatedAt: 0,
    threads: [], waiting: [], corrections: [], recentlyDone: [],
    commitments: [
      { id: 'c-cancelled', text: 'Ship the weekly report template', messageId: 'u-old', updatedAt: 1 },
      { id: 'c-current', text: 'Add dark mode to the mockup', messageId: 'u-old', updatedAt: 2 },
    ],
  };
  h.floorRowid = 1;
  h.prevCompleted = 100;
  h.gapRows = [
    { id: 'g2', role: 'user', content: JSON.stringify('Forget the weekly report template, we dropped it.'), order: 2 },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `g${3 + i}`, role: 'assistant', content: JSON.stringify(`gap ${3 + i}`), order: 3 + i })),
  ];
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [],
      skills: [],
      working: {
        commitments: [],
        resolved: [
          { text: 'Ship the weekly report template', evidence: { messageId: 'g2', quote: 'we dropped it' } },
          { text: 'Add dark mode to the mockup', evidence: { messageId: 'user', quote: 'summarize the conclusion first' } },
        ],
      },
    }),
  });
  await reviewTeammateLearning('session', 'reply');
  const written = h.writeWorking.mock.calls.at(-1)![2] as { coveredThroughRowid: number; coveredThroughMessageId?: string; commitments: Array<{ text: string }> };
  // 水位停在第一批末尾(rowid 41),没推进到当前回复。
  expect(written).toMatchObject({ coveredThroughRowid: 41, coveredThroughMessageId: 'g41' });
  // 前缀内证据的删除照常生效;当前轮证据的删除延后到这一轮被完整回补时。
  expect(written.commitments.map((c) => c.text)).toEqual(['Add dark mode to the mockup']);
  h.prevCompleted = 3;
  h.gapRows = [];
  h.floorRowid = null;
});
