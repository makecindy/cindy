import { describe, expect, it } from 'vitest';

import { isRetainableProjectSession, isRetainableProjectSessionSource } from '../sessionSource.js';

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

describe('isRetainableProjectSession', () => {
  it.each(['desktop', 'plugin'])(
    'excludes %s workers but retains normal tasks and leads',
    (source) => {
      expect(isRetainableProjectSession({ source, orcaRole: 'worker' })).toBe(false);
      for (const orcaRole of [undefined, null, 'lead']) {
        expect(isRetainableProjectSession({ source, orcaRole })).toBe(true);
      }
    },
  );

  it.each([undefined, null, 'scheduler', 'bot', 'review', 'future-source'])(
    'does not admit non-project source %j',
    (source) => expect(isRetainableProjectSession({ source })).toBe(false),
  );
});
