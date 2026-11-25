import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagementPrompt } from '../../../shared/settingsManagement';
import { createCloudAuthorizationCallback } from '../authorizationCallback';
import { ephemeralCallbackPorts } from '../../plugin-oauth/__tests__/ephemeralCallbackPorts';
import { fixture } from './fixture';

let sockets: ReturnType<typeof ephemeralCallbackPorts>;
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  sockets = ephemeralCallbackPorts();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(
    [...sockets.servers.values()].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.restoreAllMocks();
});
const state = 'test-state-never-a-real-secret';
const callbackUrl = 'http://127.0.0.1:12345/auth/callback';
function prompt(callback = callbackUrl): ManagementPrompt {
  const url = new URL('https://login.example.test/authorize');
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('state', state);
  return { kind: 'callback', url: url.href, expiresAt: Date.now() + 60_000 };
}
async function receiver(
  options: Partial<Parameters<typeof createCloudAuthorizationCallback>[0]> = {},
) {
  const submit = vi.fn(async () => {});
  const relay = createCloudAuthorizationCallback({
    prompt: prompt(),
    assertCurrent() {},
    now: Date.now,
    submit,
    ...options,
  });
  cleanups.push(relay.close);
  await relay.ready;
  return { relay, submit };
}
const incoming = `${callbackUrl}?state=${state}&code=synthetic-code`;

it('receives a real HTTP callback, forwards only this attempt and flushes the result before closing', async () => {
  const { submit } = await receiver();
  const response = await sockets.fetch(incoming);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('synthetic-code');
  expect(submit).toHaveBeenCalledExactlyOnceWith(incoming);
  await vi.waitFor(() => expect(sockets.servers.get('127.0.0.1')!.listening).toBe(false));
});

it.each([
  ['wrong state', incoming.replace(state, 'wrong'), {}, 400],
  ['duplicate state', `${incoming}&state=${state}`, {}, 400],
  ['duplicate code', `${incoming}&code=second`, {}, 400],
  ['error with code', `${incoming}&error=denied`, {}, 400],
  ['wrong path', incoming.replace('/auth/callback', '/other'), {}, 404],
  ['wrong method', incoming, { method: 'POST' }, 405],
  ['wrong host', incoming, { headers: { Host: 'evil.example' } }, 400],
  ['wrong origin', incoming, { headers: { Origin: 'https://evil.example' } }, 403],
])('rejects %s without consuming the current attempt', async (_name, url, init, status) => {
  const { submit } = await receiver();
  expect((await sockets.fetch(url as string, init as RequestInit)).status).toBe(status);
  expect(submit).not.toHaveBeenCalled();
  expect((await sockets.fetch(incoming)).status).toBe(200);
  expect(submit).toHaveBeenCalledTimes(1);
});

it('serializes automatic and manual responses while the cloud acknowledgement is pending', async () => {
  let finish!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { relay } = await receiver({ submit });
  const pending = sockets.fetch(incoming);
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect((await sockets.fetch(incoming)).status).toBe(409);
  expect(() => relay.claimManual(incoming)).toThrow('BUSY');
  finish();
  expect((await pending).status).toBe(200);
});

it('returns an error page on rejected cloud writeback, never a false success', async () => {
  await receiver({
    submit: async () => {
      throw Error('synthetic private failure');
    },
  });
  const result = await sockets.fetch(incoming);
  expect(result.status).toBe(502);
  expect(await result.text()).not.toContain('synthetic private failure');
});

it('does not consume the receiver on an invalid manual response', async () => {
  const { relay, submit } = await receiver();
  expect(() => relay.claimManual(incoming.replace(state, 'expired-attempt'))).toThrow('NOT_READY');
  expect((await sockets.fetch(incoming)).status).toBe(200);
  expect(submit).toHaveBeenCalledTimes(1);
});

it.each([
  'https://example.test/callback',
  'http://127.0.0.1:80/callback',
  'http://127.0.0.1:12345/callback?target=other',
])('rejects an unsafe listener target %s', async (url) => {
  await expect(receiver({ prompt: prompt(url) })).rejects.toThrow('NOT_READY');
  expect(sockets.listen).not.toHaveBeenCalled();
});

