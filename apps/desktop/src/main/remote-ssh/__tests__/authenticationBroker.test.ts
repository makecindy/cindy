import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshAuthenticationBroker, type SshAuthenticationTarget } from '../authentication-broker.js';
import type { KeyboardInteractiveChallenge } from '@cindy/maker-remote-ssh';

// Test value (unit): SshAuthenticationBroker.request/submit must deliver a fake
// answer only to its current window/attempt and clear rejected or expired input.
// OTP support adds this privileged exchange; transport tests cannot cover sender
// ownership. Minimal failures are a wrong-window submission or an aborted request.

const challenge: KeyboardInteractiveChallenge = {
  host: { id: 'test', hostname: 'example.test', user: 'test', port: 22 },
  name: 'MFA', instructions: 'Enter code', prompts: [{ prompt: 'Code', echo: false }],
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const broker = new SshAuthenticationBroker();
  const controller = new AbortController();
  const target: SshAuthenticationTarget = { id: 1, current: () => true, send: vi.fn(), dismiss: vi.fn() };
  const result = broker.request(target, challenge, controller.signal);
  const request = broker.list(1)[0];
  return { broker, controller, target, result, request };
}

describe('local SSH authentication broker', () => {
  it('delivers answers once to the requesting window and wipes every submitted array', async () => {
    const { broker, result, request } = setup();
    const wrongWindow = ['FAKE-OTP'];
    expect(broker.submit(2, request.requestId, wrongWindow)).toBe(false);
    expect(wrongWindow).toEqual(['']);
    const invalid = ['FAKE-OTP', 'extra'];
    expect(broker.submit(1, request.requestId, invalid)).toBe(false);
    expect(invalid).toEqual(['', '']);
    expect(broker.list(1)).toEqual([request]);
    const answer = ['FAKE-OTP'];
    expect(broker.submit(1, request.requestId, answer)).toBe(true);
    expect(answer).toEqual(['']);
    await expect(result).resolves.toEqual(['FAKE-OTP']);
    expect(broker.list(1)).toEqual([]);
    expect(broker.submit(1, request.requestId, ['replay'])).toBe(false);
  });

  it.each(['abort', 'timeout', 'owner', 'window', 'all'] as const)('cancels pending input on %s and rejects late answers', async kind => {
    const { broker, controller, target, result, request } = setup();
    if (kind === 'abort') controller.abort();
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
    if (kind === 'owner') target.current = () => false;
    if (kind === 'window') broker.cancelTarget(1);
    if (kind === 'all') broker.cancelAll();
    const late = ['FAKE-LATE'];
    expect(broker.submit(1, request.requestId, late)).toBe(false);
    expect(late).toEqual(['']);
    await expect(result).resolves.toBeNull();
    expect(target.dismiss).toHaveBeenCalledWith(request.requestId);
  });

  it('fails closed without a current renderer or when delivery fails', async () => {
    const broker = new SshAuthenticationBroker();
    const target = { id: 1, current: () => false, send: vi.fn(), dismiss: vi.fn() };
    await expect(broker.request(target, challenge, new AbortController().signal)).resolves.toBeNull();
    expect(target.send).not.toHaveBeenCalled();
    target.current = () => true;
    target.send.mockImplementation(() => { throw new Error('renderer gone'); });
    await expect(broker.request(target, challenge, new AbortController().signal)).resolves.toBeNull();
    expect(broker.list(1)).toEqual([]);
  });
});
