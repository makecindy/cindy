import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './fixture';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
async function setup() {
  const f = fixture();
  cleanups.push(f.stop);
  const bridge = f.bridge(),
    session = await bridge.open({ deviceId: 'cloud-a' });
  return { ...f, connectWindow: f.bridge, bridge, session };
}
it('never exposes the access token or remote session ID through IPC', async () => {
  const f = await setup();
  expect(f.session).not.toHaveProperty('sessionId');
  expect(JSON.stringify(f.session)).not.toContain('invalid-test-token');
  expect(f.session.handle).toMatch(/^[a-f0-9-]{36}$/);
});
it.each(['instanceId', 'baseUrl', 'accessToken', 'owner', 'windowId'])(
  'rejects renderer-supplied authority field %s',
  async (key) => {
    const f = await setup();
    const count = f.request.mock.calls.length;
    await expect(f.bridge.open({ deviceId: 'cloud-a', [key]: 'forged' } as never)).rejects.toThrow(
      'INVALID_PARAMS',
    );
    expect(f.request).toHaveBeenCalledTimes(count);
  },
);
it('blocks use of another window handle, local-only domains and forged receipt IDs', async () => {
  const f = await setup(),
    count = f.request.mock.calls.length;
  await expect(
    f.connectWindow(2).read({ handle: f.session.handle, domains: ['memory'] }),
  ).rejects.toThrow('SCOPE_CHANGED');
  await expect(
    f.bridge.read({ handle: f.session.handle, domains: ['shortcuts'] as never }),
  ).rejects.toThrow('INVALID_PARAMS');
  await expect(
    f.bridge.read({ handle: f.session.handle, domains: ['personalization'] }),
  ).rejects.toThrow('UNSUPPORTED');
  await expect(
    f.bridge.receipt({ handle: f.session.handle, operationId: randomUUID() }),
  ).rejects.toThrow('SCOPE_CHANGED');
  expect(f.request).toHaveBeenCalledTimes(count);
});
it('preserves handles on a same-owner token refresh and uses the current token', async () => {
  const f = await setup();
  f.setIdentity({ ...f.identity(), accessToken: 'rotated-test-token' });
  await f.bridge.read({ handle: f.session.handle, domains: ['memory'] });
  expect(f.request.mock.calls.at(-1)![0].accessToken).toBe('rotated-test-token');
});
it('checks captured sender trust again before making a request', async () => {
  const f = fixture();
  cleanups.push(f.stop);
  let trusted = true;
  const caller = {
    id: 1,
    assertCurrent() {
      if (!trusted) throw Error('untrusted-frame');
    },
  };
  const session = await f.service.open(caller, 'cloud-a'),
    count = f.request.mock.calls.length;
  trusted = false;
  await expect(f.service.read(caller, session.handle, ['memory'])).rejects.toThrow(
    'untrusted-frame',
  );
  expect(f.request).toHaveBeenCalledTimes(count);
});
it('does not return a response that arrives after window invalidation', async () => {
  const f = await setup();
  let release!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.bridge.read({ handle: f.session.handle, domains: ['memory'] });
  const rejected = expect(pending).rejects.toThrow('SCOPE_CHANGED');
  f.service.invalidate(1);
  release({});
  await rejected;
});
it.each(['device', 'instance', 'duplicate'] as const)(
  'rejects an inconsistent %s target binding',
  async (kind) => {
    const f = fixture();
    cleanups.push(f.stop);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const response = (await original(...args)) as Record<string, unknown>;
      if (kind === 'duplicate' && args[1].endsWith('/instances'))
        return {
          instances: [
            { instanceId: 'a', deviceId: 'cloud-a' },
            { instanceId: 'b', deviceId: 'cloud-a' },
          ],
        };
      if (args[1].endsWith('/sessions'))
        return { ...response, [kind === 'device' ? 'deviceId' : 'instanceId']: 'wrong-target' };
      return response;
    });
    await expect(f.bridge().open({ deviceId: 'cloud-a' })).rejects.toThrow('SCOPE_CHANGED');
    expect(f.history).toEqual([]);
  },
);
it('requires an issued revision and never resubmits the same write operation', async () => {
  const f = await setup(),
    handle = f.session.handle;
  const [read] = await f.bridge.read({ handle, domains: ['memory'] });
  if (!read.ok || !('settings' in read) || read.settings.status !== 'ready') throw Error('fixture');
  const change = {
    domain: 'memory' as const,
    operationId: read.settings.operationId,
    expectedRevision: read.settings.revision,
    set: { maker: false },
  };
  await expect(
    f.bridge.save({ handle, change: { ...change, expectedRevision: 'forged' } }),
  ).rejects.toThrow('NOT_READY');
  await f.bridge.save({ handle, change });
  await expect(f.bridge.save({ handle, change })).rejects.toThrow('NOT_READY');
  expect(f.history.filter((c) => c.kind === 'update')).toHaveLength(1);
});
it('rejects responses correlated to a different queue request', async () => {
  const f = await setup();
  f.request.mockResolvedValueOnce({
    requestId: randomUUID(),
    status: 'complete',
    result: f.state(),
  });
  await expect(f.bridge.read({ handle: f.session.handle, domains: ['memory'] })).rejects.toThrow(
    'INVALID_RESPONSE',
  );
});
it('limits concurrent requests before dispatching another read', async () => {
  const f = await setup(),
    pending: Array<Promise<unknown>> = [];
  const releases: Array<(value: unknown) => void> = [];
  f.request.mockImplementation(async () => new Promise((resolve) => releases.push(resolve)));
  for (let i = 0; i < 4; i++)
    pending.push(f.bridge.read({ handle: f.session.handle, domains: ['memory'] }).catch(() => {}));
  await expect(f.bridge.read({ handle: f.session.handle, domains: ['memory'] })).rejects.toThrow(
    'BUSY',
  );
  expect(releases).toHaveLength(4);
  f.service.invalidate();
  releases.forEach((release) => release({}));
  await Promise.all(pending);
});
it('deduplicates cancel/close cleanup without cancelling another window operation', async () => {
  const f = await setup(),
    handle = f.session.handle;
  const page = await f.bridge.manage({
    handle,
    command: { operation: 'list', section: 'providers' },
  });
  if (!page.ok || !('management' in page) || page.management.kind !== 'page')
    throw Error('fixture');
  const operationId = randomUUID();
  await f.bridge.manage({
    handle,
    command: {
      operation: 'run',
      actionId: page.management.items[0]!.actions[0]!.id,
      operationId,
      values: {},
    },
  });
  await f.connectWindow(2).open({ deviceId: 'cloud-a' });
  await Promise.all([
    f.bridge.cancelAuthorizations({ handle }),
    f.bridge.close({ handle }),
    f.bridge.close({ handle }),
  ]);
  await vi.waitFor(() => expect(f.cancelled).toHaveBeenCalledTimes(1));
  expect(
    f.history.filter((c) => c.kind === 'manage' && c.command.operation === 'cancel'),
  ).toHaveLength(1);
  expect(f.request.mock.calls.filter((c) => c[2] === 'DELETE')).toHaveLength(1);
});
it.each([
  [true, 0, '?wait=1'],
  [false, 1, ''],
])(
  'reads a queued result at once only where CIS holds the read (resultWait %s)',
  async (resultWait, pauses, query) => {
    const f = fixture(undefined, { resultWait });
    cleanups.push(f.stop);
    const bridge = f.bridge(),
      { handle } = await bridge.open({ deviceId: 'cloud-a' });
    const [read] = await bridge.read({ handle, domains: ['memory'] });
    expect(read.ok && 'settings' in read && read.settings.domain).toBe('memory');
    expect(f.pause).toHaveBeenCalledTimes(pauses);
    const polls = f.request.mock.calls
      .map(([, path, method]) => `${method} ${path}`)
      .filter((call) => call.startsWith('GET') && call.includes('/requests/'));
    expect(polls).toHaveLength(1);
    expect(polls[0].endsWith(query)).toBe(true);
  },
);
