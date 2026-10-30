import http from 'node:http';
import type { ListenOptions } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PluginOauthOffer } from '@cindy/device-link';
import { listenForOauthCallback } from '../loopbackListener.js';

import { ephemeralCallbackPorts } from './ephemeralCallbackPorts.js';

let sockets: ReturnType<typeof ephemeralCallbackPorts>;
beforeEach(() => {
  sockets = ephemeralCallbackPorts();
});
const state = 's'.repeat(43);
const resources: Array<{ close(): unknown }> = [];
afterEach(async () => {
  try {
    await Promise.all([...resources.splice(0), ...sockets.servers.values()].map((resource) => {
      if (!(resource instanceof http.Server)) return resource.close();
      return new Promise<void>((resolve) => {
        resource.close(() => resolve());
        resource.closeAllConnections();
      });
    }));
  } finally {
    vi.restoreAllMocks();
  }
});

function offer(port: number, hostname = 'localhost'): PluginOauthOffer {
  return {
    authorizeUrl: 'https://provider.example/authorize',
    callbackUrl: `http://${hostname}:${port}/callback`,
    state,
    corsOrigins: [],
    corsHosts: [],
  };
}

function request(host: string, port: number, options: { path?: string; authority?: string } = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.get(
      {
        host,
        port: sockets.port(host),
        agent: false,
        path: options.path ?? `/callback?state=${state}&error=access_denied`,
        headers: { Host: options.authority ?? `localhost:${port}` },
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode!));
      },
    );
    req.setTimeout(2_000, () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
  });
}

it.each(['127.0.0.1', '::1'])(
  'accepts localhost callbacks via %s and consumes once across families',
  async (first) => {
    const port = 12345;
    const deliver = vi.fn(async () => {});
    const listener = await listenForOauthCallback(offer(port), deliver, () => {});
    resources.push(listener);
    for (const host of ['127.0.0.1', '::1']) {
      expect(await request(host, port, { authority: `evil.example:${port}` })).toBe(400);
      expect(await request(host, port, { path: '/callback?state=wrong&code=synthetic' })).toBe(400);
      expect(await request(host, port, { path: '/wrong-path' })).toBe(404);
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(await request(first, port)).toBe(200);
    const other = first === '::1' ? '127.0.0.1' : '::1';
    expect(await request(other, port)).toBe(409);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ state, error: 'access_denied' });
    const closing = listener.close();
    expect(listener.close()).toBe(closing);
    await closing;
    // Both ports are released, including on an idempotent cancellation.
    expect([...sockets.servers.values()].every((server) => !server.listening)).toBe(true);
  },
);

it('shares consumption while delivery through the other family is still pending', async () => {
  const port = 12345;
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const deliver = vi.fn(() => {
    started();
    return delivered;
  });
  resources.push(await listenForOauthCallback(offer(port), deliver, () => {}));
  const first = request('::1', port);
  try {
    await entered;
    expect(await request('127.0.0.1', port)).toBe(409);
  } finally {
    finish();
    await first;
  }
  expect(deliver).toHaveBeenCalledOnce();
});

it.each([
  ['127.0.0.1', '127.0.0.1', '::1'],
  ['[::1]', '::1', '127.0.0.1'],
])('keeps a literal %s callback confined to that interface', async (hostname, host, other) => {
  const port = 12345;
  resources.push(
    await listenForOauthCallback(
      offer(port, hostname),
      async () => {},
      () => {},
    ),
  );
  expect(await request(host, port, { authority: `${hostname}:${port}` })).toBe(200);
  expect(sockets.servers.has(other)).toBe(false);
});

it('fails the whole localhost setup on a port conflict and leaves its owner alone', async () => {
  sockets.listen.mockRestore();
  const owner = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  resources.push(owner);
  await new Promise<void>((resolve) => owner.listen(0, '::1', resolve));
  const port = (owner.address() as { port: number }).port;
  const deliver = vi.fn(async () => {});
  const created = vi.spyOn(http, 'createServer');
  const original = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
    this: http.Server,
    ...args: unknown[]
  ) {
    const options = args[0] as ListenOptions;
    expect(options.port).toBe(port);
    // Keep the occupied IPv6 port real; do not depend on that numeric port also
    // being free on IPv4 just to exercise partial-setup cleanup.
    return Reflect.apply(original, this, [
      { ...options, port: options.host === '127.0.0.1' ? 0 : port },
      ...args.slice(1),
    ]);
  });
  await expect(listenForOauthCallback(offer(port), deliver, () => {})).rejects.toThrow(
    'OAUTH_BRIDGE_UNAVAILABLE',
  );
  expect(created.mock.results.every(({ value }) => !value.listening)).toBe(true);
  expect(created).toHaveBeenCalledTimes(2);
  expect(owner.listening).toBe(true);
  expect(
    await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '::1', port, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        })
        .on('error', reject);
    }),
  ).toBe(204);
  expect(deliver).not.toHaveBeenCalled();
});

it('releases both listeners if the card is no longer current after binding', async () => {
  const port = 12345;
  await expect(
    listenForOauthCallback(
      offer(port),
      async () => {},
      () => {
        throw new Error('stale');
      },
    ),
  ).rejects.toThrow('OAUTH_BRIDGE_UNAVAILABLE');
  expect(sockets.servers.size).toBe(2);
  expect([...sockets.servers.values()].every((server) => !server.listening)).toBe(true);
});

it.each(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])(
  'supports an OS with IPv6 disabled (%s), but never a port conflict fallback',
  async (code) => {
    const port = 12345;
    const original = http.Server.prototype.listen;
    vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      if ((args[0] as ListenOptions).host === '::1') {
        queueMicrotask(() =>
          this.emit('error', Object.assign(new Error('unavailable family'), { code })),
        );
        return this;
      }
      return Reflect.apply(original, this, args);
    });
    resources.push(
      await listenForOauthCallback(
        offer(port),
        async () => {},
        () => {},
      ),
    );
    expect(await request('127.0.0.1', port)).toBe(200);
    await expect(
      listenForOauthCallback(
        offer(port, '[::1]'),
        async () => {},
        () => {},
      ),
    ).rejects.toThrow('OAUTH_BRIDGE_UNAVAILABLE');
  },
);

it('waits for both server close callbacks, including repeated cancellation', async () => {
  const port = 12345;
  const listener = await listenForOauthCallback(offer(port), async () => {}, () => {});
  resources.push(listener);
  const original = http.Server.prototype.close;
  const completions: Array<() => void> = [];
  vi.spyOn(http.Server.prototype, 'close').mockImplementation(function (
    this: http.Server,
    callback?: (error?: Error) => void,
  ) {
    return original.call(this, (error) => {
      completions.push(() => callback?.(error));
    });
  });
  let finished = false;
  const closing = listener.close();
  try {
    expect(closing).toBeInstanceOf(Promise);
    expect(listener.close()).toBe(closing);
    void closing.then(() => { finished = true; });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(finished).toBe(false);
    completions.shift()!();
    await Promise.resolve();
    expect(finished).toBe(false);
    completions.shift()!();
    await closing;
    expect(finished).toBe(true);
  } finally {
    vi.restoreAllMocks();
    for (const complete of completions.splice(0)) complete();
  }
  expect([...sockets.servers.values()].every((server) => !server.listening)).toBe(true);
});
