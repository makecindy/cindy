import { describe, expect, it } from 'vitest';

import { stripGoalVerdictBlock } from '../goalVerdict';

describe('stripGoalVerdictBlock', () => {
  it('strips a trailing fenced json verdict block', () => {
    const input = 'I added the test and it passes.\n\n```json\n{"goal_status":"complete","reason":"green"}\n```';
    expect(stripGoalVerdictBlock(input)).toBe('I added the test and it passes.');
  });

  it('strips a fenced block without the json language tag', () => {
    const input = 'Working on it.\n```\n{"goal_status":"continue","reason":"wip"}\n```';
    expect(stripGoalVerdictBlock(input)).toBe('Working on it.');
  });

  it('strips a trailing bare verdict object when there is no fence', () => {
    const input = 'Done.\n{"goal_status":"complete","reason":"ok"}';
    expect(stripGoalVerdictBlock(input)).toBe('Done.');
  });

  it('leaves content unchanged when there is no verdict', () => {
    const input = 'Just a normal reply with some `code` and a list.';
    expect(stripGoalVerdictBlock(input)).toBe(input);
  });

  it('does not strip a goal_status mention in the MIDDLE of the text', () => {
    const input = 'The field {"goal_status":"continue"} is what I emit, then I keep writing.';
    expect(stripGoalVerdictBlock(input)).toBe(input);
  });

  it('handles empty / non-string input', () => {
    expect(stripGoalVerdictBlock('')).toBe('');
    expect(stripGoalVerdictBlock(undefined as unknown as string)).toBe(undefined as unknown as string);
  });

  // ── intake goal_setup 块同样要剥 ──
  it('strips a trailing fenced goal_setup block (intake turn)', () => {
    const input =
      '"试试goal功能" 作为目标太宽泛,我无法判定何时算完成。请补充具体对象和完成标准。\n\n```json\n{"goal_setup":true,"ready":false,"objective":"试试goal功能","maxTurns":null,"budgetTokens":null,"noProgressLimit":3,"note":"目标过于宽泛,需用户补充。"}\n```';
    expect(stripGoalVerdictBlock(input)).toBe(
      '"试试goal功能" 作为目标太宽泛,我无法判定何时算完成。请补充具体对象和完成标准。',
    );
  });

  it('strips a trailing bare goal_setup object', () => {
    const input = 'Ready to go.\n{"goal_setup":true,"ready":true,"objective":"x","maxTurns":20,"budgetTokens":null,"noProgressLimit":3,"note":"ok"}';
    expect(stripGoalVerdictBlock(input)).toBe('Ready to go.');
  });
});
