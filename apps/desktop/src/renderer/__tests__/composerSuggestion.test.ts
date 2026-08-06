import { describe, expect, it, vi } from 'vitest';

import {
  buildComposerSuggestionEntries,
  firstEnabledSuggestionIndex,
  nextEnabledSuggestionIndex,
  resolveComposerAtActivation,
  type ComposerSuggestionAction,
} from '@/lib/composerSuggestion';

const actions: ComposerSuggestionAction[] = [
  { id: 'attach-files', label: 'Add files', run: vi.fn() },
  { id: 'new-goal', label: 'New goal', run: vi.fn() },
  { id: 'plan-mode', label: 'Plan mode', checked: false, run: vi.fn() },
  { id: 'add-extra-dir', label: 'Add directory', run: vi.fn() },
];

describe('composerSuggestion', () => {
  it('显式的 + synthetic 激活优先于光标前残留的 typed @ run', () => {
    expect(
      resolveComposerAtActivation({
        typed: { from: 3, query: 'old' },
        syntheticAnchor: 7,
        syntheticQuery: 'new',
      }),
    ).toEqual({ activation: 'synthetic', from: 7, query: 'new' });
    expect(
      resolveComposerAtActivation({
        typed: { from: 3, query: 'old' },
        syntheticAnchor: null,
        syntheticQuery: null,
      }),
    ).toEqual({ activation: 'typed', from: 3, query: 'old' });
  });

  it('空查询按 Add、上下文、Plugin、引用目录动作装配', () => {
    const entries = buildComposerSuggestionEntries({
      query: '',
      actions,
      resources: [
        { type: 'browser-tab', name: 'Docs', relPath: 'cindy://browser/docs' },
        { type: 'agent', name: 'reviewer', relPath: '.claude/agents/reviewer.md' },
      ],
      plugins: [
        {
          item: {
            type: 'plugin-command',
            name: 'Cindy Art',
            relPath: 'art',
            pluginId: 'cindy-art',
          },
        },
      ],
    });

    expect(entries.map((entry) =>
      entry.kind === 'action' ? entry.action.id : `${entry.item.type}:${entry.item.name}`,
    )).toEqual([
      'attach-files',
      'new-goal',
      'plan-mode',
      'browser-tab:Docs',
      'agent:reviewer',
      'plugin-command:Cindy Art',
      'add-extra-dir',
    ]);
  });

  it('非空查询把动作与资源放进同一排序池，并排除 disabled 项', () => {
    const entries = buildComposerSuggestionEntries({
      query: 'plan',
      actions: [
        ...actions,
        {
          id: 'collaboration',
          label: 'Planning collaboration',
          disabled: true,
          run: vi.fn(),
        },
      ],
      resources: [
        { type: 'file', name: 'plan.md', relPath: 'docs/plan.md' },
      ],
      plugins: [],
    });

    expect(entries.some((entry) => entry.kind === 'action' && entry.action.id === 'plan-mode')).toBe(
      true,
    );
    expect(entries.some((entry) => entry.kind === 'resource' && entry.item.name === 'plan.md')).toBe(
      true,
    );
    expect(
      entries.some((entry) => entry.kind === 'action' && entry.action.id === 'collaboration'),
    ).toBe(false);
  });

  it('焦点移动会环绕并跳过 disabled 项', () => {
    const entries = buildComposerSuggestionEntries({
      query: '',
      actions: [
        { id: 'new-goal', label: 'Goal', disabled: true, run: vi.fn() },
        { id: 'plan-mode', label: 'Plan', checked: false, run: vi.fn() },
      ],
      resources: [],
      plugins: [],
    });

    expect(firstEnabledSuggestionIndex(entries)).toBe(1);
    expect(nextEnabledSuggestionIndex(entries, 0, 1)).toBe(1);
    expect(nextEnabledSuggestionIndex(entries, 1, 1)).toBe(1);
    expect(nextEnabledSuggestionIndex(entries, 1, -1)).toBe(1);
  });
});
