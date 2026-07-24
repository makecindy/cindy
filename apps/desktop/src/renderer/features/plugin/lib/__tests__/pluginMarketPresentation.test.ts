import { describe, expect, it } from 'vitest';
import { pluginPresentationOrigin } from '../pluginMarketPresentation';

describe('pluginPresentationOrigin', () => {
  it('maps public plugins independently of their default-install policy', () => {
    expect(pluginPresentationOrigin({ scope: 'public' })).toBe('public');
  });

  it('maps organization plugins to their organization source', () => {
    expect(pluginPresentationOrigin({ scope: 'organization' })).toBe('organization');
  });

  it('maps personal plugins to their personal source', () => {
    expect(pluginPresentationOrigin({ scope: 'personal' })).toBe('personal');
  });

  it.each([null, undefined])('keeps unmatched installed plugins local', (item) => {
    expect(pluginPresentationOrigin(item)).toBe('local');
  });
});
