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

  it('releases the HID host when this instance turns the keyboard off', async () => {
    const child = new FakeChild();
    const fork = vi.fn(() => child);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });
    const status = vi.fn();
    client.setConnectionStatusHandler(status);
    client.setAgentKeyPressHandler(vi.fn());

    client.setDeviceEnabled(false);

    expect(child.postMessage).toHaveBeenCalledWith({ kind: 'stop' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('disabled');
    expect(fork).toHaveBeenCalledTimes(1);

    child.emit('message', { kind: 'stopped' });
    expect(child.kill).toHaveBeenCalledOnce();

    client.probe();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(child.postMessage).toHaveBeenCalledWith({ kind: 'discover' });

    client.setDeviceEnabled(true);
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('restarts a still-wanted host after disable finishes stopping', () => {
    const stopping = new FakeChild();
    const restarted = new FakeChild();
    const children = [stopping, restarted];
    const fork = vi.fn(() => children.shift()!);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });
    client.setAgentKeyPressHandler(vi.fn());
    expect(fork).toHaveBeenCalledTimes(1);

    client.setDeviceEnabled(false);
    stopping.postMessage.mockClear();
    client.setDeviceEnabled(true);

    expect(fork).toHaveBeenCalledTimes(1);
    expect(stopping.postMessage).not.toHaveBeenCalled();

    stopping.emit('message', { kind: 'stopped' });

    expect(fork).toHaveBeenCalledTimes(2);
    expect(restarted.postMessage).toHaveBeenCalledWith({ kind: 'init', sdkEntry: '/sdk' });
    expect(restarted.postMessage).toHaveBeenCalledWith({ kind: 'listen' });
  });

  it('kills a host that never acknowledges stop after disable', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork: () => child,
        log: logger(),
        disposeTimeoutMs: 50,
      });
      client.setAgentKeyPressHandler(vi.fn());
      client.setDeviceEnabled(false);

      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

  it('discovers presence without occupying HID when this instance is off', () => {
    const child = new FakeChild();
    const fork = vi.fn(() => child);
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
      fork,
      log: logger(),
    });
    const presence = vi.fn();
    const status = vi.fn();
    client.setPresenceHandler(presence);
    client.setConnectionStatusHandler(status);
    client.setDeviceEnabled(false);
    status.mockClear();
    client.probe();

    expect(fork).toHaveBeenCalledWith('/sdk');
    expect(child.postMessage).toHaveBeenCalledWith({ kind: 'discover' });
    expect(child.postMessage).not.toHaveBeenCalledWith({ kind: 'listen' });

    child.emit('message', {
      kind: 'presence',
      present: true,
      deviceType: 'codex-micro',
      isUsbConnection: true,
    });
    expect(presence).toHaveBeenCalledWith(true, {
      deviceType: 'codex-micro',
      isUsbConnection: true,
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('backs off presence-only host crashes instead of forking in a loop', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const fork = vi.fn(() => child);
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork,
        log: logger(),
      });
      client.setDeviceEnabled(false);
      client.probe();
      expect(fork).toHaveBeenCalledTimes(1);

      child.emit('exit', 1);
      expect(fork).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(fork).toHaveBeenCalledTimes(2);

      for (let crash = 0; crash < 5; crash += 1) {
        child.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const forksAfterBudget = fork.mock.calls.length;
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fork).toHaveBeenCalledTimes(forksAfterBudget);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let repeated presence probes postpone the crash-budget reset', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const fork = vi.fn(() => child);
      const client = new WorkLouderCodexHostClient({
        resolveSdk: () => ({ entry: '/sdk', source: 'openai-app' }),
        fork,
        log: logger(),
        stableConnectionMs: 30,
      });
      client.setDeviceEnabled(false);
      client.probe();

      for (let crash = 0; crash < 5; crash += 1) {
        child.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(fork.mock.calls.length).toBeGreaterThan(1);

      child.emit('message', { kind: 'presence', present: true, deviceType: 'codex-micro' });
      await vi.advanceTimersByTimeAsync(10);
      child.emit('message', { kind: 'presence', present: true, deviceType: 'codex-micro' });
      await vi.advanceTimersByTimeAsync(10);
      child.emit('message', { kind: 'presence', present: true, deviceType: 'codex-micro' });
      await vi.advanceTimersByTimeAsync(30);

      const forksBefore = fork.mock.calls.length;
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(500);
      expect(fork).toHaveBeenCalledTimes(forksBefore + 1);
    } finally {
      vi.useRealTimers();
    }
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
