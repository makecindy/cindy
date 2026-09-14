import { describe, expect, it } from 'vitest';

import { parseToolLoopErrorDetails } from './toolLoopError.js';

describe('parseToolLoopErrorDetails', () => {
  it('accepts bounded structured details', () => {
    expect(parseToolLoopErrorDetails({ kind: 'contract', count: 3 })).toEqual({
      kind: 'contract',
      count: 3,
    });
  });

  it.each([
    null,
    undefined,
    { kind: 'unknown', count: 3 },
    { kind: 'contract', count: 0 },
    { kind: 'contract', count: 100_001 },
    { kind: 'contract', count: 1.5 },
    { kind: 'contract', count: '3' },
  ])('rejects untrusted details: %j', (value) => {
    expect(parseToolLoopErrorDetails(value)).toBeUndefined();
  });
});
