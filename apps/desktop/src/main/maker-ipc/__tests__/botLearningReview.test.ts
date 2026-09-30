import { beforeEach, it, expect, vi } from 'vitest';
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
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/test-owner',
}));
vi.mock('../../localDb/client/current.js', () => {
  const db = {
    queryOne: async () =>
      h.visible
        ? {
            botId: 'bot',
            capabilities: JSON.stringify({ memory: h.enabled }),
            rowid: 5,
            meta: JSON.stringify(h.meta),
          }
        : undefined,
    query: async () => [
      {
        id: 'user',
        role: 'user',
        content: JSON.stringify('Please always summarize the conclusion first.'),
      },
    ],
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
