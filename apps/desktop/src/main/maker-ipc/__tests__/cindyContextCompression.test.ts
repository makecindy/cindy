import { describe, expect, it } from 'vitest';

import { afterStripAttempt, decideCindyCompression } from '../cindyContextCompression';

describe('decideCindyCompression', () => {
  it('does nothing remotely', () => {
    expect(
      decideCindyCompression({ local: false, bytes: 'violated', tokens: 'violated' }),
    ).toBe('none');
  });

  it('strips when the byte budget is violated, even if tokens are also over', () => {
    expect(
      decideCindyCompression({ local: true, bytes: 'violated', tokens: 'violated' }),
    ).toBe('strip');
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

describe('afterStripAttempt', () => {
  it('finishes after a successful strip', () => {
    expect(afterStripAttempt('recovered', { local: true, tokens: 'violated' })).toBe('done');
  });

  it('rebuilds when strip fails', () => {
    expect(afterStripAttempt('failed', { local: true, tokens: 'ok' })).toBe('rebuild');
  });

  it('re-evaluates after a healthy measurement, so token overflow still rebuilds', () => {
    expect(afterStripAttempt('not-needed', { local: true, tokens: 'violated' })).toBe(
      'rebuild',
    );
    expect(afterStripAttempt('not-needed', { local: true, tokens: 'ok' })).toBe('none');
  });

  it('does not rebuild when the turn is still running', () => {
    expect(afterStripAttempt('busy', { local: true, tokens: 'violated' })).toBe('none');
  });

  it('does not rebuild when the owner snapshot is stale', () => {
    expect(afterStripAttempt('stale', { local: true, tokens: 'violated' })).toBe('none');
  });
});
