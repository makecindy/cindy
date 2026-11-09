import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkLouderCodexWindowRevealFrame } from '../protocol.js';

const host = vi.hoisted(() => {
  const port = {
    postMessage: vi.fn(),
    on: vi.fn(),
  };
  const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', { value: port, configurable: true });
  return {
    port,
    previousPort,
    sdk: {} as Record<string, unknown>,
    // In-memory keymap backup directory; the host only needs these fs calls.
    files: new Map<string, string>(),
  };
});

vi.mock('node:fs/promises', () => {
  const missing = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const memoryFs = {
    mkdir: async () => undefined,
    access: async (file: string) => {
      if (!host.files.has(file)) throw missing();
    },
    readFile: async (file: string) => {
      const text = host.files.get(file);
      if (text === undefined) throw missing();
      return text;
    },
    writeFile: async (file: string, text: string) => {
      host.files.set(file, text);
    },
    rename: async (from: string, to: string) => {
      host.files.set(to, host.files.get(from)!);
      host.files.delete(from);
    },
    rm: async (file: string) => {
      host.files.delete(file);
    },
  };
  return { default: memoryFs, ...memoryFs };
});

vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire: () => () => host.sdk,
  };
});

import {
  classifyConnectionError,
  isOptionalDeviceStatusError,
  postDeviceStatus,
} from '../workLouderCodexHostProcess.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

afterAll(() => {
  if (host.previousPort) Object.defineProperty(process, 'parentPort', host.previousPort);
  else Reflect.deleteProperty(process, 'parentPort');
});

describe('Work Louder connection error classification', () => {
  it('keeps macOS authorization failures on the permission circuit breaker path', () => {
    setPlatform('darwin');

    expect(classifyConnectionError('HID access denied by Input Monitoring')).toBe(
      'permission-required',
    );
    expect(classifyConnectionError('operation not allowed')).toBe('permission-required');
    expect(
      classifyConnectionError(
        'hid_open_path: failed to open IOHIDDevice: (0xE00002E2) (iokit/common) not permitted',
      ),
    ).toBe('permission-required');
    expect(classifyConnectionError('device has been closed: 0xE00002E2')).toBe(
      'permission-required',
    );
  });

  it('keeps Windows access denied on the bounded connection retry path', () => {
    setPlatform('win32');

    expect(classifyConnectionError('HID access denied')).toBe('connection-failed');
    expect(classifyConnectionError('permission denied while opening HID handle')).toBe(
      'connection-failed',
    );
  });

  it('does not treat permission-looking errors as permanent outside macOS', () => {
    setPlatform('linux');

    expect(classifyConnectionError('not permitted')).toBe('connection-failed');
  });
});

