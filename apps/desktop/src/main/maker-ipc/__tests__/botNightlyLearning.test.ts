/**
 * 夜间学习的真实入口（runNightlyLearning / revertNightlyLearningItem）：状态文件落在临时目录，
 * 数据库、辅助模型、记忆库与技能库用内存替身。依据 2026-10-23 主人裁决：没有新对话不调用模型；
 * 只出现一次的做法先观察，再次出现才转正为技能；改动之后被人改过的不能撤销；失败不扣计数。
 * PR #6940 review：读取位置不能卡在一批全被过滤的回复上，也不能越过仍在生成的回复；
 * 模型思考期间被改过的记忆和技能不覆盖，合并的保留项没写成功时不删来源。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { MemoryError } from '@cindy/maker-core';

const h = vi.hoisted(() => ({
  root: '',
  rows: [] as any[],
  memories: new Map<string, any>(),
  skills: new Map<string, { source: string; enabled: boolean }>(),
  model: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => h.root,
}));
vi.mock('../../localDb/client/current.js', () => {
  const db = {
    // 按真实查询的水位区间与条数上限返回（参数：botId, after, until）。
    query: vi.fn(async (sql: string, params: unknown[]) => (sql.includes('nightly-learning-turns')
      ? h.rows.filter((r) => r.createdAt > (params[1] as number) && r.createdAt <= (params[2] as number)).slice(0, 401)
      : [])),
    queryOne: vi.fn(async () => ({ canonicalSessionId: 'main', capabilities: JSON.stringify({ memory: true }) })),
  };
  return { getDbClient: () => db };
});
vi.mock('../../messagePersistBroadcaster.js', () => ({ drainPersistQueue: async () => {} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: () => {}, info: () => {} }) }));
vi.mock('../../learn-host/skillsIndex.js', () => ({ listInstalledSkills: async () => ({ entries: [], truncatedCount: 0 }) }));
vi.mock('../botRuntimeEpochRefreshSignal.js', () => ({ requestBotRuntimeEpochRefresh: h.refresh }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.model }));
vi.mock('../botSkillService.js', () => ({
  listBotSkillsForBot: async () => [...h.skills].map(([slug, s]) => ({ slug, name: slug, description: 'd', updatedAt: 'v', enabled: s.enabled })),
  readBotSkillForBot: async (_b: string, slug: string) => (h.skills.has(slug) ? { slug, name: slug, description: 'd', updatedAt: 'v', body: 'body' } : null),
  readBotSkillSourceForBot: async (_b: string, slug: string) => h.skills.get(slug)?.source ?? null,
  saveBotSkillSourceForBot: async (_b: string, slug: string, source: string, o: { enabled?: boolean }) => {
    h.skills.set(slug, { source, enabled: o.enabled !== false });
  },
  deleteBotSkillForBot: async (_b: string, slug: string) => h.skills.delete(slug),
}));
vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({
    makerMemory: {
      getStore: async () => ({
        list: async () => [...h.memories.values()].map((record) => structuredClone(record)),
        read: async (filename: string) => {
          const record = h.memories.get(filename);
          if (!record) throw new MemoryError('not-found', filename);
          return structuredClone(record);
        },
        write: async (o: any) => {
          const filename = `${o.type}_${o.name}.md`;
          h.memories.set(filename, { filename, slug: o.name, body: o.body, frontmatter: { type: o.type, title: o.title, description: o.description, updatedAt: `t${Date.now()}${Math.random()}` } });
        },
        update: async (filename: string, expected: string, c: any) => {
          const record = h.memories.get(filename);
          if (record.frontmatter.updatedAt !== expected) throw new Error('stale');
          record.body = c.body;
          record.frontmatter = { ...record.frontmatter, title: c.title, description: c.description, updatedAt: `t${Math.random()}` };
        },
        delete: async (filename: string) => { h.memories.delete(filename); },
      }),
    },
  }),
}));

import { revertNightlyLearningItem, runNightlyLearning } from '../botNightlyLearning.js';
import { readNightlyLearningState, recordNightlyLearningTurn } from '../botNightlyLearningState.js';

const turn = (n: number, text: string, createdAt: number) => ({
  sessionId: 'main', id: `reply${n}`, content: 'Done.', meta: JSON.stringify({ turnCompleted: true }), createdAt, role: 'canonical',
  inputId: `user${n}`, inputContent: JSON.stringify(text), inputMeta: '{}',
});
/** 第 n 次调用模型时发给它的对话消息 id。 */
const sentIds = (call: number) => JSON.parse(h.model.mock.calls[call]![1]).messages.map((m: { id: string }) => m.id);
const reply = (plan: Record<string, unknown>) => h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify(plan) });
const memory = (name: string, title: string, body: string) => {
  const filename = `feedback_${name}.md`;
  h.memories.set(filename, { filename, slug: name, body, frontmatter: { type: 'feedback', title, description: 'd', updatedAt: `v-${name}` } });
  return filename;
};
const roots: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightly-learning-'));
  roots.push(h.root);
  h.rows = [];
  h.memories.clear();
  h.skills.clear();
});
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('skips a scheduled run without calling the model when there is no new owner conversation', async () => {
  await expect(runNightlyLearning('bot', { manual: false })).resolves.toMatchObject({ skipped: true });
  expect(h.model).not.toHaveBeenCalled();
  // 手动「现在整理」不看计数：没有新对话也整理一次已有记录。
  reply({});
  await runNightlyLearning('bot', { manual: true });
  expect(h.model).toHaveBeenCalledOnce();
});

