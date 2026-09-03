import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ boundaryPending: false, user: null as unknown }));

vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));

vi.mock('../../authManager', () => ({
  getAuthState: () => ({ user: state.user }),
}));

vi.mock('../../serverApiClient', () => ({
  ServerApiError: class ServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

describe('SkillHub identity write policy', () => {
  beforeEach(() => {
    state.boundaryPending = false;
    state.user = { membershipKind: 'personal' };
    vi.resetModules();
  });

  it('fails closed while the application session owner boundary is pending', async () => {
    state.boundaryPending = true;
    const { assertSkillhubVisibilityAllowed, assertSkillhubWriteAllowed } = await import('../identityPolicy');

    expect(() => assertSkillhubWriteAllowed()).toThrow(expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      statusCode: 409,
    }));
    expect(() => assertSkillhubVisibilityAllowed('public')).toThrow(expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      statusCode: 409,
    }));
  });

  it('allows a stable signed-in personal session', async () => {
    const { assertSkillhubWriteAllowed } = await import('../identityPolicy');

    expect(() => assertSkillhubWriteAllowed()).not.toThrow();
  });
});
