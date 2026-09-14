import { describe, expect, it } from 'vitest';

import { isRetainableProjectSessionSource } from '../sessionSource.js';

describe('isRetainableProjectSessionSource', () => {
  it.each(['desktop', 'plugin'] as const)('accepts the durable %s project source', (source) => {
    expect(isRetainableProjectSessionSource(source)).toBe(true);
  });

  it.each([undefined, null, '', 'scheduler', 'future-source'])(
    'fails closed for missing or unknown source %j',
    (source) => {
      expect(isRetainableProjectSessionSource(source)).toBe(false);
    },
  );
});
