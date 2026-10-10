import { describe, expect, it } from 'vitest';
import { defaultModelFor } from '../model-defaults.js';
describe('Cursor scheduler model identity', () => {
  it('keeps the Cursor native default rather than selecting a Claude model', () => {
    expect(defaultModelFor('cursor')).toBe('cursor-default');
  });
});
