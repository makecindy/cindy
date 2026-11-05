import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

import {
  PROXIED_CHANNELS,
  createHostClient,
  registerHostDelegatedIpc,
  resolveHostDelegation,
} from '../host-delegation';

const roots: string[] = [];

function profileWithToken(token: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-delegation-'));
  roots.push(root);
  if (token !== null) fs.writeFileSync(path.join(root, 'host-api-token'), `${token}\n`, 'utf-8');
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveHostDelegation', () => {
  it('stays off without the env var', () => {
    expect(resolveHostDelegation({ env: {}, userDataDir: profileWithToken('t') })).toBeNull();
  });

  it('reads the loopback target and the profile token', () => {
    const userDataDir = profileWithToken('unit-test-token');
    expect(
      resolveHostDelegation({ env: { CINDY_HOST_API: 'http://127.0.0.1:3456/' }, userDataDir }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:3456', token: 'unit-test-token' });
  });

  it('refuses a non-loopback host instead of sending the token off-machine', () => {
    expect(() =>
      resolveHostDelegation({
        env: { CINDY_HOST_API: 'https://example.com' },
        userDataDir: profileWithToken('unit-test-token'),
      }),
    ).toThrow(/loopback/);
  });

  it('refuses to boot without a profile token', () => {
    expect(() =>
      resolveHostDelegation({
        env: { CINDY_HOST_API: 'http://127.0.0.1:3456' },
        userDataDir: profileWithToken(null),
      }),
    ).toThrow(/host-api-token/);
  });
});

describe('host proxies', () => {
  it('replaces the covered channels and forwards the renderer args', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const ipcMain = {
      removeHandler: (channel: string) => {
        removed.push(channel);
      },
      handle: (
        channel: string,
        listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => {
        handlers.set(channel, listener);
      },
    };
    const requests: Array<{ path: string; body: unknown }> = [];
    const client = {
      request: async (requestPath: string, body?: unknown) => {
        requests.push({ path: requestPath, body });
        return [];
      },
    };

    const installed = registerHostDelegatedIpc({ client, ipcMain });

    expect(installed).toEqual(PROXIED_CHANNELS.map((entry) => entry.channel));
    expect(removed).toEqual(installed);
    await handlers.get('local-db:messages:list')!({} as IpcMainInvokeEvent, 'task-1', { limit: 50 });
    expect(requests.at(-1)).toEqual({
      path: '/api/messages/list',
      body: { sessionId: 'task-1', limit: 50 },
    });
    await handlers.get('maker:input:enqueue')!({} as IpcMainInvokeEvent, 'task-1', {
      clientId: 'c1',
      text: 'hi',
    });
    expect(requests.at(-1)).toEqual({
      path: '/api/input/enqueue',
      body: { sessionId: 'task-1', item: { clientId: 'c1', text: 'hi' } },
    });
  });
});

describe('createHostClient', () => {
  it('sends the profile bearer and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const token = 'unit-test-token';
    const client = createHostClient({ baseUrl: 'http://127.0.0.1:3456', token });
    await expect(client.request('/api/providers', null)).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3456/api/providers');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
  });

  it('surfaces the host error text instead of a silent empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const client = createHostClient({ baseUrl: 'http://127.0.0.1:3456', token: 't' });
    await expect(client.request('/api/providers')).rejects.toThrow('boom');
  });
});
