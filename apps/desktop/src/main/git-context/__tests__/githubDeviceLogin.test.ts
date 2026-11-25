import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectGithubDevice, type GithubLoginDeps } from '../githubDeviceLogin.js';
import type { DeviceAuthorizationInput } from '../../plugin-oauth/deviceCard.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((y, n) => {
    resolve = y;
    reject = n;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function fixture() {
  const opened = deferred<void>();
  const ready = deferred<void>();
  const challenge = deferred<{ url: string; userCode: string }>();
  const controller = new AbortController();
  const cardInput: { value?: DeviceAuthorizationInput } = {};
  const released = vi.fn();
  const child = {
    challenge: challenge.promise,
    ready: ready.promise,
    opened: vi.fn(),
    commit: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const card = { opened: opened.promise, finish: vi.fn(), dispose: vi.fn() };
  const deps: GithubLoginDeps = {
    available: vi.fn(() => true),
    probe: vi.fn(async () => false),
    start: vi.fn((signal) => {
      signal.addEventListener('abort', () => {
        const e = new Error('cancelled');
        challenge.reject(e);
        opened.reject(e);
        ready.reject(e);
      });
      return child;
    }),
    openCard: vi.fn((input) => {
      cardInput.value = input;
      return card;
    }),
    acquireCommitLease: vi.fn(() => released),
    invalidateTokenCache: vi.fn(),
  };
  const current = vi.fn();
  const input = {
    ghost: { id: 'cindy-github', name: 'GitHub' },
    sessionId: 'task-a',
    signal: controller.signal,
    assertCurrent: current,
  };
  return {
    input,
    deps,
    child,
    card,
    opened,
    ready,
    challenge,
    controller,
    cardInput,
    current,
    released,
  };
}
const tick = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const offer = { url: 'https://github.com/login/device', userCode: 'ABCD-EFGH' };
afterEach(() => vi.useRealTimers());

describe('GitHub Host device login', () => {
  it('reuses an existing connection unless reconnect was explicit', async () => {
    const h = fixture();
    h.deps.probe = async () => true;
    expect(await connectGithubDevice(h.input, h.deps)).toMatchObject({ ok: true, status: 'ready' });
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.deps.openCard).not.toHaveBeenCalled();
  });
  it('commits only after card open and verified private login, then releases the owner lease', async () => {
    const h = fixture();
    h.deps.probe = async () => true;
    const result = connectGithubDevice({ ...h.input, reauthorize: true }, h.deps);
    h.challenge.resolve(offer);
    await tick();
    expect(h.cardInput.value).toMatchObject(offer);
    expect(h.child.commit).not.toHaveBeenCalled();
    h.opened.resolve();
    await tick();
    expect(h.child.opened).toHaveBeenCalledOnce();
    expect(h.card.finish).not.toHaveBeenCalled();
    h.ready.resolve();
    const value = await result;
    expect(value).toMatchObject({ ok: true, status: 'ready' });
    expect(JSON.stringify(value)).not.toContain(offer.userCode);
    expect(JSON.stringify(value)).not.toContain(offer.url);
    expect(h.child.commit).toHaveBeenCalledOnce();
    expect(h.card.finish).toHaveBeenCalledWith(true);
    expect(h.deps.invalidateTokenCache).toHaveBeenCalledOnce();
    expect(h.child.dispose).toHaveBeenCalledOnce();
    expect(h.released).toHaveBeenCalledOnce();
  });
  it.each(['challenge', 'card', 'poll'] as const)(
    'cancels %s without touching the current keyring',
    async (stage) => {
      const h = fixture();
      const result = connectGithubDevice({ ...h.input, reauthorize: true }, h.deps);
      await tick();
      if (stage !== 'challenge') {
        h.challenge.resolve(offer);
        await tick();
      }
      if (stage === 'poll') {
        h.opened.resolve();
        await tick();
      }
      h.controller.abort();
      expect(await result).toMatchObject({ ok: false });
      expect(h.child.commit).not.toHaveBeenCalled();
      expect(h.child.dispose).toHaveBeenCalledOnce();
      expect(h.card.finish).not.toHaveBeenCalledWith(true);
    },
  );
  it.each(['owner', 'timeout'] as const)(
    'kills an idle login on %s invalidation',
    async (cause) => {
      vi.useFakeTimers();
      const h = fixture();
      const result = connectGithubDevice(h.input, h.deps);
      await tick();
      if (cause === 'owner')
        h.current.mockImplementation(() => {
          throw new Error('stale');
        });
      await vi.advanceTimersByTimeAsync(cause === 'owner' ? 250 : 300_000);
      expect(await result).toMatchObject({ ok: false });
      expect(h.child.commit).not.toHaveBeenCalled();
      expect(h.child.dispose).toHaveBeenCalledOnce();
    },
  );
  it('revalidates policy immediately before credential commit', async () => {
    const h = fixture();
    const result = connectGithubDevice(h.input, h.deps);
    h.challenge.resolve(offer);
    await tick();
    h.opened.resolve();
    await tick();
    h.current.mockImplementation(() => {
      throw new Error('plugin no longer allowed');
    });
    h.ready.resolve();
    expect(await result).toMatchObject({ ok: false });
    expect(h.deps.acquireCommitLease).not.toHaveBeenCalled();
    expect(h.child.commit).not.toHaveBeenCalled();
  });
  it('does not start a second writer while a card is pending', async () => {
    const h = fixture();
    const result = connectGithubDevice(h.input, h.deps);
    await tick();
    expect(await connectGithubDevice(h.input, h.deps)).toMatchObject({
      errorCode: 'AUTH_IN_PROGRESS',
    });
    h.controller.abort();
    await result;
    expect(h.deps.start).toHaveBeenCalledOnce();
  });
  it('fails without executing any helper when the packaged capability is missing', async () => {
    const h = fixture();
    h.deps.available = () => false;
    expect(await connectGithubDevice(h.input, h.deps)).toMatchObject({
      errorCode: 'GITHUB_LOGIN_UNAVAILABLE',
    });
    expect(h.deps.start).not.toHaveBeenCalled();
  });
});