it('observes a one-off approach first and only turns it into a skill when it recurs on a later night', async () => {
  const quote = 'look for the old Telegram chat first';
  await recordNightlyLearningTurn(h.root, 'bot', 'main', 1000);
  h.rows = [turn(1, `Please ${quote}.`, 1000)];
  const promote = { candidateId: 'missing', slug: 'find-old-chats', title: 'Find old chats', description: 'when', body: 'steps', reason: 'r', evidence: { messageId: 'user1', quote } };
  reply({
    promote: [promote],
    observe: [{ title: 'Find old chats', summary: 's', draft: { name: 'find-old-chats', description: 'when', body: 'steps' }, evidence: { messageId: 'user1', quote } }],
  });
  await runNightlyLearning('bot', { manual: false });
  expect(h.skills.size).toBe(0);
  const candidate = (await readNightlyLearningState(h.root, 'bot'))!.candidates[0]!;
  expect(candidate.title).toBe('Find old chats');

  await recordNightlyLearningTurn(h.root, 'bot', 'main', Date.now());
  h.rows = [turn(2, `Again, ${quote}.`, Date.now())];
  reply({ promote: [{ ...promote, candidateId: candidate.id, evidence: { messageId: 'user2', quote } }] });
  await runNightlyLearning('bot', { manual: false });
  expect(h.skills.get('find-old-chats')?.enabled).toBe(true);
  const state = (await readNightlyLearningState(h.root, 'bot'))!;
  expect(state.candidates).toHaveLength(0);
  const [run] = state.runs;
  await revertNightlyLearningItem('bot', run!.id, run!.items[0]!.id, false);
  expect(h.skills.has('find-old-chats')).toBe(false);
  await revertNightlyLearningItem('bot', run!.id, run!.items[0]!.id, true);
  expect(h.skills.has('find-old-chats')).toBe(true);
});

it('refuses to undo a merge after the kept memory was edited, without overwriting the edit', async () => {
  const kept = memory('progress', 'Report results', 'Report feature results.');
  const dup = memory('progress_dup', 'Report results too', 'Only report results.');
  reply({ memories: [
    { op: 'update', filename: kept, title: 'Report results', description: 'd', body: 'Report feature results only.', reason: 'merge' },
    { op: 'delete', filename: dup, mergedInto: kept, reason: 'duplicate' },
  ] });
  await runNightlyLearning('bot', { manual: true });
  expect(h.memories.has(dup)).toBe(false);
  const [run] = (await readNightlyLearningState(h.root, 'bot'))!.runs;
  h.memories.get(kept).body = 'The owner rewrote this by hand.';
  await expect(revertNightlyLearningItem('bot', run!.id, run!.items[0]!.id, false)).rejects.toMatchObject({ code: 'CHANGED' });
  expect(h.memories.get(kept).body).toBe('The owner rewrote this by hand.');
  await revertNightlyLearningItem('bot', run!.id, run!.items[1]!.id, false);
  expect(h.memories.get(dup).body).toBe('Only report results.');
});

