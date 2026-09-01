import { describe, expect, it } from 'vitest';

import { persistableSessionEffort, sessionPatchToRow } from '../mapper';

describe('persistableSessionEffort', () => {
  it('keeps legal enum values and drops runtime placeholders', () => {
    expect(persistableSessionEffort('high')).toBe('high');
    expect(persistableSessionEffort(' xhigh ')).toBe('xhigh');
    expect(persistableSessionEffort(null)).toBeUndefined();
    expect(persistableSessionEffort(undefined)).toBeUndefined();
    expect(persistableSessionEffort('')).toBeUndefined();
    expect(persistableSessionEffort('   ')).toBeUndefined();
  });
});

describe('sessionPatchToRow effort persistence', () => {
  it('writes a legal effort and omits null or blank placeholders', () => {
    expect(sessionPatchToRow({ model: 'gpt-5.6', effort: 'low' })).toEqual(
      expect.objectContaining({ model: 'gpt-5.6', effort: 'low' }),
    );
    expect(sessionPatchToRow({ model: 'grok-4.6', effort: null }).effort).toBeUndefined();
    expect(sessionPatchToRow({ model: 'grok-4.6', effort: '' }).effort).toBeUndefined();
    expect(sessionPatchToRow({ model: 'grok-4.6' }).effort).toBeUndefined();
  });
});
