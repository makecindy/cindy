import { describe, expect, it } from 'vitest';

import { showCindyGroup, type ImBotIdentity } from '../imBotVisibility';

function identity(overrides: Partial<ImBotIdentity>): ImBotIdentity {
  return { region: 'cn', mode: 'cloud', membershipKind: 'personal', ...overrides };
}

describe('imBotVisibility', () => {
  it.each(['cn', 'dev', 'global'] as const)(
    'shows official bots to %s personal and organization cloud accounts',
    (region) => {
      expect(showCindyGroup(identity({ region }))).toBe(true);
      expect(showCindyGroup(identity({ region, membershipKind: 'org' }))).toBe(true);
    },
  );

  it.each(['cn', 'dev', 'global'] as const)(
    'hides official bots in %s local mode while retaining the signed-out introduction',
    (region) => {
      expect(showCindyGroup(identity({ region, mode: 'local', membershipKind: null }))).toBe(false);
      expect(showCindyGroup(identity({ region, mode: 'signed-out', membershipKind: null }))).toBe(
        true,
      );
    },
  );
});