it('keeps the count when the model fails and leaves conversations that arrive mid-run for the next night', async () => {
  await recordNightlyLearningTurn(h.root, 'bot', 'main', 1000);
  h.rows = [turn(1, 'Please keep answers short.', 1000)];
  h.model.mockResolvedValueOnce({ ok: false });
  await expect(runNightlyLearning('bot', { manual: false })).resolves.toMatchObject({ error: expect.any(String) });
  let state = (await readNightlyLearningState(h.root, 'bot'))!;
  expect(state.pending.turns).toBe(1);
  expect(state.runs[0]!.outcome).toBe('failed');

  h.model.mockImplementationOnce(async () => {
    await recordNightlyLearningTurn(h.root, 'bot', 'main', Date.now() + 60_000);
    return { ok: true, text: '{}' };
  });
  await runNightlyLearning('bot', { manual: false });
  state = (await readNightlyLearningState(h.root, 'bot'))!;
  expect(state.pending.turns).toBe(1);
  expect(state.runs[0]!.outcome).toBe('nothing');
});

// Issue #8194：理由超长时 validateResponse 判定回复无效，整条模型链失败，这一夜什么都学不到。
it('keeps a plan whose reason runs past the limit and records the clipped reason', async () => {
  const filename = memory('progress', 'Report results', 'Old.');
  const text = JSON.stringify({ memories: [
    { op: 'update', filename, title: 'Report results', description: 'd', body: 'New.', reason: 'x'.repeat(200) },
  ] });
  // 替身按真实模型链的判定走：validateResponse 不通过就算这个候选失败。
  h.model.mockImplementationOnce(async (_maker: unknown, _input: string, request: { validateResponse: (t: string) => boolean }) => (
    request.validateResponse(text) ? { ok: true, text } : { ok: false }
  ));
  await runNightlyLearning('bot', { manual: true });
  expect(h.memories.get(filename).body).toBe('New.');
  const [run] = (await readNightlyLearningState(h.root, 'bot'))!.runs;
  expect(run!.outcome).toBe('learned');
  expect(run!.items[0]!.reason).toBe(`${'x'.repeat(119)}…`);
});

it('moves past a batch of filtered replies and waits for a reply that is still being written', async () => {
  const t0 = Date.now() - 60_000;
  await recordNightlyLearningTurn(h.root, 'bot', 'main', t0);
  // 一批 400 条子代理回复全被过滤：下一次必须越过它们，读到后面的主人对话。
  const sub = { meta: JSON.stringify({ turnCompleted: true, parentUuid: 'p' }) };
  h.rows = Array.from({ length: 400 }, (_, i) => ({ ...turn(100 + i, 'sub', t0 + i), ...sub }));
  h.rows.push(turn(1, 'Please keep answers short.', t0 + 1000));
  h.rows.push({ ...turn(2, 'And cite sources.', t0 + 2000), meta: JSON.stringify({}) });
  await runNightlyLearning('bot', { manual: false });
  expect(h.model).not.toHaveBeenCalled();
  reply({});
  await runNightlyLearning('bot', { manual: false });
  expect(sentIds(0)).toEqual(['user1', 'reply1']);

  // 第二轮回复当时还在生成：完成后下一次读到它，已学过的第一轮不再重复。
  h.rows[h.rows.length - 1] = turn(2, 'And cite sources.', t0 + 2000);
  await recordNightlyLearningTurn(h.root, 'bot', 'main', t0 + 2000);
  reply({});
  await runNightlyLearning('bot', { manual: false });
  expect(sentIds(1)).toEqual(['user2', 'reply2']);
});

it('never overwrites edits made while the model was thinking, and keeps a merge source whose kept memory was skipped', async () => {
  const kept = memory('progress', 'Report results', 'Report feature results.');
  const dup = memory('progress_dup', 'Report results too', 'Only report results.');
  h.skills.set('deploy', { source: 'old steps', enabled: true });
  h.model.mockImplementationOnce(async () => {
    h.memories.get(kept).frontmatter.updatedAt = 'edited-by-owner';
    h.skills.set('deploy', { source: 'owner steps', enabled: true });
    return { ok: true, text: JSON.stringify({
      memories: [
        { op: 'delete', filename: dup, mergedInto: kept, reason: 'duplicate' },
        { op: 'update', filename: kept, title: 'Report results', description: 'd', body: 'Merged.', reason: 'merge' },
      ],
      skills: [{ op: 'update', slug: 'deploy', title: 'Deploy', description: 'd', body: 'model steps', reason: 'r' }],
    }) };
  });
  await runNightlyLearning('bot', { manual: true });
  expect(h.memories.get(kept).body).toBe('Report feature results.');
  expect(h.memories.get(dup).body).toBe('Only report results.');
  expect(h.skills.get('deploy')!.source).toBe('owner steps');
  expect((await readNightlyLearningState(h.root, 'bot'))!.runs[0]!.items).toEqual([]);
});
