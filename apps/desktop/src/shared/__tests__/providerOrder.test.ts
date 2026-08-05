import { describe, expect, it } from 'vitest';

import {
  applyProviderOrder,
  mergeObservedProviderOrder,
  mergeVisibleProviderOrder,
  normalizeProviderOrder,
} from '../providerOrder.js';

describe('provider display order', () => {
  it('normalizes persisted values to bounded unique non-empty ids', () => {
    expect(normalizeProviderOrder(['openai', '', 'openai', 42, 'anthropic'])).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('applies known ids first and appends newly introduced providers in source order', () => {
    const providers = [{ id: 'xd' }, { id: 'anthropic' }, { id: 'openai' }, { id: 'xai' }];
    expect(
      applyProviderOrder(providers, ['openai', 'missing', 'xd']).map((provider) => provider.id),
    ).toEqual(['openai', 'xd', 'anthropic', 'xai']);
  });

  it('reorders visible providers without moving hidden provider slots', () => {
    expect(
      mergeVisibleProviderOrder(
        ['xd', 'hidden-anthropic', 'openai', 'hidden-xai', 'custom'],
        ['custom', 'xd', 'openai'],
      ),
    ).toEqual(['custom', 'hidden-anthropic', 'xd', 'hidden-xai', 'openai']);
  });

  it('rejects an invalid visible permutation by preserving the current order', () => {
    expect(mergeVisibleProviderOrder(['xd', 'openai'], ['xd', 'unknown'])).toEqual([
      'xd',
      'openai',
    ]);
  });

  it('appends newly observed providers before applying the visible order', () => {
    expect(
      mergeObservedProviderOrder(['xd', 'hidden-anthropic'], ['custom', 'xd', 'openai']),
    ).toEqual(['custom', 'hidden-anthropic', 'xd', 'openai']);
  });
});
