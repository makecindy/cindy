import { describe, expect, it } from 'vitest';
import { projectWorkActivities, summarizeTeammateWork, teammateWorkSummaryText } from '../workActivityProjection.js';
import { botGroupProcessCard, readBotGroupProcessCard, readBotGroupProcessNotes, type BotGroupProcessMessage } from '../botGroupChat.js';
const ref = { groupId: 'group', executionId: 'execution', sessionId: 'lane', clientId: 'bot-group:group:execution:bot' };
const row = (clientId: string, role: string, content: unknown, agentMeta?: BotGroupProcessMessage['agentMeta']): BotGroupProcessMessage => ({ clientId, role, content, agentMeta });
const progress = (id: string, text: unknown) => row(id, 'assistant', text, { assistantPhase: 'commentary' });
// Unit regression for the 2026-11-01 report: a failed attempt dominated the
// collapsed summary even while useful work continued. Existing tests only
// checked retained error counts, not the text users actually saw.
it('shows the active action, then the latest action, without amplifying earlier failures', () => {
  const tool = (clientId: string, file: string) => ({ clientId, content: '', toolName: 'Read', toolInput: { file_path: `/repo/${file}` } });
  const children = [{ kind: 'tools', key: 'tools', toolCalls: [tool('failed', 'missing.md'), tool('active', 'skills.md'), tool('done', 'notes.md')],
    resultMap: new Map([['failed', 'Error: file not found'], ['done', 'notes']]) }];
  const activities = projectWorkActivities(children, true, true).activities;
  const summary = summarizeTeammateWork(activities);
  expect(summary.failedCount).toBe(1);
  expect(teammateWorkSummaryText(summary, true, key => key)).toBe('读取 skills.md');
  expect(teammateWorkSummaryText(summary, false, key => key)).toBe('读取 notes.md');
  expect(activities[0]).toMatchObject({ toolResult: 'Error: file not found' });
});

it.each([
  ['mcp__calendar__list_events', {}, 'Use calendar · list events'],
  ['mcp__helper__call_tool', { name: 'list_skills' }, 'Use helper · list skills'],
])('keeps the concrete MCP operation %s visible with localized wording', (toolName, toolInput, expected) => {
  const summary = summarizeTeammateWork(projectWorkActivities([{ kind: 'tools', key: 'tools', toolCalls: [
    { clientId: 'call', content: '', toolName, toolInput },
  ] }], true).activities);
  expect(teammateWorkSummaryText(summary, true, key => key, {
    verb: () => 'Use', intentVerb: () => 'Run', updateFilesLabel: () => 'Update files',
  })).toBe(expected);
});
// Unit: new optional locator contract and the same bounded history reader used by
// Desktop and Mobile group/Thread disclosures. Verify observable content boundaries.
describe('group process record', () => {
  it('posts a locator only; unsupported revisions are left to existing card fallback', () => {
    const card = botGroupProcessCard(ref);
    expect(readBotGroupProcessCard(card)).toEqual(ref);
    expect(readBotGroupProcessCard(botGroupProcessCard({ ...ref, deviceId: 'execution-mac' }))).toEqual({ ...ref, deviceId: 'execution-mac' });
    expect(readBotGroupProcessCard({ ...card, schemaRevision: 2 })).toBeNull();
    expect(readBotGroupProcessCard({ ...card, data: { ...ref, sessionId: '' } })).toBeNull();
    expect(card.fallback).toBe('');
    expect(Object.keys(card.data).sort()).toEqual(['clientId', 'executionId', 'groupId', 'sessionId']);
  });
  it('pages exactly one turn, excludes private text, reasoning, tools and final output', async () => {
    const source = row(ref.clientId, 'user', 'Group request');
    const first = progress('note1', [{ type: 'text', text: 'Checking feedback' }, { type: 'thinking', thinking: 'private reasoning' }]);
    const privateNote = row('private', 'assistant', 'Private reply', { assistantPhase: 'commentary', botPrivateReply: true });
    const second = progress('note2', 'Found the cause');
    const pages = new Map<string, BotGroupProcessMessage[]>([
      [source.clientId, [progress('previous', 'Earlier turn'), source, first]],
      [first.clientId, [source, first, privateNote, row('tool', 'tool_result', 'raw command'), second]],
      [second.clientId, [second, row('final', 'assistant', 'Answer', { turnCompleted: true }), progress('future', 'Another turn')]],
    ]);
    const cursors: string[] = [];
    const notes = await readBotGroupProcessNotes(ref, async cursor => { cursors.push(cursor); return pages.get(cursor)!; }, () => false);
    expect(notes).toEqual([{ id: 'note1', text: 'Checking feedback' }, { id: 'note2', text: 'Found the cause' }]);
    expect(cursors).toEqual([ref.clientId, 'note1', 'note2']);
  });
  it('never falls back to another turn when its anchor is absent', async () => {
    expect(await readBotGroupProcessNotes(ref, async () => [progress('other', 'Other turn')], () => false)).toEqual([]);
  });
  it('stops at the next user even without a final seal and ignores a cancelled read', async () => {
    const rows = [row(ref.clientId, 'user', 'Request'), progress('note', 'Partial result'), row('next', 'user', 'Next turn'), progress('other', 'Other result')];
    expect(await readBotGroupProcessNotes(ref, async () => rows, () => false)).toEqual([{ id: 'note', text: 'Partial result' }]);
    expect(await readBotGroupProcessNotes(ref, async () => rows, () => true)).toEqual([]);
  });
});

