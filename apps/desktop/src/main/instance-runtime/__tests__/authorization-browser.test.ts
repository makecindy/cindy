import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationBrowser,
  type AuthorizationBrowserConnection,
} from '../authorization-browser.js';

function harness() {
  const targets = new Map<
    string,
    { targetId: string; type: string; url: string; openerId?: string }
  >();
  targets.set('boot', { targetId: 'boot', type: 'page', url: 'about:blank' });
  let serial = 0,
    alive = true;
  const call = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      if (method === 'Target.getTargets') return { targetInfos: [...targets.values()] };
      if (method === 'Target.createTarget') {
        const targetId = `auth-${++serial}`;
        targets.set(targetId, { targetId, type: 'page', url: String(params.url) });
        return { targetId };
      }
      if (method === 'Target.closeTarget')
        return { success: targets.delete(String(params.targetId)) };
      if (method === 'Browser.close') {
        alive = false;
        return {};
      }
      throw new Error('Unexpected CDP call');
    },
  );
  const connection: AuthorizationBrowserConnection = {
    call,
    alive: () => alive,
    exited: async () => {},
  };
  const launch = vi.fn(async () => connection);
  return { browser: new AuthorizationBrowser(launch), targets, call, launch, connection };
}

describe('cloud authorization target ownership', () => {
  it.each(['throw', 'false'])('confirms an already destroyed bootstrap on immediate cleanup: %s', async (failure) => {
    const h = harness(), original = h.call.getMockImplementation()!;
    let bootCloses = 0;
    h.call.mockImplementation(async (method, params) => {
      if (method === 'Target.closeTarget' && params?.targetId === 'boot') {
        if (++bootCloses === 1) return { success: true }; // acknowledged, still enumerated
        h.targets.delete('boot'); // destroyed after the cleanup snapshot
        if (failure === 'throw') throw new Error('target disappeared');
        return { success: false };
      }
      return original(method, params);
    });
    const close = await h.browser.open('https://login.example/');
    await expect(close()).resolves.toBeUndefined();
    await close();
    expect(h.targets.size).toBe(0);
    expect(h.call.mock.calls.filter(([method]) => method === 'Browser.close')).toHaveLength(1);
  });

  it('accepts a self-closing SSO child without touching another authorization or user tab', async () => {
    const h = harness(), close = await h.browser.open('https://login.example/first');
    await h.browser.open('https://login.example/second');
    h.targets.set('sso', { targetId: 'sso', type: 'page', url: 'https://sso.example/', openerId: 'auth-1' });
    h.targets.set('user', { targetId: 'user', type: 'page', url: 'about:blank' });
    const original = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (method, params) => {
      if (method === 'Target.closeTarget' && params?.targetId === 'sso') {
        h.targets.delete('sso');
        throw new Error('target disappeared');
      }
      return original(method, params);
    });
    await close();
    expect([...h.targets.keys()]).toEqual(['auth-2', 'user']);
    expect(h.call.mock.calls.some(([method]) => method === 'Browser.close')).toBe(false);
  });

  it('keeps cleanup retryable when a rejected close still has a live target', async () => {
    const h = harness(), close = await h.browser.open('https://login.example/');
    const original = h.call.getMockImplementation()!;
    h.call.mockImplementationOnce(original).mockImplementationOnce(async () => ({ success: false }));
    await expect(close()).rejects.toThrow('AUTHORIZATION_BROWSER_CLOSE_FAILED');
    expect(h.targets.has('auth-1')).toBe(true);
    await close();
    expect(h.targets.size).toBe(0);
  });

  it('waits for process exit when Chromium exits during the disappearance check', async () => {
    const h = harness(), close = await h.browser.open('https://login.example/');
    let alive = true, confirming = false, release!: () => void;
    const exited = new Promise<void>((resolve) => { release = resolve; });
    h.connection.alive = () => alive;
    h.connection.exited = vi.fn(() => exited);
    const original = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (method, params) => {
      if (method === 'Target.closeTarget') {
        confirming = true;
        throw new Error('target disappeared');
      }
      if (confirming && method === 'Target.getTargets') {
        alive = false;
        throw new Error('browser exiting');
      }
      return original(method, params);
    });
    const completed = vi.fn();
    const cleanup = close().then(completed);
    await vi.waitFor(() => expect(h.connection.exited).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    release();
    await cleanup;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(['Target.getTargets', 'Target.closeTarget'])(
    'retries a failed %s cleanup and preserves other windows', async (method) => {
      const h = harness(), close = await h.browser.open('https://login.example/first');
      await h.browser.open('https://login.example/second');
      h.targets.set('user', { targetId: 'user', type: 'page', url: 'https://user.example/' });
      const original = h.call.getMockImplementation()!;
      let failed = false;
      h.call.mockImplementation(async (name, params) => {
        if (!failed && name === method) { failed = true; throw new Error('temporary CDP failure'); }
        return original(name, params);
      });
      await expect(close()).rejects.toThrow('temporary CDP failure');
      expect(h.targets.has('auth-1')).toBe(true);
      await close();
      await close();
      expect([...h.targets.keys()]).toEqual(['auth-2', 'user']);
      expect(h.call.mock.calls.some(([name]) => name === 'Browser.close')).toBe(false);
    },
  );
  it('retries after only some SSO windows have closed', async () => {
    const h = harness(), close = await h.browser.open('https://login.example/');
    h.targets.set('sso', { targetId: 'sso', type: 'page', url: 'https://sso.example/', openerId: 'auth-1' });
    const original = h.call.getMockImplementation()!;
    let failed = false;
    h.call.mockImplementation(async (method, params) => {
      if (!failed && method === 'Target.closeTarget' && params?.targetId === 'auth-1') {
        failed = true; throw new Error('temporary close failure');
      }
      return original(method, params);
    });
    await expect(close()).rejects.toThrow('temporary close failure');
    expect([...h.targets.keys()]).toEqual(['auth-1']);
    await close();
    expect(h.targets.size).toBe(0);
    expect(h.call.mock.calls.filter(([method]) => method === 'Browser.close')).toHaveLength(1);
  });
  it('closes its bootstrap, auth page and SSO descendants, then releases the empty browser', async () => {
    const h = harness(),
      close = await h.browser.open('https://login.example/authorize');
    expect(h.targets.has('boot')).toBe(false);
    h.targets.set('sso', {
      targetId: 'sso',
      type: 'page',
      url: 'https://sso.example/',
      openerId: 'auth-1',
    });
    h.targets.set('sso-child', {
      targetId: 'sso-child',
      type: 'page',
      url: 'https://sso.example/',
      openerId: 'sso',
    });
    await close();
    await close();
    expect(h.targets.size).toBe(0);
    expect(h.call.mock.calls.filter(([method]) => method === 'Browser.close')).toHaveLength(1);
  });
  it('keeps another authorization and user tabs, including user blank tabs', async () => {
    const h = harness(),
      first = await h.browser.open('https://login.example/first');
    const second = await h.browser.open('https://login.example/second');
    h.targets.set('user', { targetId: 'user', type: 'page', url: 'about:blank' });
    await first();
    expect([...h.targets.keys()]).toEqual(['auth-2', 'user']);
    await second();
    expect([...h.targets.keys()]).toEqual(['user']);
    expect(h.call.mock.calls.some(([method]) => method === 'Browser.close')).toBe(false);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });
  it('does not launch for local files, non-HTTPS URLs or URL credentials', async () => {
    const h = harness();
    for (const url of [
      'file:///tmp/example',
      'http://login.example/',
      'https://user:secret@login.example/',
    ]) {
      await expect(h.browser.open(url)).rejects.toThrow('AUTHORIZATION_BROWSER_URL_INVALID');
    }
    expect(h.launch).not.toHaveBeenCalled();
  });
  it('preserves an initial page the user navigated while startup was finishing', async () => {
    const h = harness(),
      original = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (method, params) => {
      if (method === 'Target.createTarget')
        h.targets.set('boot', { targetId: 'boot', type: 'page', url: 'https://user.example/' });
      return original(method, params);
    });
    const close = await h.browser.open('https://login.example/');
    await close();
    expect(h.targets.get('boot')?.url).toBe('https://user.example/');
  });
  it('reclaims an auth window when bootstrap inspection fails after creation', async () => {
    const h = harness(),
      original = h.call.getMockImplementation()!;
    let inspections = 0;
    h.call.mockImplementation(async (method, params) => {
      if (method === 'Target.getTargets' && ++inspections === 2)
        throw new Error('temporary failure');
      return original(method, params);
    });
    await expect(h.browser.open('https://login.example/')).rejects.toThrow('temporary failure');
    expect(h.targets.size).toBe(0);
    expect(h.call.mock.calls.some(([method]) => method === 'Browser.close')).toBe(true);
  });
});
