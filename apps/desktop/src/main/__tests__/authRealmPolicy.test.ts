import { describe, expect, it } from 'vitest';
import { canRestoreAuthSessionForMembership } from '../authRealmPolicy';

describe('canRestoreAuthSessionForMembership', () => {
  it.each([
    ['cn', 'cn'],
    ['global', 'global'],
  ] as const)('allows a personal session in its build realm (%s)', (buildRegion, sessionRealm) => {
    expect(canRestoreAuthSessionForMembership(buildRegion, sessionRealm, 'personal')).toBe(true);
  });

  it.each([
    ['cn', 'global'],
    ['global', 'cn'],
  ] as const)(
    'rejects a personal session outside its build realm (%s build, %s session)',
    (buildRegion, sessionRealm) => {
      expect(canRestoreAuthSessionForMembership(buildRegion, sessionRealm, 'personal')).toBe(false);
    },
  );

  it.each([
    ['cn', 'cn'],
    ['cn', 'global'],
    ['global', 'cn'],
    ['global', 'global'],
  ] as const)(
    'allows an organization session to follow its realm (%s build, %s session)',
    (buildRegion, sessionRealm) => {
      expect(canRestoreAuthSessionForMembership(buildRegion, sessionRealm, 'org')).toBe(true);
    },
  );
});
