import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

import {
  PROXIED_CHANNELS,
  claimProxiedChannels,
  createHostClient,
  installUnsupportedMakerFallbacks,
  registerHostDelegatedIpc,
  resolveHostDelegation,
  startHostEventBridge,
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
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveHostDelegation', () => {
  it('stays off without the env var', () => {
    expect(resolveHostDelegation({ env: {}, userDataDir: profileWithToken('t') })).toBeNull();
  });

  it('does not change desktop mode just because a host endpoint exists', () => {
    const userDataDir = profileWithToken('unit-test-token');
    fs.writeFileSync(path.join(userDataDir, 'host-endpoint.json'), JSON.stringify({pid: process.pid, baseUrl: 'http://127.0.0.1:3456'}));
    expect(resolveHostDelegation({env: {}, userDataDir})).toBeNull();
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
      body: { sessionId: 'task-1', limit: 50, before: null },
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
  // Unit regression through the registered IPC boundary: the old contract
  // returned a bare boolean for approval and an object for steer, opposite to
  // what preload consumers expect. Also keep a successful refresh signed out.
  // Existing proxy tests only covered request bodies; minimal false verdicts
  // detect accidental success without an Electron process or real credentials.
  it('returns preload-compatible approval, steer and auth verdicts', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    registerHostDelegatedIpc({
      ipcMain: {
        removeHandler() {},
        handle: (channel, handler) => { handlers.set(channel, handler); },
      },
      client: { request: async () => ({ accepted: false, ok: true, isAuthenticated: false }) },
    });
    const event = {} as IpcMainInvokeEvent;
    await expect(handlers.get('maker:resolve-interaction')!(event, 'request-1', { behavior: 'allow' }))
      .resolves.toEqual({ accepted: false });
    await expect(handlers.get('maker:input:steer')!(event, 'task-1', { text: 'next' })).resolves.toBe(true);
    await expect(handlers.get('auth:refresh')!(event)).resolves.toBe(false);
  });

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

describe('claimProxiedChannels and unsupported fallbacks', () => {
  it('allows registerHostDelegatedIpc even after claimProxiedChannels is called', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      removeHandler: () => {},
      handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };
    const client = { request: async () => ({ ok: true }) };

    claimProxiedChannels(ipcMain, () => {});
    registerHostDelegatedIpc({ client, ipcMain });

    expect(handlers.has('maker:get-capabilities')).toBe(true);
    const caps = await handlers.get('maker:get-capabilities')!({} as IpcMainInvokeEvent, 'codex');
    expect(caps).toEqual({ ok: true });
  });

  it('drops subsequent registrations of proxied channels without throwing', () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const dropped: string[] = [];
    const ipcMain = {
      removeHandler: () => {},
      handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };
    const client = { request: async () => [] };
    registerHostDelegatedIpc({ client, ipcMain });
    claimProxiedChannels(ipcMain, (ch) => dropped.push(ch));

    ipcMain.handle('local-db:sessions:list', () => ['competing']);
    expect(dropped).toContain('local-db:sessions:list');
  });

  it('fails with UNSUPPORTED_CAPABILITY for unproxied maker:* channels via _invokeHandlers map', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      _invokeHandlers: handlers,
      removeHandler: () => {},
      handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };

    installUnsupportedMakerFallbacks({ ipcMain });

    const fallback = handlers.get('maker:remote-ssh:connect');
    expect(fallback).toBeDefined();
    await expect(fallback!({} as IpcMainInvokeEvent)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('fails with UNSUPPORTED_CAPABILITY for explicit unproxied channels list', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      removeHandler: () => {},
      handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    };

    installUnsupportedMakerFallbacks({
      ipcMain,
      channels: ['maker:project-automation:pending-imports', 'maker:send'],
    });

    expect(handlers.has('maker:send')).toBe(false);
    expect(handlers.has('maker:project-automation:pending-imports')).toBe(true);
    await expect(
      handlers.get('maker:project-automation:pending-imports')!({} as IpcMainInvokeEvent),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('covers appearance, layout, project aliases, and auth in PROXIED_CHANNELS', () => {
    const channelNames = PROXIED_CHANNELS.map((c) => c.channel);
    expect(channelNames).toContain('appearance-settings:set-patch');
    expect(channelNames).toContain('appearance-settings:reset');
    expect(channelNames).toContain('layout:set');
    expect(channelNames).toContain('layout:reset');
    expect(channelNames).toContain('local-db:project-aliases:set');
    expect(channelNames).toContain('local-db:project-aliases:delete');
    expect(channelNames).toContain('auth:refresh');
    expect(channelNames).toContain('auth:get-state');
  });

  it('relays SSE events through startHostEventBridge and dispatches typed callbacks', async () => {
    const broadcasts: unknown[] = [];
    const projections: unknown[] = [];
    const interactions: unknown[] = [];
    const settingsChanged: Array<{ domain: string; value: unknown }> = [];
    const sessionEvents: unknown[] = [];
    const messageEvents: unknown[] = [];
    const historyChanges: unknown[] = [];
    let projectAliasesNotified = false;
    const errors: unknown[] = [];

    const server = http.createServer((req, res) => {
      try {
        if (req.url?.startsWith('/events')) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.flushHeaders();
          res.write('data: {"seq":1,"type":"settings_changed","domain":"appearance","value":{"theme":"dark"}}\n\n');
          res.write('data: {"seq":2,"type":"session_changed","action":"create","sessionId":"s1"}\n\n');
          res.write('data: {"seq":3,"type":"message_created","sessionId":"s1","messageId":"m1"}\n\n');
          res.write('data: {"seq":4,"type":"project_aliases_changed"}\n\n');
          res.write('data: {"seq":5,"type":"input_projection","projection":{"sessionId":"s1","turnInProgress":true}}\n\n');
          res.write('data: {"seq":6,"type":"interaction_request","sessionId":"s1","request":{"requestId":"r1"}}\n\n');
          res.write('data: {"seq":7,"type":"text","sessionId":"s1"}\n\n');
          res.write('data: {"seq":8,"type":"message_deleted","sessionId":"s1","clientId":"draft"}\n\n');
          res.write('data: {"seq":9,"type":"error_persisted","sessionId":"s1","persistId":"err"}\n\n');
          res.write('data: {"seq":10,"type":"subagent_runs_changed","sessionId":"s1"}\n\n');
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        console.error('SERVER HANDLER ERROR:', e);
        res.writeHead(500);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const stop = startHostEventBridge({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'test-token',
      broadcast: (payload) => broadcasts.push(payload),
      onInputProjection: (payload) => projections.push(payload),
      onInteractionRequest: (payload) => interactions.push(payload),
      onSettingsChanged: (domain, value) => settingsChanged.push({ domain, value }),
      onSessionChanged: (event) => sessionEvents.push(event),
      onMessageCreated: (event) => messageEvents.push(event),
      onMessageDeleted: (event) => historyChanges.push(event),
      onErrorPersisted: (event) => historyChanges.push(event),
      onSubagentRunsChanged: (event) => historyChanges.push(event),
      onProjectAliasesChanged: () => {
        projectAliasesNotified = true;
      },
      onError: (err) => {
        console.error('SSE bridge error:', err);
        errors.push(err);
      },
    });

    // Wait for the stream events to process
    for (let i = 0; i < 20; i++) {
      if (historyChanges.length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(errors).toHaveLength(0);
    expect(broadcasts).toEqual([{ seq: 7, type: 'text', sessionId: 's1' }]);
    expect(projections).toEqual([{ sessionId: 's1', turnInProgress: true }]);
    expect(interactions).toEqual([{ sessionId: 's1', request: { requestId: 'r1' } }]);
    expect(settingsChanged).toEqual([{ domain: 'appearance', value: { theme: 'dark' } }]);
    expect(sessionEvents).toEqual([{ seq: 2, type: 'session_changed', action: 'create', sessionId: 's1' }]);
    expect(messageEvents).toEqual([{ seq: 3, type: 'message_created', sessionId: 's1', messageId: 'm1' }]);
    expect(historyChanges).toEqual([
      { seq: 8, type: 'message_deleted', sessionId: 's1', clientId: 'draft' },
      { seq: 9, type: 'error_persisted', sessionId: 's1', persistId: 'err' },
      { seq: 10, type: 'subagent_runs_changed', sessionId: 's1' },
    ]);
    expect(projectAliasesNotified).toBe(true);
  });
});