// Unit regression: stage prose used to be separated from one bottom activity log.
// Minimal input: initial thinking, note, failed command, note, retry, final seal.
// Exercise the actual reader + projection used by both group timelines; old note-only
// coverage could not detect lost/reordered tools or duplicated final answers.
it('keeps thinking and tool summaries between their original stage notes', async () => {
  const { readBotGroupProcessMessages, projectBotGroupProcess } = await import('../botGroupProcess.js');
  const { projectWorkActivities, summarizeTeammateWork } = await import('../workActivityProjection.js');
  const call = (id: string) => row(id, 'tool_use', { toolName: 'exec_command', input: { cmd: 'pnpm test' }, toolUseId: id });
  const rows = [row(ref.clientId, 'user', 'Request'), row('thinking', 'thinking', 'Reasoning'),
    progress('first', 'Checking'), call('failed'), { ...row('failure', 'tool_result', 'Command failed: exit code 1'), toolUseId: 'failed' },
    progress('second', 'Retrying'), call('retry'), { ...row('success', 'tool_result', 'Process exited with code 0'), toolUseId: 'retry' },
    row('final', 'assistant', 'Final answer', { assistantPhase: 'final_answer', turnCompleted: true }), progress('future', 'Other turn')]
    .map((message, index) => ({ ...message, createdAt: new Date(1700000000000 + index * 1000).toISOString() }));
  const messages = await readBotGroupProcessMessages(ref, async () => rows, () => false);
  const projection = projectBotGroupProcess(messages, false);
  expect(projection.segments.map(segment => segment.kind === 'content' ? segment.item.text : segment.items.map(item => item.kind))).toEqual([
    ['thinking'], 'Checking', ['tools'], 'Retrying', ['tools'],
  ]);
  const summaries = projection.segments.filter(segment => segment.kind === 'work').map(segment =>
    summarizeTeammateWork(projectWorkActivities(segment.items, false).activities));
  expect(summaries.map(summary => summary.failedCount)).toEqual([0, 1, 0]);
  expect(projection.durationMs).toBe(8000);
  expect(JSON.stringify(messages)).not.toContain('Reasoning');
  expect(JSON.stringify(messages)).not.toContain('Final answer');
});

// Unit regression: a successful retry of the same read must not erase the failed
// attempt from teammate summaries or details. Ordinary task read dedup stays intact.
it('retains a failed read followed by a successful retry within one stage', async () => {
  const { projectBotGroupProcess } = await import('../botGroupProcess.js');
  const { projectWorkActivities, summarizeTeammateWork } = await import('../workActivityProjection.js');
  const call = (id: string) => row(id, 'tool_use', { toolName: 'Read', input: { file_path: '/tmp/report.txt' }, toolUseId: id });
  const projection = projectBotGroupProcess([
    call('failed'), { ...row('failure', 'tool_result', 'Error: file not found'), toolUseId: 'failed' },
    call('retry'), { ...row('success', 'tool_result', 'Report content'), toolUseId: 'retry' },
  ], false);
  const segment = projection.segments[0];
  expect(segment.kind).toBe('work');
  if (segment.kind !== 'work') throw new Error('Expected one work segment');
  const activities = projectWorkActivities(segment.items, false, true).activities;
  expect(summarizeTeammateWork(activities)).toMatchObject({ toolCount: 2, failedCount: 1 });
  expect(projectWorkActivities(segment.items, false).activities).toHaveLength(1);
});

// PR review: Pi text has no assistantPhase. Exercise actual reader/projection,
// including a legacy unsealed final, so grouping cannot erase stage notes.
it('preserves unlabelled Pi stage text while excluding sealed and legacy final answers', async () => {
  const { readBotGroupProcessMessages, projectBotGroupProcess } = await import('../botGroupProcess.js');
  const source = row(ref.clientId, 'user', 'Request');
  const note = row('note', 'assistant', 'Checking feedback');
  const tool = row('tool', 'tool_use', { toolName: 'Read', input: { path: '/tmp/feedback' } });
  const active = [source, note, tool, row('next', 'assistant', 'Found the cause')];
  const texts = (messages: BotGroupProcessMessage[], running: boolean) => projectBotGroupProcess(messages, running)
    .segments.flatMap(segment => segment.kind === 'content' ? [segment.item.text] : []);
  expect(texts(await readBotGroupProcessMessages(ref, async () => active, () => false), true))
    .toEqual(['Checking feedback', 'Found the cause']);
  for (const agentMeta of [undefined, { turnCompleted: true }, { assistantPhase: 'final_answer' }]) {
    const completed = [...active, row('final', 'assistant', 'Final answer', agentMeta)];
    expect(texts(await readBotGroupProcessMessages(ref, async () => completed, () => false), false))
      .toEqual(['Checking feedback', 'Found the cause']);
  }
});
