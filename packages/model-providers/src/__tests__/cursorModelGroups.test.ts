import { describe, expect, it } from 'vitest';
import { CURSOR_MODEL_GROUPS as groups, cursorModelGroup, providerModelDisplayGroups, providerModelDisplayGroupTitle } from '../cursorModelGroups.js';

describe('Cursor native model display groups', () => {
  it('keeps Auto separate from both documented pools and does not classify unknown first-party versions', () => {
    expect(cursorModelGroup('default', 'Auto')).toBe(groups.auto);
    expect(cursorModelGroup('grok-4.7', 'Grok 4.7')).toBe(groups.models);
    expect(cursorModelGroup('composer-2.5', 'Composer 2.5')).toBe(groups.models);
    expect(cursorModelGroup('claude-opus-5-5', 'Claude Opus 5.5')).toBe(groups.other);
    expect(cursorModelGroup('gpt-5.6-sol', 'GPT-5.6 Sol')).toBe(groups.other);
    expect(cursorModelGroup('grok-future', 'Future Grok')).toBeUndefined();
    expect(cursorModelGroup('composer-future', 'Future Composer')).toBeUndefined();
    expect(cursorModelGroup('opaque-new-offer', 'New model')).toBeUndefined();
  });
  it('prefers explicit native headings to the verified fallback and preserves new native groups', () => {
    expect(cursorModelGroup('claude-opus-5-5', 'Claude Opus 5.5', 'Cursor Models')).toBe(groups.models);
    expect(cursorModelGroup('grok-4.7', 'Grok 4.7', 'Other Models')).toBe(groups.other);
    expect(cursorModelGroup('opaque', 'Opaque model', 'Experimental')).toBe('cursor:native:Experimental');
  });
  it('partitions existing offers without changing their identity, order, or configuration', () => {
    const items = [
      { id: 'claude', group: groups.other, effort: 'medium' },
      { id: 'grok', group: groups.models, effort: 'xhigh' },
      { id: 'auto', group: groups.auto, effort: null },
      { id: 'composer', group: groups.models, fast: true },
      { id: 'future' },
    ];
    const result = providerModelDisplayGroups('cursor', items, item => item.group);
    expect(result.map(group => [group.group, group.items.map(item => item.id)])).toEqual([
      [groups.auto, ['auto']], [groups.models, ['grok', 'composer']], [groups.other, ['claude']], [null, ['future']],
    ]);
    expect(result[1].items[0]).toBe(items[1]);
    expect(result.flatMap(group => group.items)).toHaveLength(items.length);
    expect(items.map(item => item.id)).toEqual(['claude', 'grok', 'auto', 'composer', 'future']);
  });
  it('leaves other suppliers intact and never fabricates a group for an empty catalog', () => {
    const items = [{ id: 'grok', group: groups.models }, { id: 'claude', group: groups.other }];
    expect(providerModelDisplayGroups('other-account', items, item => item.group)).toEqual([{ group: null, items }]);
    expect(providerModelDisplayGroups('cursor', [], () => undefined)).toEqual([]);
  });
  it('retains the computer identity on remote pool headings', () => {
    const labels = { models: 'Cursor Models', other: 'Other Models' };
    expect(providerModelDisplayGroupTitle('Cursor', groups.models, labels)).toBe('Cursor Models');
    expect(providerModelDisplayGroupTitle('Cursor', groups.other, labels)).toBe('Other Models');
    expect(providerModelDisplayGroupTitle('blue mac · Cursor', groups.models, labels)).toBe('blue mac · Cursor · Cursor Models');
    expect(providerModelDisplayGroupTitle('Cursor', groups.auto, labels)).toBe('Cursor');
    expect(providerModelDisplayGroupTitle('Cursor', 'cursor:native:Experimental', labels)).toBe('Experimental');
  });
});
