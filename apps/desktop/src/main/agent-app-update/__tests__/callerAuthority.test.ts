import { describe, expect, it, vi } from 'vitest';

import { isAppUpdateOwnerTurn, type AppUpdateCallerFacts } from '../callerAuthority.js';

function facts(overrides: Partial<AppUpdateCallerFacts> = {}): AppUpdateCallerFacts {
  return {
    turnRunning: true,
    turnOrigin: null,
    route: null,
    ownerAuthoredInput: () => true,
    ...overrides,
  };
}

describe('isAppUpdateOwnerTurn', () => {
  it('accepts an owner-typed Desktop or same-account phone turn', () => {
    expect(isAppUpdateOwnerTurn(facts())).toBe(true);
  });

  it('refuses when no turn is running', () => {
    expect(isAppUpdateOwnerTurn(facts({ turnRunning: false }))).toBe(false);
  });

  it.each([
    { kind: 'scheduler' as const, scheduleId: 's', scheduleName: 'n' },
    { kind: 'goal' as const, goalSessionId: 'task' },
  ])('refuses automated turns ($kind)', (origin) => {
    const ownerAuthoredInput = vi.fn(() => true);
    expect(isAppUpdateOwnerTurn(facts({ turnOrigin: origin, ownerAuthoredInput }))).toBe(false);
    expect(ownerAuthoredInput).not.toHaveBeenCalled();
  });

  it('refuses inputs the coordinator cannot attribute to the owner (other task, guest, resume)', () => {
    expect(isAppUpdateOwnerTurn(facts({ ownerAuthoredInput: () => false }))).toBe(false);
  });

  it('uses the channel owner check for personal IM turns', () => {
    const imRoute = (requesterAuthority?: 'owner' | 'guest' | 'unknown') => ({
      origin: { kind: 'im' as const, channel: 'telegram' as const },
      requesterAuthority,
    });
    const ownerAuthoredInput = vi.fn(() => true);
    expect(isAppUpdateOwnerTurn(facts({ route: imRoute('owner'), ownerAuthoredInput }))).toBe(true);
    expect(isAppUpdateOwnerTurn(facts({ route: imRoute('unknown'), ownerAuthoredInput }))).toBe(
      false,
    );
    expect(isAppUpdateOwnerTurn(facts({ route: imRoute('guest'), ownerAuthoredInput }))).toBe(
      false,
    );
    expect(isAppUpdateOwnerTurn(facts({ route: imRoute(undefined), ownerAuthoredInput }))).toBe(
      false,
    );
    // A channel route never falls back to Desktop input evidence.
    expect(ownerAuthoredInput).not.toHaveBeenCalled();
  });

  it('refuses official-bot (hook) turns, which carry an automation origin', () => {
    expect(
      isAppUpdateOwnerTurn(
        facts({
          turnOrigin: {
            kind: 'scheduler',
            scheduleId: 'hook:conn',
            scheduleName: 'Hook · Telegram',
          },
          route: { origin: { kind: 'hook', source: 'telegram' }, requesterAuthority: 'owner' },
        }),
      ),
    ).toBe(false);
    expect(
      isAppUpdateOwnerTurn(facts({ route: { origin: { kind: 'hook', source: 'telegram' } } })),
    ).toBe(false);
  });

  it('refuses scheduler routes and IM turns without a route', () => {
    expect(
      isAppUpdateOwnerTurn(
        facts({ route: { origin: { kind: 'scheduler' }, requesterAuthority: 'owner' } }),
      ),
    ).toBe(false);
    expect(isAppUpdateOwnerTurn(facts({ turnOrigin: { kind: 'user', surface: 'im' } }))).toBe(
      false,
    );
  });
});
