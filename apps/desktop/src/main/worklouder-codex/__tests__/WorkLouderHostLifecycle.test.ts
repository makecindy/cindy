import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkLouderCodexLightingFrame,
  type WorkLouderCodexHostRequest,
} from '../protocol.js';

// Exercise the actual utility-process message loop, replacing only the native
// SDK. No hardware, user profile or filesystem keymap is touched by these tests.
describe('Work Louder host lifecycle', () => {
  let receive: (event: { data: WorkLouderCodexHostRequest }) => void;
  const postMessage = vi.fn();
  const connect = vi.fn();
  const disconnect = vi.fn();
  const lighting = vi.fn();
  const threads = vi.fn();
  const status = vi.fn();
  const writeFile = vi.fn();
  const readFile = vi.fn();
  const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');

  async function send(data: WorkLouderCodexHostRequest) {
    receive({ data });
    // Drain the host's serialized asynchronous RPC queue without advancing retry timers.
    for (let i = 0; i < 60; i++) await Promise.resolve();
  }

  const frame = createWorkLouderCodexLightingFrame([
    { sessionId: 'task', phase: 'running', attention: false, compactDetail: '' },
  ]);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.resetAllMocks();
    connect.mockResolvedValue(true);
    disconnect.mockResolvedValue(undefined);
    lighting.mockResolvedValue({ ok: true });
    threads.mockResolvedValue({ ok: true });
    status.mockResolvedValue({ ok: true, value: { firmwareVersion: 'test' } });
    const sdk = {
      DeviceType: { CodexMicro: 'codex', CreatorMicroV2: 'creator' },
      WLDeviceDiscovery: class {
        findWLDevices(filter: string[]) {
          return filter[0] === 'creator' ? [{ isUsbConnection: true }] : [];
        }
      },
      WLDeviceCommImpl: class {
        connect = connect;
        disconnect = disconnect;
      },
      RPCApiOAI: class {
        sendLightingConfig = lighting;
        sendThreadsLighting = threads;
        getDeviceStatus = status;
        api = { readFile, writeFile };
        onHidReceived() {
          return () => undefined;
        }
      },
    };
    vi.doMock('node:module', () => ({ createRequire: () => () => sdk }));
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: {
        postMessage,
        on: (_event: string, listener: typeof receive) => {
          receive = listener;
        },
      },
    });
    await import('../workLouderCodexHostProcess.js');
    await send({ kind: 'init', sdkEntry: 'test-sdk', creatorKeymapPolicy: 'preserve' });
  });

  afterEach(async () => {
    await send({ kind: 'stop' });
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort);
    else Reflect.deleteProperty(process, 'parentPort');
    vi.doUnmock('node:module');
    vi.useRealTimers();
    vi.resetModules();
  });

  it('sends running and completed status lighting in preserve mode without any keymap IO', async () => {
    await send({ kind: 'listen' });
    await send({ kind: 'apply', frame });
    expect(lighting).toHaveBeenLastCalledWith({ ambient: frame.ambient, keys: frame.keys });
    expect(threads).toHaveBeenLastCalledWith(frame.threads);
    const completed = createWorkLouderCodexLightingFrame([
      { sessionId: 'task', phase: 'completed', attention: true, compactDetail: '' },
    ]);
    await send({ kind: 'apply', frame: completed });
    expect(threads).toHaveBeenLastCalledWith(completed.threads);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('delivers all six independent statuses through the real host loop across repeated turns', async () => {
    await send({ kind: 'listen' });
    const ids = ['idle', 'running', 'failed', 'done', 'waiting'];
    const states = createWorkLouderCodexLightingFrame(
      [
        { sessionId: 'running', phase: 'running', attention: false, compactDetail: '' },
        { sessionId: 'failed', phase: 'error', attention: true, compactDetail: '' },
        { sessionId: 'done', phase: 'completed', attention: true, compactDetail: '' },
        { sessionId: 'waiting', phase: 'needs-interaction', attention: true, compactDetail: '' },
      ],
      ids,
    );
    for (let turn = 0; turn < 3; turn++) {
      await send({ kind: 'apply', frame: states });
      expect(threads.mock.lastCall?.[0].map((thread: { color: number }) => thread.color)).toEqual([
        0xffffff, 0x4c6fff, 0xff453a, 0x35c759, 0xffa000, 0,
      ]);
      await send({ kind: 'apply', frame: createWorkLouderCodexLightingFrame([], ids) });
      expect(threads.mock.lastCall?.[0].map((thread: { color: number }) => thread.color)).toEqual([
        0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0,
      ]);
    }
    expect(connect).toHaveBeenCalledOnce();
  });

  it('replaces an explicitly closed handle and retries the same lighting frame', async () => {
    lighting.mockResolvedValueOnce({ ok: false, error: { message: 'device has been closed' } });
    await send({ kind: 'apply', frame });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(threads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(threads).toHaveBeenLastCalledWith(frame.threads);
  });

  it('does not let optional Creator idle status block working lighting RPCs', async () => {
    status.mockResolvedValue({ ok: false, error: { message: 'hid_read_timeout' } });
    await send({ kind: 'apply', frame });
    expect(threads).toHaveBeenCalledWith(frame.threads);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('also recovers when the thread lighting RPC rejects a closed handle', async () => {
    threads.mockResolvedValueOnce({ ok: false, error: { message: 'device has been closed' } });
    await send({ kind: 'apply', frame });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalledWith({ kind: 'state', status: 'connected' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith({ kind: 'state', status: 'connected' });
  });

  it('retries an exclusive-access failure even before any keymap binding exists', async () => {
    connect.mockRejectedValueOnce(new Error('IOHIDDeviceOpen: 0xE00002C5 exclusive access'));
    await send({ kind: 'listen' });
    expect(postMessage).toHaveBeenCalledWith({
      kind: 'state',
      status: 'error',
      reason: 'device-in-use',
    });
    expect(disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await send({ kind: 'apply', frame });
    expect(threads).toHaveBeenCalledWith(frame.threads);
  });

  it('stops permission retries rather than reporting a successful light update', async () => {
    if (process.platform !== 'darwin') return;
    lighting.mockResolvedValue({
      ok: false,
      error: { message: '0xE00002E2 (iokit/common) not permitted' },
    });
    await send({ kind: 'apply', frame });
    expect(postMessage).toHaveBeenCalledWith({
      kind: 'state',
      status: 'error',
      reason: 'permission-required',
    });
    await send({ kind: 'probe' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lighting).toHaveBeenCalledOnce();
    expect(threads).not.toHaveBeenCalled();
  });
});
