import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  persistedKey: null as string | null,
  clearListeners: [] as Array<() => void>,
  failWrites: 0,
  writes: 0,
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readPiProxyDerivationKey: vi.fn(() => h.persistedKey),
  writePiProxyDerivationKey: vi.fn((value: string) => {
    if (h.failWrites > 0) {
      h.failWrites -= 1;
      return false;
    }
    h.persistedKey = value;
    h.writes += 1;
    return true;
  }),
  addProviderSecretsClearedListener: vi.fn((listener: () => void) => {
    h.clearListeners.push(listener);
    return () => undefined;
  }),
}));

import {
  derivePiProxySessionToken,
  resetPiProxyDerivationKeyCacheForTests,
} from '../pi-proxy-session-token.js';

describe('Pi remote proxy session token derivation', () => {
  beforeEach(() => {
    h.persistedKey = null;
    h.clearListeners.length = 0;
    h.failWrites = 0;
    h.writes = 0;
    resetPiProxyDerivationKeyCacheForTests();
  });

  it('keeps the same session token across a Desktop restart and isolates other sessions', () => {
    const first = derivePiProxySessionToken('session-a');
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(h.writes).toBe(1);

    resetPiProxyDerivationKeyCacheForTests();
    const afterRestart = derivePiProxySessionToken('session-a');
    const otherSession = derivePiProxySessionToken('session-b');

    expect(afterRestart).toBe(first);
    expect(otherSession).not.toBe(first);
    expect(h.writes).toBe(1);
  });

  it('rotates after the owner secret boundary is cleared', () => {
    const first = derivePiProxySessionToken('session-a');
    h.persistedKey = null;
    for (const listener of h.clearListeners) listener();

    expect(derivePiProxySessionToken('session-a')).not.toBe(first);
    expect(h.writes).toBe(2);
  });

  it('retries secure persistence after a transient write failure', () => {
    h.failWrites = 1;

    expect(() => derivePiProxySessionToken('session-a')).toThrow(
      'PI_PROXY_DERIVATION_KEY_UNAVAILABLE',
    );
    expect(derivePiProxySessionToken('session-a')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(h.writes).toBe(1);
  });
});
