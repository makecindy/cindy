import { describe, expect, it } from 'vitest';

import { normalizeSubagentObservation } from './subagentObservation.js';

describe('normalizeSubagentObservation', () => {
  it('normalizes one harness-neutral spawn identity', () => {
    expect(
      normalizeSubagentObservation({
        kind: 'spawn',
        logicalSubagentId: ' child-1 ',
        parentToolUseId: ' tool-1 ',
        identityAliases: ['card-1', 'card-1', 42],
        providerRunIds: ['thread-1', 'thread-1', null],
      }),
    ).toEqual({
      kind: 'spawn',
      logicalSubagentId: 'child-1',
      parentToolUseId: 'tool-1',
      identityAliases: ['card-1'],
      providerRunIds: ['thread-1'],
    });
  });

  it.each([
    undefined,
    {},
    { kind: 'control', logicalSubagentId: 'child-1' },
    { kind: 'spawn', logicalSubagentId: '' },
    { kind: 'progress', logicalSubagentId: 'x'.repeat(513) },
  ])('fails closed for an invalid marker', (value) => {
    expect(normalizeSubagentObservation(value)).toBeNull();
  });
});
