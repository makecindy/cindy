import { describe, expect, it } from 'vitest';

import { tagTier } from '../xdt-helper/list_available_models.js';

describe('list_available_models tier metadata', () => {
  it('prefers category/group metadata and falls back to codex/ ids', () => {
    expect(tagTier([
      { id: 'plain-id', label: 'Budget', group: 'gpt-budget' },
      { id: 'codex/gpt-5.5', label: 'Standard', group: 'gpt' },
      { id: 'plain-category', label: 'Category budget', category: 'gpt-budget', group: 'gpt' },
      { id: 'codex/legacy', label: 'Legacy budget' },
    ])).toEqual([
      { id: 'plain-id', label: 'Budget', group: 'gpt-budget', tier: 'budget' },
      { id: 'codex/gpt-5.5', label: 'Standard', group: 'gpt', tier: 'standard' },
      {
        id: 'plain-category',
        label: 'Category budget',
        category: 'gpt-budget',
        group: 'gpt',
        tier: 'budget',
      },
      { id: 'codex/legacy', label: 'Legacy budget', tier: 'budget' },
    ]);
  });
});
