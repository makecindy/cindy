import { describe, expect, it } from 'vitest';
import { placeBotTaskCardsAfterIntroduction } from './botCollaboration.js';

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
