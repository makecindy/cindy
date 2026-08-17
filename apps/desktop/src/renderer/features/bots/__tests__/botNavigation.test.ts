import { describe, expect, it } from 'vitest';

import { shouldDeferCanonicalBotSessionNavigation } from '../botNavigation';

describe('shouldDeferCanonicalBotSessionNavigation', () => {
  it.each([
    ['Bot settings are open', { settingsOpen: true, addOpen: false, addRequested: false }],
    ['the add dialog is open', { settingsOpen: false, addOpen: true, addRequested: false }],
    [
      'the add route was requested before dialog state catches up',
      { settingsOpen: false, addOpen: false, addRequested: true },
    ],
  ])('defers navigation while %s', (_label, input) => {
    expect(shouldDeferCanonicalBotSessionNavigation(input)).toBe(true);
  });

  it('allows canonical Session navigation after overlays close', () => {
    expect(
      shouldDeferCanonicalBotSessionNavigation({
        settingsOpen: false,
        addOpen: false,
        addRequested: false,
      }),
    ).toBe(false);
  });
});
