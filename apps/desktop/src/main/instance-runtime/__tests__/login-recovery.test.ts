// Unit: a cloud instance whose device the owner removed must come back after the owner logs in
// again; Device Link answers 4410 until the device has rejoined.
import { describe, expect, it, vi } from 'vitest';
import { ServerApiError } from '../../serverApiClient.js';
import type { AuthRecoveryRequest } from '../auth-recovery.js';
import { instanceLoginRecoveryHandlers, type InstanceLoginRecoveryDependencies } from '../login-recovery.js';

const input: AuthRecoveryRequest = { version: 1, requestId: 'synthetic-request-001', deviceId: 'device-test',
  membershipId: 'member-test', refreshToken: 'synthetic-private-grant', expiresAtMs: Date.now() + 60_000 };

function fixture(state: { applied: boolean; removed: boolean }, overrides: Partial<InstanceLoginRecoveryDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: InstanceLoginRecoveryDependencies = {
    loginRecovered: () => state.applied,
    recoverLogin: vi.fn(async (_input, lost) => { calls.push(`login lost=${lost}`); state.applied = true; }),
    registrationLost: () => state.removed,
    rejoin: vi.fn(async () => { calls.push('rejoin'); state.removed = false; }),
    reconnect: vi.fn(() => { calls.push('reconnect'); }),
    warn: vi.fn(),
    ...overrides,
  };
  return { handlers: instanceLoginRecoveryHandlers(dependencies), dependencies, calls };
}

describe('instance login recovery after the device was removed', () => {
  it('applies the login, then asks Device Link to take the removed device back', async () => {
    const state = { applied: false, removed: true };
    const { handlers, calls } = fixture(state);
    expect(handlers.recovered(input)).toBe(false);
    await handlers.recover(input);
    expect(calls).toEqual(['login lost=true', 'rejoin']);
    expect(handlers.recovered(input)).toBe(true);
  });

  it('is not applied while the device is still removed, and a later delivery only retries the rejoin', async () => {
    const state = { applied: true, removed: true };
    const { handlers, dependencies, calls } = fixture(state, { rejoin: vi.fn(async () => { calls.push('rejoin'); }) });
    expect(handlers.recovered(input)).toBe(false);
    await handlers.recover(input);
    expect(dependencies.recoverLogin).not.toHaveBeenCalled();
    expect(calls).toEqual(['rejoin']);
    expect(handlers.recovered(input)).toBe(false);
  });

  it('falls back to reconnecting with the explicit login when Device Link has no /rejoin', async () => {
    const state = { applied: false, removed: true };
    const { handlers, dependencies, calls } = fixture(state, {
      rejoin: vi.fn(async () => { throw new Error('DEVICE_REJOIN_UNSUPPORTED'); }) });
    await handlers.recover(input);
    expect(calls).toEqual(['login lost=true', 'reconnect']);
    expect(dependencies.warn).toHaveBeenCalledWith('DEVICE_REJOIN_UNSUPPORTED');
  });

  it('reports only a status code, never a server message, when the rejoin request fails', async () => {
    const state = { applied: true, removed: true };
    const { handlers, dependencies } = fixture(state, {
      rejoin: vi.fn(async () => { throw new ServerApiError('RATE_LIMITED', 429, 'synthetic detail'); }) });
    await handlers.recover(input);
    expect(dependencies.warn).toHaveBeenCalledWith('HTTP_429');
    expect(dependencies.reconnect).toHaveBeenCalledTimes(1);
  });

  it('leaves a registered device alone', async () => {
    const state = { applied: false, removed: false };
    const { handlers, dependencies, calls } = fixture(state);
    await handlers.recover(input);
    expect(calls).toEqual(['login lost=false']);
    expect(dependencies.rejoin).not.toHaveBeenCalled();
    expect(handlers.recovered(input)).toBe(true);
  });
});