// Test value: the real utility-process message entry must release SDK resources,
// stop HID access after denial and remain recoverable through host initialization.
// Regression: 2026-11-10 denied opens were classified as contention; existing tests
// only called the classifier or injected an already-classified state into the client.
// Minimum input: connect logs and throws 0xE00002E2 with a lighting request queued.
// The file-RPC leg checks denial skips the keymap restore write and keeps its snapshot,
// then the next authorized stop writes the original layout back.
// Tier: unit; in-memory SDK/parent port and fake timers, no native HID or user files.
// Standalone vitest run: 0.866s (2026-11-10); tests take 9ms.
describe('Work Louder host lifecycle', () => {
  it('releases denied/failed transports, stays idle until recovery, and tears down on removal/stop', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    const denied = new Error(
      'hid_open_path: IOHIDDevice (0xE00002E2) (iokit/common) not permitted',
    );
    type Logger = { error(...args: unknown[]): void };
    let present = true;
    let connectResult: 'denied' | 'busy' | 'false' | 'ok' = 'denied';
    let sdkLogger: Logger;
    const access = vi.fn();
    const transports: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    const hidListeners: Array<(event: unknown) => void> = [];
    const joystickListeners: Array<(event: unknown) => void> = [];
    const unsubscribe = vi.fn();
    let fileApi = false;
    const factoryKeymap = JSON.stringify({
      profiles: [
        {
          layers: [
            { id: 0, name: 'Layer 1', layout: { keymap: [['KV_1', 'KV_2']], encoders: [] } },
          ],
        },
      ],
    });
    let deviceKeymap = factoryKeymap;
    const deviceFs = {
      readFile: vi.fn(async () => ({ ok: true, value: deviceKeymap })),
      writeFile: vi.fn(async (_name: string, text: string) => {
        deviceKeymap = text;
        return { ok: true };
      }),
    };
    const getDeviceStatus = vi.fn(async () => ({ firmwareVersion: 'test' }));
    const sendLightingConfig = vi.fn(async (): Promise<unknown> => true);
    const sendThreadsLighting = vi.fn(async () => true);
    host.sdk = {
      DeviceType: { CodexMicro: 1 },
      WLDeviceDiscovery: class {
        findWLDevices() {
          return present ? [{ portPath: 'test-hid', isUsbConnection: true }] : [];
        }
      },
      WLDeviceCommImpl: class {
        private timer: ReturnType<typeof setInterval> | undefined;
        constructor(logger: Logger) {
          sdkLogger = logger;
          transports.push(this);
        }
        async connect() {
          access();
          // Model resources allocated before connect settles, including SDK-owned work.
          this.timer = setInterval(() => access(), 100);
          if (connectResult === 'denied') {
            sdkLogger.error(denied);
            throw denied;
          }
          if (connectResult === 'busy') throw new Error('IOHIDDeviceOpen: 0xE00002C5');
          return connectResult === 'ok';
        }
        disconnect = vi.fn(async () => {
          clearInterval(this.timer);
        });
      },
      RPCApiOAI: class {
        api = fileApi ? deviceFs : undefined;
        getDeviceStatus = getDeviceStatus;
        sendLightingConfig = sendLightingConfig;
        sendThreadsLighting = sendThreadsLighting;
        onHidReceived(listener: (event: unknown) => void) {
          hidListeners.push(listener);
          return unsubscribe;
        }
        onJoystickMove(listener: (event: unknown) => void) {
          joystickListeners.push(listener);
          return unsubscribe;
        }
      },
    };
    const onMessage = host.port.on.mock.calls.find(([event]) => event === 'message')![1];
    const send = (data: unknown) => onMessage({ data });
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const frame = createWorkLouderCodexWindowRevealFrame();
    const init = () =>
      send({ kind: 'init', sdkEntry: '/fake-sdk', keymapBackupDir: '/keymap-backups' });
    const expectPaused = async () => {
      expect(host.port.postMessage).toHaveBeenCalledWith({
        kind: 'state',
        status: 'error',
        reason: 'permission-required',
      });
      const calls = access.mock.calls.length;
      const statuses = getDeviceStatus.mock.calls.length;
      const lighting = sendLightingConfig.mock.calls.length;
      for (let n = 0; n < 3; n += 1) {
        send({ kind: 'listen' });
        send({ kind: 'apply', frame });
        send({ kind: 'probe' });
        send({ kind: 'rebind-creator-keymap', keymap: [['AG00']] });
        await vi.advanceTimersByTimeAsync(20_000);
      }
      expect(access).toHaveBeenCalledTimes(calls);
      expect(getDeviceStatus).toHaveBeenCalledTimes(statuses);
      expect(sendLightingConfig).toHaveBeenCalledTimes(lighting);
    };
    try {
      init();
      send({ kind: 'listen' });
      send({ kind: 'apply', frame });
      await settle();
      expect(transports[0].disconnect).toHaveBeenCalledOnce();
      expect(transports).toHaveLength(1);
      await expectPaused();

      // Main's existing permission retry/toggle creates a newly initialized host.
      connectResult = 'ok';
      init();
      send({ kind: 'listen' });
      await settle();
      expect(host.port.postMessage).toHaveBeenCalledWith({ kind: 'state', status: 'connected' });
      hidListeners.at(-1)!({ key: 'AG00', act: 1 });
      expect(host.port.postMessage).toHaveBeenCalledWith({
        kind: 'hid',
        event: expect.objectContaining({ key: 'AG00' }),
      });

      // A failed RPC envelope must also stop the next lighting write in this frame.
      sendLightingConfig.mockResolvedValueOnce({ ok: false, error: { message: denied.message } });
      const threadsBeforeDenial = sendThreadsLighting.mock.calls.length;
      send({ kind: 'apply', frame });
      await settle();
      expect(sendThreadsLighting).toHaveBeenCalledTimes(threadsBeforeDenial);
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      await expectPaused();
      init();
      send({ kind: 'listen' });
      await settle();

      // Permission can disappear during an ordinary status probe, without SDK logging.
      getDeviceStatus.mockRejectedValueOnce(denied);
      send({ kind: 'probe' });
      await settle();
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledTimes(4);
      await expectPaused();

      // False connect results also own resources; retry must release then reconnect.
      connectResult = 'busy';
      init();
      send({ kind: 'listen' });
      await settle();
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      expect(host.port.postMessage).toHaveBeenCalledWith({
        kind: 'state',
        status: 'error',
        reason: 'device-in-use',
      });
      connectResult = 'false';
      await vi.advanceTimersByTimeAsync(3_000);
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      expect(host.port.postMessage).toHaveBeenCalledWith({ kind: 'state', status: 'not-detected' });
      fileApi = true;
      connectResult = 'ok';
      // Retry delay plus the keymap reload wait after the layout is written.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(transports.at(-1)!.disconnect).not.toHaveBeenCalled();
      expect(deviceFs.writeFile).toHaveBeenCalledTimes(1);
      expect(deviceKeymap).not.toBe(factoryKeymap);
      present = false;
      getDeviceStatus.mockRejectedValueOnce(new Error('device disconnected'));
      send({ kind: 'probe' });
      // The restore chain awaits several in-memory fs calls before closing.
      await vi.advanceTimersByTimeAsync(100);
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      expect(host.port.postMessage).toHaveBeenCalledWith({ kind: 'state', status: 'not-detected' });
      // An ordinary release hands the original layout back and drops its snapshot.
      expect(deviceKeymap).toBe(factoryKeymap);
      present = true;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(transports.at(-1)!.disconnect).not.toHaveBeenCalled();
      expect(deviceKeymap).not.toBe(factoryKeymap);
      const occupiedKeymap = deviceKeymap;
      const keymapWrites = deviceFs.writeFile.mock.calls.length;
      const snapshots = [...host.files.keys()].filter((file) => file.includes('keymap-session'));
      expect(snapshots).toHaveLength(1);

      // Native SDK errors can be logger-only, with no rejected RPC to catch.
      sdkLogger!.error(denied);
      await settle();
      expect(transports.at(-1)!.disconnect).toHaveBeenCalledOnce();
      await expectPaused();
      // Denial must not write the restore to the device and must keep the snapshot.
      expect(deviceFs.writeFile).toHaveBeenCalledTimes(keymapWrites);
      expect(deviceKeymap).toBe(occupiedKeymap);
      expect(host.files.has(snapshots[0])).toBe(true);

      // After reauthorization the leftover snapshot is adopted instead of overwritten.
      init();
      send({ kind: 'listen' });
      await settle();
      expect(deviceFs.writeFile).toHaveBeenCalledTimes(keymapWrites);
      // Dispose must not allow a pending status response to resurrect the device.
      let resolveStatus!: (status: { firmwareVersion: string }) => void;
      getDeviceStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStatus = resolve;
          }),
      );
      send({ kind: 'probe' });
      send({ kind: 'stop' });
      await vi.advanceTimersByTimeAsync(400);
      expect(host.port.postMessage).toHaveBeenCalledWith({ kind: 'stopped' });
      expect(transports.every((transport) => transport.disconnect.mock.calls.length === 1)).toBe(
        true,
      );
      expect(unsubscribe).toHaveBeenCalledTimes(hidListeners.length + joystickListeners.length);
      // Normal release after reauthorization restores the original layout.
      expect(deviceKeymap).toBe(factoryKeymap);
      expect(host.files.has(snapshots[0])).toBe(false);
      const calls = access.mock.calls.length;
      host.port.postMessage.mockClear();
      resolveStatus({ firmwareVersion: 'late' });
      hidListeners.at(-1)!({ key: 'AG00', act: 1 });
      joystickListeners.at(-1)!({ a: 0, d: 1 });
      send({ kind: 'probe' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(access).toHaveBeenCalledTimes(calls);
      expect(host.port.postMessage).not.toHaveBeenCalled();
    } finally {
      send({ kind: 'stop' });
      await settle();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('Work Louder device status', () => {
  it('recognizes explicit unsupported status RPC errors as optional telemetry', () => {
    expect(isOptionalDeviceStatusError(new Error('status RPC unsupported'))).toBe(true);
    expect(isOptionalDeviceStatusError({ code: 'ERR_METHOD_NOT_FOUND' })).toBe(true);
  });

  it('keeps rejected hardware status probes fatal so unplugged handles are recycled', () => {
    expect(isOptionalDeviceStatusError(new Error('device disconnected'))).toBe(false);
    expect(isOptionalDeviceStatusError(new Error('HID request failed'))).toBe(false);
  });

  it('keeps the HID connection usable when optional status telemetry fails', async () => {
    const getDeviceStatus = vi.fn().mockRejectedValue(new Error('status RPC unsupported'));

    await expect(
      postDeviceStatus(
        {
          sendLightingConfig: vi.fn(),
          sendThreadsLighting: vi.fn(),
          getDeviceStatus,
        },
        'codex-micro',
        true,
      ),
    ).resolves.toBeUndefined();
    expect(getDeviceStatus).toHaveBeenCalledOnce();
  });

  it('rejects a status probe that fails without an unsupported-RPC signal', async () => {
    const getDeviceStatus = vi.fn().mockRejectedValue(new Error('device disconnected'));

    await expect(
      postDeviceStatus(
        {
          sendLightingConfig: vi.fn(),
          sendThreadsLighting: vi.fn(),
          getDeviceStatus,
        },
        'codex-micro',
        true,
      ),
    ).rejects.toThrow('device disconnected');
  });

  it('rejects a resolved { ok: false } status envelope as a failed round trip', async () => {
    const getDeviceStatus = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: 'timeout' },
    });

    await expect(
      postDeviceStatus(
        {
          sendLightingConfig: vi.fn(),
          sendThreadsLighting: vi.fn(),
          getDeviceStatus,
        },
        'codex-micro',
        true,
      ),
    ).rejects.toThrow('timeout');
  });
});
