import type { AgentEvent } from '@cindy/maker-core';
import { describe, it, expect, vi } from 'vitest';
import { createBotLearningTracker } from '../botLearningTracker.js';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
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
function successfulWrite(tracker: ReturnType<typeof createBotLearningTracker>, session: string, identity: string,
  source: AgentEvent['source'], toolName: string, input: Record<string, unknown>, id = 'write') {
  tracker.noteToolEvent(session, identity, { type: 'tool_use', source, data: { toolUseId: id, toolName, input } });
  tracker.noteToolEvent(session, identity, { type: 'tool_result_full', source, data: { toolUseId: id, isError: false } });
}
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
      successfulWrite(tracker, 's', 'i:1', 'pi', 'edit', { path: path.join(dir, 'user_tea.md') });
      successfulWrite(tracker, 's', 'i:1', 'claude-code', 'Write', { file_path: path.join('.cindy', 'memory', 'user_new.md') }, 'new');
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

  // #10318: independent readers share the project's directory. A read-only turn
  // must not publish B's write. Real fs + production tracker, unit tier.
  it('does not attribute a shared-directory write to a read-only session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-owners-'));
    try {
      const dir = path.join(root, '.cindy', 'memory');
      await mkdir(dir, { recursive: true });
      const tracker = createBotLearningTracker();
      const readA = vi.fn(await createProjectMemoryReceipts(root));
      const readB = vi.fn(await createProjectMemoryReceipts(root));
      const publishA = vi.fn(), publishB = vi.fn();
      tracker.markProjectTeammate('A', readA);
      tracker.markProjectTeammate('B', readB);
      tracker.observe('A', 'A:1', publishA);
      tracker.observe('B', 'B:1', publishB);
      await writeFile(path.join(dir, 'user_tea.md'),
        '---\ntitle: Tea\ndescription: Preferred drink\ntype: user\n---\noolong');
      successfulWrite(tracker, 'B', 'B:1', 'codex', 'file_change', { changes: [{ path: path.join(dir, 'user_tea.md'), kind: { type: 'add' } }] });
      tracker.seal('A', 'A:1', 'reply-A');
      tracker.seal('B', 'B:1', 'reply-B');
      await Promise.all([readA.mock.results[0].value, readB.mock.results[0].value]);
      expect(publishA).not.toHaveBeenCalled();
      expect(publishB).toHaveBeenCalledWith('reply-B', [{ kind: 'memory', key: 'user_tea.md', title: 'Tea', action: 'created' }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['claude-code', 'Write', 'file_path'], ['claude-code', 'Edit', 'file_path'],
    ['pi', 'write', 'path'], ['pi', 'edit', 'path'], ['codex', 'file_change', 'changes'],
  ] as const)('attributes only the confirmed %s %s file, excluding a concurrent sibling', async (source, name, field) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-tool-'));
    try {
      const dir = path.join(root, '.cindy', 'memory');
      await mkdir(dir, { recursive: true });
      const tracker = createBotLearningTracker(), publish = vi.fn();
      const read = vi.fn(await createProjectMemoryReceipts(root));
      tracker.markProjectTeammate('s', read);
      tracker.observe('s', 'i:1', publish);
      const file = path.join('.cindy', 'memory', 'user_tea.md');
      const body = '---\ntitle: Tea\ndescription: Preferred drink\ntype: user\n---\noolong';
      await writeFile(path.join(root, file), body);
      await writeFile(path.join(dir, 'user_other.md'), body);
      const input = field === 'changes' ? { changes: [{ path: file, kind: { type: 'add' } }] } : { [field]: file };
      successfulWrite(tracker, 's', 'i:1', source, name, input);
      tracker.seal('s', 'i:1', 'reply');
      await read.mock.results[0].value;
      expect(publish).toHaveBeenCalledExactlyOnceWith('reply', [
        { kind: 'memory', key: 'user_tea.md', title: 'Tea', action: 'created' },
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['into', 'out of'])('attributes a successful Codex move %s memory only to its destination', async direction => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-move-'));
    try {
      const dir = path.join(root, '.cindy', 'memory');
      await mkdir(dir, { recursive: true });
      const memoryFile = path.join(dir, 'user_tea.md'), stagingFile = path.join(root, 'staged.md');
      const from = direction === 'into' ? stagingFile : memoryFile;
      const to = direction === 'into' ? memoryFile : stagingFile;
      const body = '---\ntitle: Tea\ndescription: Drink\ntype: user\n---\noolong';
      await writeFile(from, body);
      const tracker = createBotLearningTracker(), publish = vi.fn();
      const read = vi.fn(await createProjectMemoryReceipts(root));
      tracker.markProjectTeammate('s', read);
      tracker.observe('s', 'i:1', publish);
      await rename(from, to);
      // Another task can recreate the old name after a move out; it is not our save.
      if (direction === 'out of') await writeFile(from, body + '\nAnother writer');
      successfulWrite(tracker, 's', 'i:1', 'codex', 'file_change', {
        changes: [{ path: from, kind: { type: 'update', move_path: to } }],
      });
      tracker.seal('s', 'i:1', 'reply');
      await read.mock.results[0].value;
      if (direction === 'into') expect(publish).toHaveBeenCalledWith('reply', [
        { kind: 'memory', key: 'user_tea.md', title: 'Tea', action: 'created' },
      ]);
      else expect(publish).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Same tool ID can exist across sessions/turns. A failed, child or unknown
  // result cannot authorize a directory change produced by a different writer.
  it.each(['failed', 'unknown', 'omitted', 'unpaired', 'wrong-session', 'wrong-turn', 'background', 'child', 'read', 'shell', 'outside'])
  ('does not claim a real file change from %s tool evidence', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-unconfirmed-'));
    try {
      const dir = path.join(root, '.cindy', 'memory');
      await mkdir(dir, { recursive: true });
      const tracker = createBotLearningTracker(), publish = vi.fn();
      const read = vi.fn(await createProjectMemoryReceipts(root));
      tracker.markProjectTeammate('s', read);
      tracker.observe('s', 'i:1', publish);
      const file = mode === 'outside' ? path.join(root, 'user_tea.md') : path.join(dir, 'user_tea.md');
      const scope = mode === 'background' ? { turnScope: 'background' as const }
        : mode === 'child' ? { agentMeta: { parentUuid: 'child' } } : {};
      if (mode !== 'unpaired') tracker.noteToolEvent('s', 'i:1', { type: 'tool_use', source: 'claude-code', ...scope,
        data: { toolUseId: 'write', toolName: mode === 'read' ? 'Read' : mode === 'shell' ? 'Bash' : 'Write', input: { file_path: file } } });
      await writeFile(path.join(dir, 'user_tea.md'), '---\ntitle: Tea\ndescription: Drink\ntype: user\n---\noolong');
      tracker.noteToolEvent(mode === 'wrong-session' ? 'other' : 's', mode === 'wrong-turn' ? 'i:0' : 'i:1', {
        type: 'tool_result_full', source: 'claude-code', ...scope,
        data: { toolUseId: 'write', ...(mode === 'unknown' ? {} : { isError: mode === 'failed' }),
          ...(mode === 'omitted' ? { outputOmitted: 'oversized' } : {}) },
      });
      tracker.seal('s', 'i:1', 'reply');
      await read.mock.results[0].value;
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
