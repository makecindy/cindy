import { describe, expect, it, vi } from 'vitest';

import {
  startAccountIntegrationsAfterOwnerDbReady,
  type AccountIntegrationStartupDeps,
} from '../accountIntegrationStartup';

function createDeps(
  overrides: Partial<AccountIntegrationStartupDeps> = {},
): AccountIntegrationStartupDeps {
  return {
    isOwnerCurrent: vi.fn(() => true),
    startHookControlAccount: vi.fn(),
    startImConnection: vi.fn(),
    log: { warn: vi.fn() },
    ...overrides,
  };
}

describe('startAccountIntegrationsAfterOwnerDbReady', () => {
  it('starts Feishu IM from the authoritative owner DB-ready boundary', () => {
    const deps = createDeps();

    expect(startAccountIntegrationsAfterOwnerDbReady('owner-a', deps)).toBe(true);

    expect(deps.startHookControlAccount).toHaveBeenCalledOnce();
    expect(deps.startImConnection).toHaveBeenCalledOnce();
    expect(deps.log.warn).not.toHaveBeenCalled();
  });

  it('still starts Feishu IM when Hook activation throws', () => {
    const deps = createDeps({
      startHookControlAccount: vi.fn(() => {
        throw new Error('invalid hook endpoint');
      }),
    });

    startAccountIntegrationsAfterOwnerDbReady('owner-a', deps);

    expect(deps.startImConnection).toHaveBeenCalledOnce();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'hook-control activation after owner DB ready failed (non-fatal)',
      { error: 'invalid hook endpoint' },
    );
  });

  it('contains Feishu IM activation failures so DB readiness can complete', () => {
    const deps = createDeps({
      startImConnection: vi.fn(() => {
        throw new Error('invalid bot credentials');
      }),
    });

    expect(() => startAccountIntegrationsAfterOwnerDbReady('owner-a', deps)).not.toThrow();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'feishu-im activation after owner DB ready failed (non-fatal)',
      { error: 'invalid bot credentials' },
    );
  });

  it('does not restart integrations for a stale owner and permits the next owner', () => {
    let activeOwner = 'owner-a';
    const deps = createDeps({
      isOwnerCurrent: vi.fn((ownerId) => ownerId === activeOwner),
    });

    // Model logout/account replacement completing while the old onReady
    // callback is awaiting another account startup hook.
    activeOwner = 'owner-b';

    expect(startAccountIntegrationsAfterOwnerDbReady('owner-a', deps)).toBe(false);
    expect(deps.startHookControlAccount).not.toHaveBeenCalled();
    expect(deps.startImConnection).not.toHaveBeenCalled();

    expect(startAccountIntegrationsAfterOwnerDbReady('owner-b', deps)).toBe(true);
    expect(deps.startHookControlAccount).toHaveBeenCalledOnce();
    expect(deps.startImConnection).toHaveBeenCalledOnce();
  });
});
