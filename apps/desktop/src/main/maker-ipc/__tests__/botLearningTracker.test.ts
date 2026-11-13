import { describe, it, expect, vi } from 'vitest';
import { createBotLearningTracker } from '../botLearningTracker.js';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectMemoryReceipts } from '../botProjectLearning.js';
const memory = {
  kind: 'memory' as const,
  key: 'preference',
  title: '先讲结论',
  action: 'created' as const,
};
const skill = {
  kind: 'skill' as const,
  key: 'weekly-report',
  title: '工作周报',
  action: 'updated' as const,
};
describe('teammate learning receipt ownership', () => {
  // PR #10294: native file tools bypassed memory.beginWrite. Real files + production tracker
  // protect persisted created/updated feedback on the original bubble; read-only/invalid files
  // must not invent saves. Unit, minimal input: one old shard and one new shard, no MCP.
  it('publishes confirmed native file changes on the original reply only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-learning-'));
    try {
      const dir = path.join(root, '.cindy', 'memory');
      await mkdir(dir, { recursive: true });
      const shard = (body: string) => `---\ntitle: Tea\ndescription: Preferred drink\ntype: user\n---\n${body}`;
      await writeFile(path.join(dir, 'user_tea.md'), shard('oolong'));
      const read = vi.fn(await createProjectMemoryReceipts(root));
      const tracker = createBotLearningTracker(), publish = vi.fn();
      tracker.markProjectTeammate('s', read);
      tracker.observe('s', 'i:1', publish);
      await writeFile(path.join(dir, 'user_tea.md'), shard('sencha'));
      await writeFile(path.join(dir, 'user_new.md'), shard('jasmine'));
      // Another queued input rehydrates unchanged resources while this turn is still busy.
      // It must neither scan nor replace the pre-write reader used for this reply.
      const queuedReader = vi.fn(() => createProjectMemoryReceipts(root));
      await tracker.prepareProjectTeammate('s', queuedReader);
      expect(queuedReader).not.toHaveBeenCalled();
      // Even a direct later registration cannot change an already-observed turn's reader.
      tracker.markProjectTeammate('s', await createProjectMemoryReceipts(root));
      await writeFile(path.join(dir, 'user_partial.md'), '---\ntitle: unfinished');
      await writeFile(path.join(dir, 'README.md'), 'maintenance');
      expect(publish).not.toHaveBeenCalled();
      tracker.seal('s', 'i:1', 'reply');
      expect(read).toHaveBeenCalledTimes(1);
      await read.mock.results[0].value;
      expect(publish).toHaveBeenCalledWith('reply', [
        { kind: 'memory', key: 'user_new.md', title: 'Tea', action: 'created' },
        { kind: 'memory', key: 'user_tea.md', title: 'Tea', action: 'updated' },
      ]);
      publish.mockClear();
      tracker.markProjectTeammate('s', read);
      tracker.observe('s', 'i:2', publish);
      // Pi compaction writes an internal digest during an otherwise read-only turn.
      // It is hidden by the memory settings, so it must not create a curated-save receipt.
      await writeFile(path.join(dir, 'digest_compaction.md'),
        '---\ntitle: Compaction\ndescription: Internal summary\ntype: digest\n---\nInternal only');
      tracker.seal('s', 'i:2', 'next');
      await read.mock.results[1].value;
      expect(publish).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('drops an ambiguous native snapshot when another turn has already begun', async () => {
    let complete!: (receipts: typeof memory[]) => void;
    const read = () => new Promise<typeof memory[]>(resolve => { complete = resolve; });
    const tracker = createBotLearningTracker(), publish = vi.fn();
    tracker.markProjectTeammate('s', read);
    tracker.observe('s', 'i:1', publish);
    tracker.seal('s', 'i:1', 'old');
    tracker.observe('s', 'i:2', publish);
    complete([memory]);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
  it('withholds early saves, then publishes both rows on the corresponding reply', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    tracker.capture('s')(memory);
    tracker.capture('s')(skill);
    expect(publish).not.toHaveBeenCalled();
    tracker.seal('s', 'instance:1', 'reply-one');
    expect(publish).toHaveBeenCalledWith('reply-one', [memory, skill]);
  });
  // 依据：项目模式伙伴写的是项目记忆（非 bot: 作用域），学到的东西仍要在气泡底部提示；普通任务不提示。tier：unit。
  it('counts project-memory writes only for a project-mode teammate session', () => {
    const tracker = createBotLearningTracker();
    tracker.markProjectTeammate('teammate');
    expect(tracker.learnsFrom('teammate', '/work/teammate')).toBe('teammate');
    expect(tracker.learnsFrom('ordinary', '/work/app')).toBe('');
    expect(tracker.learnsFrom('classic', 'bot:classic')).toBe('classic');
  });
  it('a late save stays with its original bubble while a new reply is running', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    const save = tracker.capture('s');
    tracker.seal('s', 'instance:1', 'reply-one');
    tracker.observe('s', 'instance:2', publish);
    save(memory);
    expect(publish).toHaveBeenLastCalledWith('reply-one', [memory]);
    tracker.capture('s')(skill);
    tracker.seal('s', 'instance:2', 'reply-two');
    expect(publish).toHaveBeenLastCalledWith('reply-two', [skill]);
  });
  it('never invents a bubble or moves an abandoned save to a later turn', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    const save = tracker.capture('s');
    tracker.seal('s', 'instance:1');
    tracker.observe('s', 'replacement:1', publish);
    save(memory);
    tracker.seal('s', 'instance:1', 'wrong');
    tracker.seal('s', 'replacement:1', 'new');
    expect(publish).not.toHaveBeenCalled();
  });
  it('deduplicates repeated saves and keeps at most two separate rows across history JSON', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'i:1', publish);
    tracker.capture('s')(memory);
    tracker.capture('s')(memory);
    tracker.capture('s')(skill);
    tracker.capture('s')({ ...memory, key: 'another', title: '简短说明' });
    tracker.seal('s', 'i:1', 'reply');
    const rows = botLearningRows(JSON.parse(JSON.stringify(publish.mock.calls[0][1])));
    expect(rows.map((r) => r.kind)).toEqual(['memory', 'skill']);
    expect(rows[0].title).toBe('先讲结论 · 简短说明');
  });
});
