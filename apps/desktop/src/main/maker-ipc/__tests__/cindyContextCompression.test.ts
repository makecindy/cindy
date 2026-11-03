import { describe, expect, it } from 'vitest';

import { decideCindyCompression } from '../cindyContextCompression';

describe('decideCindyCompression', () => {
  it('does nothing remotely', () => {
    expect(
      decideCindyCompression({ local: false, bytes: 'violated', tokens: 'violated' }),
    ).toBe('none');
  });

  it.each(['violated', 'unknown', 'ok'] as const)('rebuilds oversized image history with token budget %s', (tokens) => {
    expect(
      decideCindyCompression({ local: true, bytes: 'violated', tokens }),
    ).toBe('rebuild');
  });

  it('rebuilds when only the token budget is violated', () => {
    expect(
      decideCindyCompression({ local: true, bytes: 'ok', tokens: 'violated' }),
    ).toBe('rebuild');
  });

  it('does nothing when both budgets are ok or unknown', () => {
    expect(decideCindyCompression({ local: true, bytes: 'ok', tokens: 'ok' })).toBe('none');
    expect(
      decideCindyCompression({ local: true, bytes: 'unknown', tokens: 'unknown' }),
    ).toBe('none');
    expect(decideCindyCompression({ local: true, bytes: 'unknown', tokens: 'ok' })).toBe(
      'none',
    );
    expect(decideCindyCompression({ local: true, bytes: 'ok', tokens: 'unknown' })).toBe(
      'none',
    );
  });

  it('rebuilds when tokens are violated and bytes are unknown', () => {
    expect(
      decideCindyCompression({ local: true, bytes: 'unknown', tokens: 'violated' }),
    ).toBe('rebuild');
  });
});
