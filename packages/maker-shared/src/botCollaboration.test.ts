import { describe, expect, it } from 'vitest';
import {
  BOT_INTERJECTION_PREVIEW_MAX,
  botInterjectionPreview,
  placeBotTaskCardsAfterIntroduction,
  readBotCollaborationMeta,
} from './botCollaboration.js';

describe('task card placement', () => {
  const classify = (s: string) =>
    s.startsWith('user')
      ? ('boundary' as const)
      : s.startsWith('card')
        ? ('task' as const)
        : s.startsWith('text')
          ? ('prose' as const)
          : ('other' as const);
  it('moves only anchors, preserving tools, prose and each task exactly once', () => {
    const input = ['user', 'tool', 'card1', 'result', 'card2', 'text intro', 'text more'];
    expect(placeBotTaskCardsAfterIntroduction(input, classify)).toEqual([
      'user',
      'tool',
      'result',
      'text intro',
      'card1',
      'card2',
      'text more',
    ]);
    expect(input[2]).toBe('card1');
  });
  it('never crosses even a hidden completion trigger, or moves an already introduced card', () => {
    const input = ['user', 'card1', 'user synthetic', 'text completion', 'card2'];
    expect(placeBotTaskCardsAfterIntroduction(input, classify)).toEqual(input);
  });
});

it('uses the launch explanation even if a preliminary reply preceded dispatch', () => {
  const classify = (s: string) => s === 'user' ? 'boundary' as const : s === 'card' ? 'task' as const : 'prose' as const;
  expect(placeBotTaskCardsAfterIntroduction(['user', 'Looking into it', 'card', 'Started the background task'], classify))
    .toEqual(['user', 'Looking into it', 'Started the background task', 'card']);
});

describe('result receipt title compatibility', () => {
  const receipt = { v: 1, role: 'delegation-result', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Cindy',
    toBotId: null, toBotName: 'Cindy', parentSessionId: 'parent', childSessionId: 'child', objective: 'Instructions',
    result: { runSequence: 1, status: 'completed', text: 'Result', artifacts: [] } };
  it('reads old receipts and preserves an optional frozen title', () => {
    expect(readBotCollaborationMeta(receipt)?.result).toEqual(receipt.result);
    expect(readBotCollaborationMeta({ ...receipt, result: { ...receipt.result, title: 'Task title' } })?.result?.title).toBe('Task title');
  });
  it('rejects a malformed title without turning it into UI text', () => {
    expect(readBotCollaborationMeta({ ...receipt, result: { ...receipt.result, title: 42 } })).toBeNull();
  });
});

it('validates exact completion identities and deduplicates frozen attachments', async () => {
  const { taskResultClientIdForInput, readBotTaskResults } = await import('./botCollaboration');
  expect(taskResultClientIdForInput('bot-delegation-completion:job')).toBe('bot-delegation-result:job:1');
  expect(taskResultClientIdForInput('bot-delegation-completion:job:2')).toBe('bot-delegation-result:job:2');
  for (const value of ['human', 'bot-delegation-completion:job:0', 'bot-delegation-completion:job:2:other'])
    expect(taskResultClientIdForInput(value)).toBeNull();
  expect(readBotTaskResults([{}, null])).toEqual([]);
  const card = { v: 1, role: 'delegation-result', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Cindy',
    toBotId: null, toBotName: 'Cindy', parentSessionId: 'parent', childSessionId: 'child', objective: 'Report',
    result: { runSequence: 1, status: 'completed', text: 'Saved', artifacts: [] } };
  expect(readBotTaskResults([card, {}, card])).toEqual([card]);
});

describe('interjection preview', () => {
  const trace = { v: 1, role: 'interjection', delegationId: 'job', fromBotId: 'bot', fromBotName: 'Cindy',
    toBotId: null, toBotName: 'Cindy', parentSessionId: 'parent', childSessionId: 'child', objective: 'Report' };
  it('keeps old traces without a preview readable', () => {
    expect(readBotCollaborationMeta(trace)).not.toHaveProperty('interjectionPreview');
  });
  it('keeps only a bounded first line, and only on interjection traces', () => {
    expect(readBotCollaborationMeta({ ...trace, interjectionPreview: '\n  测试也要覆盖断网重连  \n私有第二行' })?.interjectionPreview)
      .toBe('测试也要覆盖断网重连');
    expect(Array.from(readBotCollaborationMeta({ ...trace, interjectionPreview: '长'.repeat(500) })!.interjectionPreview!))
      .toHaveLength(BOT_INTERJECTION_PREVIEW_MAX);
    expect(readBotCollaborationMeta({ ...trace, interjectionPreview: 42 })).not.toHaveProperty('interjectionPreview');
    expect(readBotCollaborationMeta({ ...trace, interjectionPreview: '   ' })).not.toHaveProperty('interjectionPreview');
    expect(readBotCollaborationMeta({ ...trace, role: 'delegation-request', interjectionPreview: 'x' }))
      .not.toHaveProperty('interjectionPreview');
  });
  it('derives the persisted preview from the first non-empty line', () => {
    expect(botInterjectionPreview('\n\n补充：带风险清单。\n读取 /workspace/AGENTS.md')).toBe('补充：带风险清单。');
    expect(botInterjectionPreview('')).toBe('');
  });
});
