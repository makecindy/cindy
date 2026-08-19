import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { WORKLOUDER_CODEX_EMPTY_DEVICE_STATE } from '../../../shared/workLouderCodex.js';
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

  it('starts HID listening even when there is no lighting activity', () => {
    const child = new FakeChild();
    const fork = vi.fn(() => child);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });

    client.setAgentKeyPressHandler(vi.fn());

    expect(fork).toHaveBeenCalledWith('/sdk');
    expect(child.postMessage).toHaveBeenCalledWith({ kind: 'listen' });
  });

  it('probes a running host but never starts one just to probe', () => {
    const child = new FakeChild();
    const fork = vi.fn(() => child);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });

    // Nothing running yet: probing must not spin up the host, or merely opening
    // settings would start it on a machine with no such keyboard.
    client.probe();
    expect(fork).not.toHaveBeenCalled();

    client.setAgentKeyPressHandler(vi.fn());
    client.probe();

    expect(child.postMessage).toHaveBeenLastCalledWith({ kind: 'probe' });
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

    child.emit('message', { kind: 'hid', event: { key: 'AG04', act: 1 } });

    expect(onAgentKeyPress).toHaveBeenCalledWith(4);
  });

  it('forwards device activity and connection status changes', () => {
    const child = new FakeChild();
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork: () => child,
      log: logger(),
    });
    const onActivity = vi.fn();
    const onStatus = vi.fn();
    client.setDeviceActivityHandler(onActivity);
    client.setConnectionStatusHandler(onStatus);
    client.setAgentKeyPressHandler(vi.fn());

    child.emit('message', { kind: 'activity' });
    child.emit('message', { kind: 'state', status: 'connected' });
    child.emit('message', { kind: 'state', status: 'connected' });
    child.emit('message', { kind: 'state', status: 'not-detected' });

    expect(onActivity).toHaveBeenCalledOnce();
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
      'connecting',
      'connected',
      'not-detected',
      'connecting',
    ]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('forwards HID, joystick, device, and connection reasons from the host', () => {
    const child = new FakeChild();
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork: () => child,
      log: logger(),
    });
    const onHid = vi.fn();
    const onJoystick = vi.fn();
    const onDevice = vi.fn();
    const onReason = vi.fn();
    client.setHidInputHandler(onHid);
    client.setJoystickInputHandler(onJoystick);
    client.setDeviceStateHandler(onDevice);
    client.setConnectionReasonHandler(onReason);

    const device = {
      ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
      deviceType: 'codex-micro' as const,
      isUsbConnection: true,
    };
    child.emit('message', { kind: 'hid', event: { key: 'ACT12', act: 1 } });
    child.emit('message', { kind: 'joystick', event: { angle: 0.25, distance: 1 } });
    child.emit('message', { kind: 'device', device });
    child.emit('message', {
      kind: 'state',
      status: 'error',
      reason: 'connection-timeout',
    });

    expect(onHid).toHaveBeenCalledWith({ key: 'ACT12', act: 1 });
    expect(onJoystick).toHaveBeenCalledWith({ angle: 0.25, distance: 1 });
    expect(onDevice).toHaveBeenCalledWith(device);
    expect(onReason).toHaveBeenLastCalledWith('connection-timeout');
  });

  it('reports unavailable when the official SDK cannot be resolved', () => {
    const resolveSdk = vi.fn(() => null);
    const fork = vi.fn();
    const client = new WorkLouderCodexHostClient({ resolveSdk, fork, log: logger() });
    const onStatus = vi.fn();
    client.setConnectionStatusHandler(onStatus);

    client.setAgentKeyPressHandler(vi.fn());

    expect(resolveSdk).toHaveBeenCalledOnce();
    expect(fork).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('unavailable');
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

  it('kills and restarts a host whose native HID connection never settles', async () => {
    vi.useFakeTimers();
    try {
      const children = [new FakeChild(), new FakeChild()];
      const fork = vi.fn(() => children[fork.mock.calls.length - 1]);
      const onStatus = vi.fn();
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork,
        log: logger(),
        connectTimeoutMs: 100,
      });
      client.setConnectionStatusHandler(onStatus);
      client.setAgentKeyPressHandler(vi.fn());

      await vi.advanceTimersByTimeAsync(100);
      expect(children[0].kill).toHaveBeenCalledOnce();
      expect(onStatus).toHaveBeenLastCalledWith('error');

      await vi.advanceTimersByTimeAsync(500);
      expect(fork).toHaveBeenCalledTimes(2);
      expect(children[1].postMessage).toHaveBeenCalledWith({ kind: 'listen' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the connection watchdog after the first state message', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork: () => child,
        log: logger(),
        connectTimeoutMs: 100,
      });
      client.setAgentKeyPressHandler(vi.fn());
      child.emit('message', { kind: 'state', status: 'connected' });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset the crash budget on a connection that dies immediately', async () => {
    vi.useFakeTimers();
    try {
      const children = Array.from({ length: 7 }, () => new FakeChild());
      const fork = vi.fn(() => children[fork.mock.calls.length - 1]);
      const log = logger();
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork,
        log,
        stableConnectionMs: 10_000,
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

      for (let index = 0; index < 6; index += 1) {
        children[index].emit('message', { kind: 'state', status: 'connected' });
        children[index].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(Math.min(10_000, 500 * 2 ** index));
      }

      expect(fork).toHaveBeenCalledTimes(6);
      expect(log.error).toHaveBeenCalledWith(
        'Codex Micro lighting host repeatedly crashed; disabled until restart',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('recycles the host immediately after a live session drops', () => {
    const children = [new FakeChild(), new FakeChild()];
    const fork = vi.fn(() => children[fork.mock.calls.length - 1]);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });
    client.setAgentKeyPressHandler(vi.fn());
    children[0].emit('message', { kind: 'state', status: 'connected' });
    children[0].emit('message', { kind: 'state', status: 'not-detected' });

    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(children[1].postMessage).toHaveBeenCalledWith({ kind: 'listen' });
  });
});

describe('Work Louder SDK resolution', () => {
  it('looks for ChatGPT and Codex installs on Windows as well as macOS', () => {
    const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
    expect(source).toContain("process.platform === 'win32'");
    expect(source).toContain('LOCALAPPDATA');
    expect(source).toContain("path.join(root, 'Programs', appName, packageTail)");
    expect(source).not.toContain("if (process.platform !== 'darwin') return null;");
  });
});
