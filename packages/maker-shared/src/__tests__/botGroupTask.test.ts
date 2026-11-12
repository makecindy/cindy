import { describe, expect, it } from 'vitest';
import type { BotCollaborationMeta } from '../botCollaboration';
import { botGroupLiveTaskReplyLine, botGroupLiveTaskStateOfPhase, buildBotGroupLiveTaskCard, buildBotGroupTaskCard, parseBotGroupTaskCardView, readBotGroupLiveTaskCard, readBotGroupTaskCard, type BotGroupTaskCardLabels } from '../botGroupTask';

const meta: BotCollaborationMeta = {
  v: 1, role: 'delegation-request', delegationId: 'task-1', fromBotId: 'bot-a', fromBotName: 'LiZi',
  toBotId: null, toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-1', objective: 'Write the launch post',
};
const en: BotGroupTaskCardLabels = { task: 'Task', untitled: 'Background task',
  states: { started: 'In progress', waiting: 'Waiting for your confirmation', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', 'timed-out': 'Timed out' } };
const zh: BotGroupTaskCardLabels = { task: '任务', untitled: '后台任务',
  states: { started: '进行中', waiting: '等你确认', completed: '已完成', failed: '失败了', cancelled: '已取消', 'timed-out': '已超时' } };

describe('group task card (bot-group-chat.md §10)', () => {
  it('builds a card older clients read as one fallback line and new clients read back as the view', () => {
    const card = buildBotGroupTaskCard({ meta, state: 'started', title: 'Launch post' }, en);
    expect(card).toMatchObject({ type: 'card', namespace: 'cindy.task', schemaRevision: 1, fallback: '[Task] Launch post · In progress' });
    expect(readBotGroupTaskCard(card)).toEqual({ meta, state: 'started', title: 'Launch post' });
    expect(parseBotGroupTaskCardView(card.data)).toEqual({ meta, state: 'started', title: 'Launch post' });
  });

  it('writes the fallback line in the sender\'s language and keeps the card data language-free', () => {
    expect(buildBotGroupTaskCard({ meta, state: 'timed-out', title: '' }, zh)).toMatchObject({
      fallback: '[任务] 后台任务 · 已超时', data: { meta, state: 'timed-out', title: '后台任务' } });
    expect(buildBotGroupTaskCard({ meta, state: 'timed-out', title: '' }, en).fallback).toBe('[Task] Background task · Timed out');
  });

  it('keeps what a waiting task asks for, clipped, and never a tool argument block', () => {
    const summary = `1. Which audience?（Developers / Everyone）\n${'x'.repeat(500)}`;
    const card = buildBotGroupTaskCard({ meta, state: 'waiting', title: 'Launch post', summary }, en);
    expect(card.data.summary!.length).toBeLessThanOrEqual(400);
    expect(card.fallback.startsWith('[Task] Launch post · Waiting for your confirmation: 1. Which audience?')).toBe(true);
    expect(readBotGroupTaskCard(card)?.summary).toBe(card.data.summary);
  });

  it.each([
    ['wrong namespace', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }, en), namespace: 'cindy.plan' }],
    ['future revision', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }, en), schemaRevision: 2 }],
    ['unknown state', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }, en), data: { meta, state: 'paused', title: 't' } }],
    ['result receipt instead of the anchor', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }, en), data: { meta: { ...meta, role: 'delegation-result' }, state: 'started', title: 't' } }],
    ['missing meta', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }, en), data: { state: 'started', title: 't' } }],
    ['not a card', { type: 'text', text: '[Task] t · In progress' }],
  ])('rejects a malformed card (%s) so the message falls back to text', (_label, block) => {
    expect(readBotGroupTaskCard(block)).toBeNull();
  });

  it('clips a title or summary before an emoji rather than through it', () => {
    // 118 characters then an emoji: a cut at 119 UTF-16 units would keep only its high surrogate.
    const title = `${'a'.repeat(118)}😀 and more`;
    const card = buildBotGroupTaskCard({ meta, state: 'waiting', title, summary: `${'b'.repeat(398)}😀 tail` }, en);
    expect(card.data.title).toBe(`${'a'.repeat(118)}…`);
    expect(card.data.summary).toBe(`${'b'.repeat(398)}…`);
    expect(card.fallback).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('rejects a view whose task anchor is not a delegation request', () => {
    expect(parseBotGroupTaskCardView({ meta: { ...meta, role: 'interjection' }, state: 'completed', title: 't' })).toBeNull();
    expect(parseBotGroupTaskCardView(null)).toBeNull();
  });
});

// 2026-11-11 acceptance: a task that ended its turn asking the owner to confirm showed 「已完成」.
describe('live group task card (revision 2)', () => {
  it.each([['running', 'running'], ['needs-interaction', 'waiting'], ['completed', 'idle'], ['error', 'failed'], ['idle', undefined]] as const)(
    'shows a task whose phase is %s as %s, never as done', (phase, state) => {
      expect(botGroupLiveTaskStateOfPhase(phase)).toBe(state);
    });

  // 2026-11-11 owner decision: the card says where the task stopped after its state. The line is
  // optional data in revision 2, so cards posted before it and clients that ignore it still read.
  it('carries where the task stopped after the state, and reads cards without it', () => {
    const labels = { task: 'Task', untitled: 'Untitled task', states: { running: 'In progress', waiting: 'Waiting for a reply', idle: 'Idle', failed: 'Failed' } };
    const view = { taskId: 'task-1', deviceId: null, title: 'Fix login', state: 'idle' as const, requesterName: 'Ann', botName: 'Cindy',
      prUrl: 'https://github.com/makecindy/cindy/pull/42' };
    const card = buildBotGroupLiveTaskCard({ ...view, summary: 'Preflight failed: lint' }, labels);
    expect(card).toMatchObject({ schemaRevision: 2, fallback: '[Task] Fix login · Idle · Preflight failed: lint · https://github.com/makecindy/cindy/pull/42' });
    expect(readBotGroupLiveTaskCard(card)?.summary).toBe('Preflight failed: lint');
    const { summary: _none, ...earlier } = card.data;
    expect(readBotGroupLiveTaskCard({ ...card, data: earlier })).toEqual(view);
    expect(readBotGroupLiveTaskCard({ ...card, data: { ...earlier, summary: 7 } })).toBeNull();
  });

  it.each([
    ['## Preflight **failed**\n\nmore', 'Preflight failed'],
    ['\n\n- [x] Shipped `fix-login` in [#42](https://github.com/makecindy/cindy/pull/42)', 'Shipped fix-login in #42'],
    ['> Should I approve Pi 1.5.2?', 'Should I approve Pi 1.5.2?'],
    ['   \n', ''],
    ['x'.repeat(200), `${'x'.repeat(79)}…`],
  ])('takes the first line of a reply as plain text, clipped (%j)', (reply, line) => {
    expect(botGroupLiveTaskReplyLine(reply)).toBe(line);
  });
});
