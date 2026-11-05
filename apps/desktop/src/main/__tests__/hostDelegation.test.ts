import fs from 'node:fs';
import http from 'node:http';
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

  it('joins a running host discovered from the profile endpoint file', () => {
    const userDataDir = profileWithToken('unit-test-token');
    fs.writeFileSync(
      path.join(userDataDir, 'host-endpoint.json'),
      JSON.stringify({ pid: process.pid, baseUrl: 'http://127.0.0.1:3456' }),
    );
    expect(resolveHostDelegation({ env: {}, userDataDir })).toEqual({
      baseUrl: 'http://127.0.0.1:3456',
      token: 'unit-test-token',
    });
  });

  it('ignores an endpoint file whose process is gone', () => {
    const userDataDir = profileWithToken('unit-test-token');
    fs.writeFileSync(
      path.join(userDataDir, 'host-endpoint.json'),
      JSON.stringify({ pid: 999_999_999, baseUrl: 'http://127.0.0.1:3456' }),
    );
    expect(resolveHostDelegation({ env: {}, userDataDir })).toBeNull();
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

    await handlers.get('local-db:sessions:create')!({} as IpcMainInvokeEvent, { model: 'm' });
    expect(requests.at(-1)).toEqual({ path: '/api/sessions/create', body: { model: 'm' } });
    await handlers.get('maker:input:remove')!({} as IpcMainInvokeEvent, 'task-1', 'c1');
    expect(requests.at(-1)).toEqual({
      path: '/api/input/remove',
      body: { sessionId: 'task-1', clientId: 'c1' },
    });

    await handlers.get('maker:list-agent-commands')!({} as IpcMainInvokeEvent, 'codex', {
      sessionId: 'task-1',
    });
    expect(requests.at(-1)).toEqual({
      path: '/api/agent-commands',
      body: { agentKind: 'codex', sessionId: 'task-1' },
    });

    // The legacy send path maps onto the queue and reports acceptance.
    const accepted = await handlers.get('maker:send')!({} as IpcMainInvokeEvent, 'task-1', 'hello', {
      model: 'm1',
      workingDir: '/tmp',
    });
    expect(accepted).toEqual({ accepted: true });
    const send = requests.at(-1) as { path: string; body: { item: { text: string; model: string } } };
    expect(send.path).toBe('/api/input/enqueue');
    expect(send.body.item.text).toBe('hello');
    expect(send.body.item.model).toBe('m1');
  });
});

describe('host proxy round trip', () => {
  it('reaches a real loopback server with the bearer and maps the reply', async () => {
    const seen: Array<{ url?: string; auth?: string; body?: string }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        seen.push({ url: request.url, auth: request.headers.authorization, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{ id: 'task-1', title: 'from host' }]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
      const ipcMain = {
        removeHandler: () => {},
        handle: (
          channel: string,
          listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
        ) => {
          handlers.set(channel, listener);
        },
      };
      const client = createHostClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'unit-token' });
      registerHostDelegatedIpc({ client, ipcMain });

      const sessions = await handlers.get('local-db:sessions:list')!({} as IpcMainInvokeEvent);
      expect(sessions).toEqual([{ id: 'task-1', title: 'from host' }]);
      expect(seen.at(-1)).toMatchObject({
        url: '/api/sessions/list',
        auth: 'Bearer unit-token',
        body: 'null',
      });

      const projection = await handlers.get('maker:input:get-projection')!(
        {} as IpcMainInvokeEvent,
        'task-1',
      );
      expect(projection).toEqual([{ id: 'task-1', title: 'from host' }]);
      expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ sessionId: 'task-1' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
