import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createAnthropicCompatProxy } from './server.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { ProxyHandle } from './types.js';

// opts.port 固定端口:给定则只绑这一个端口,被占用直接抛错(不随机重试),
// 由 host 侧负责 fallback。省略时维持随机 Fetch-safe 端口(默认行为)。

let proxy: ProxyHandle | null = null;
let blocker: Server | null = null;

afterEach(async () => {
  if (proxy) { await proxy.dispose(); proxy = null; }
  if (blocker) { await new Promise<void>((r) => blocker!.close(() => r())); blocker = null; }
});

describe('anthropic-compat-proxy fixed port (opts.port)', () => {
  it('binds the exact requested loopback port when free', async () => {
    // 先抢一个空闲端口拿到它的号,立刻释放,再要求 proxy 绑同一个号。
    const probe = createServer();
    const wantPort = await listenOnAvailableLoopbackPort(probe);
    await new Promise<void>((r) => probe.close(() => r()));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://127.0.0.1:1',
      transformRequest: [],
      port: wantPort,
    });

    expect(proxy.url).toBe(`http://127.0.0.1:${wantPort}`);
  });

  it('throws (no random retry) when the requested port is already in use', async () => {
    blocker = createServer();
    const takenPort = await listenOnAvailableLoopbackPort(blocker);

    await expect(
      createAnthropicCompatProxy({
        upstream: 'http://127.0.0.1:1',
        transformRequest: [],
        port: takenPort,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('still picks a random port when opts.port is omitted', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://127.0.0.1:1',
      transformRequest: [],
    });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
