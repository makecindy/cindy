import { describe, expect, it } from 'vitest';

import { deriveStableComposerHistory } from '../composerHistoryProjection';

describe('deriveStableComposerHistory', () => {
  it('keeps the same array while only assistant streaming content changes', () => {
    const previous = deriveStableComposerHistory(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
      ],
      [],
    );
    const next = deriveStableComposerHistory(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a growing response' },
      ],
      previous,
    );

    expect(next).toBe(previous);
  });

  it('returns a new newest-first projection when user rows change', () => {
    const previous = deriveStableComposerHistory([{ role: 'user', content: 'first' }], []);
    const next = deriveStableComposerHistory(
      [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second', quotesEncoded: true },
      ],
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next).toEqual([{ content: 'second', quotesEncoded: true }, { content: 'first' }]);
  });
});
