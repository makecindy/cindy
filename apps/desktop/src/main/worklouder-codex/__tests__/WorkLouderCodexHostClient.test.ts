import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkLouderCodexHostClient,
  type WorkLouderCodexChildLike,
} from '../WorkLouderCodexHostClient.js';
import { createWorkLouderCodexLightingFrame } from '../protocol.js';

class FakeChild extends EventEmitter implements WorkLouderCodexChildLike {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('WorkLouderCodexHostClient', () => {
  it('does not load the optional native SDK for an idle Cindy', () => {
    const resolveSdk = vi.fn(() => null);
    const client = new WorkLouderCodexHostClient({
      resolveSdk,
      fork: vi.fn(),
      log: logger(),
    });

    client.update(createWorkLouderCodexLightingFrame([]));

    expect(resolveSdk).not.toHaveBeenCalled();
  });

  it('forks the isolated host on first active task', () => {
    const child = new FakeChild();
    const fork = vi.fn(() => child);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });
    const frame = createWorkLouderCodexLightingFrame([
      {
        sessionId: 'session-1',
        phase: 'running',
        compactDetail: '',
        attention: false,
      },
    ]);

    client.update(frame);

    expect(fork).toHaveBeenCalledWith('/sdk');
    expect(child.postMessage).toHaveBeenCalledWith({ kind: 'apply', frame });
  });

  it('asks the host to turn lighting off before shutdown', async () => {
    const child = new FakeChild();
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork: () => child,
      log: logger(),
      disposeTimeoutMs: 50,
    });
    client.update(
      createWorkLouderCodexLightingFrame([
        {
          sessionId: 'session-1',
          phase: 'running',
          compactDetail: '',
          attention: false,
        },
      ]),
    );

    const disposing = client.dispose();
    child.emit('message', { kind: 'stopped' });
    await disposing;

    expect(child.postMessage).toHaveBeenLastCalledWith({ kind: 'stop' });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('forwards a validated Agent key press from the isolated host', () => {
    const child = new FakeChild();
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork: () => child,
      log: logger(),
    });
    const onAgentKeyPress = vi.fn();
    client.setAgentKeyPressHandler(onAgentKeyPress);
    client.update(
      createWorkLouderCodexLightingFrame([
        {
          sessionId: 'session-1',
          phase: 'running',
          compactDetail: '',
          attention: false,
        },
      ]),
    );

    child.emit('message', { kind: 'agent-key', slot: 4 });

    expect(onAgentKeyPress).toHaveBeenCalledWith(4);
  });

  it('restarts the isolated host after a native-process crash', async () => {
    vi.useFakeTimers();
    try {
      const children = [new FakeChild(), new FakeChild()];
      const fork = vi.fn(() => children[fork.mock.calls.length - 1]);
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork,
        log: logger(),
      });
      const frame = createWorkLouderCodexLightingFrame([
        {
          sessionId: 'session-1',
          phase: 'running',
          compactDetail: '',
          attention: false,
        },
      ]);
      client.update(frame);

      children[0].emit('exit', 1);
      await vi.advanceTimersByTimeAsync(500);

      expect(fork).toHaveBeenCalledTimes(2);
      expect(children[1].postMessage).toHaveBeenCalledWith({ kind: 'apply', frame });
    } finally {
      vi.useRealTimers();
    }
  });
});
