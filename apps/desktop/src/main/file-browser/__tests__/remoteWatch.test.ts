import type { BrowserWindow } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import { RemoteWatchRegistry } from '../remote-watch.js';
import type { RemoteFileBrowserManager } from '../remote.js';

function makeWindow(id: number): BrowserWindow {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
  } as unknown as BrowserWindow;
}

function makeManager() {
  const request = vi.fn(async (_hostId: string, _method: string, _params: unknown) => ({}));
  const manager = {
    normalizeHostId: (hostId: string) => hostId,
    onHostEvent: vi.fn(() => vi.fn()),
    onHostConnected: vi.fn(() => vi.fn()),
    request,
  } as unknown as RemoteFileBrowserManager;
  return { manager, request };
}

describe('RemoteWatchRegistry', () => {
  it('does not collide when HostRef and workdir contain the old tuple delimiter', async () => {
    const { manager, request } = makeManager();
    const registry = new RemoteWatchRegistry(manager);

    await registry.start(makeWindow(1), 'ssh-config:a::b', '/c', {}, vi.fn());
    await registry.start(makeWindow(1), 'ssh-config:a', 'b::/c', {}, vi.fn());

    expect(request.mock.calls.filter(([, method]) => method === 'watchStart')).toHaveLength(2);

    await registry.stop(1, 'ssh-config:a::b', '/c');
    await registry.stop(1, 'ssh-config:a', 'b::/c');

    expect(request.mock.calls.filter(([, method]) => method === 'watchStop')).toHaveLength(2);
  });

  it('stops a daemon watch only after its final window subscription is removed', async () => {
    const { manager, request } = makeManager();
    const registry = new RemoteWatchRegistry(manager);

    await registry.start(makeWindow(1), 'ssh-config:a::b', '/work', {}, vi.fn());
    await registry.start(makeWindow(2), 'ssh-config:a::b', '/work', {}, vi.fn());

    await registry.stop(1, 'ssh-config:a::b', '/work');
    expect(request.mock.calls.filter(([, method]) => method === 'watchStop')).toHaveLength(0);

    await registry.stop(2, 'ssh-config:a::b', '/work');
    expect(request.mock.calls.filter(([, method]) => method === 'watchStop')).toHaveLength(1);
  });
});