it('rejects ambiguous states before opening a listener', async () => {
  const p = prompt();
  p.url += '&state=another';
  await expect(receiver({ prompt: p })).rejects.toThrow('NOT_READY');
  expect(sockets.listen).not.toHaveBeenCalled();
});

it('releases an expired receiver without further UI polling', async () => {
  await receiver({ prompt: { ...prompt(), expiresAt: Date.now() + 100 } });
  await vi.waitFor(() => expect(sockets.servers.get('127.0.0.1')!.listening).toBe(false));
});

it('leaves an occupied callback port and its owner unchanged', async () => {
  sockets.listen.mockRestore();
  const owner = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => owner.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(owner.address() as { port: number }).port}/auth/callback`;
  await expect(receiver({ prompt: prompt(endpoint) })).rejects.toThrow('NOT_READY');
  expect(owner.listening).toBe(true);
  expect((await fetch(endpoint)).status).toBe(204);
});

async function cloudFlow() {
  const f = fixture();
  cleanups.push(f.stop);
  const received = vi.fn();
  f.run.mockImplementationOnce(async (_values, execution) => {
    await new Promise<void>((resolve) => {
      execution.prompt(prompt(), async (value) => {
        received(value);
        resolve();
      });
      execution.onCancel(resolve);
    });
  });
  const api = f.bridge();
  const { handle } = await api.open({ deviceId: 'cloud-a' });
  const page = await api.manage({ handle, command: { operation: 'list', section: 'providers' } });
  if (!page.ok || !('management' in page) || page.management.kind !== 'page')
    throw Error('fixture');
  const operationId = randomUUID();
  await api.manage({
    handle,
    command: {
      operation: 'run',
      operationId,
      actionId: page.management.items[0]!.actions[0]!.id,
      values: {},
    },
  });
  const status = () => api.manage({ handle, command: { operation: 'status', operationId } });
  const waiting = await status();
  expect(waiting).toMatchObject({ management: { phase: 'waiting' } });
  return { ...f, api, handle, operationId, status, received };
}

it('binds before exposing the prompt, uses the existing cloud queue and preserves another window', async () => {
  const f = await cloudFlow();
  const other = await f.bridge(2).open({ deviceId: 'cloud-a' });
  await Promise.all([f.status(), f.status()]);
  expect(sockets.listen).toHaveBeenCalledTimes(1);
  expect((await sockets.fetch(incoming)).status).toBe(200);
  expect(f.received).toHaveBeenCalledExactlyOnceWith(incoming);
  expect(f.history.filter((c) => c.kind === 'manage' && c.command.operation === 'respond')).toEqual(
    [
      {
        kind: 'manage',
        command: { operation: 'respond', operationId: f.operationId, value: incoming },
      },
    ],
  );
  await vi.waitFor(async () =>
    expect(await f.status()).toMatchObject({ management: { phase: 'succeeded' } }),
  );
  await expect(
    f.bridge(2).read({ handle: other.handle, domains: ['memory'] }),
  ).resolves.toHaveLength(1);
});

it.each(['cancel', 'close', 'invalidate', 'identity'] as const)(
  'rejects a late callback after %s',
  async (kind) => {
    const f = await cloudFlow();
    if (kind === 'cancel')
      await f.api.manage({
        handle: f.handle,
        command: { operation: 'cancel', operationId: f.operationId },
      });
    if (kind === 'close') await f.api.close({ handle: f.handle });
    if (kind === 'invalidate') f.service.invalidate(1);
    if (kind === 'identity') {
      f.setIdentity({ ...f.identity(), key: 'different-owner' });
      expect((await sockets.fetch(incoming)).status).toBe(410);
    } else await expect(sockets.fetch(incoming)).rejects.toThrow();
    expect(f.received).not.toHaveBeenCalled();
    expect(
      f.history.filter((c) => c.kind === 'manage' && c.command.operation === 'respond'),
    ).toHaveLength(0);
  },
);
