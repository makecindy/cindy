import { describe, it, expect, vi } from 'vitest';
import { RemoteViewerConnection } from '../connection';
import {
  ClipboardSync,
  remoteDesktopVideoSettingsWire,
  type RemoteDesktopRequest,
} from '@cindy/device-link';
import { DEFAULT_VIEWER_PREFERENCES } from '../../../shared/remoteDesktopViewer';

function fixture() {
  let owner = 'account-a:1';
  const request = vi.fn(
    async (_target: string, request: RemoteDesktopRequest, check: () => void): Promise<unknown> => {
      check();
      return request.op === 'start'
        ? { lease: 'lease-a', controlling: false, display: { id: 'screen' } }
        : { ok: true };
    },
  );
  const readClipboard = vi.fn(() => 'local text'),
    writeClipboard = vi.fn();
  const connection = new RemoteViewerConnection({
    owner: () => owner,
    request,
    readClipboard,
    writeClipboard,
  });
  connection.bind({ deviceId: 'computer-a', name: 'Computer' });
  connection.setActive(true);
  return {
    connection,
    request,
    readClipboard,
    writeClipboard,
    owner: (value: string) => {
      owner = value;
    },
  };
}
describe('standalone remote viewer authority', () => {
  it('stops counters on blur and orders remote disable after an in-flight enable', async () => {
    let focused = true;
    let finish!: () => void;
    const stop = vi.fn();
    const tick = vi.spyOn(ClipboardSync.prototype, 'tick').mockResolvedValue(undefined);
    const request = vi.fn(async (_target, message, check) => {
      check();
      if (message.op === 'capabilities') return { clipboardSync: true };
      if (message.op === 'start') return { lease: 'lease', controlling: false };
      if (message.op === 'control') return { controlling: true };
      if (message.op === 'clipboardSync' && message.enabled && !finish)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { enabled: message.enabled };
    });
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request,
      focused: () => focused,
      readClipboard: () => '',
      writeClipboard: () => {},
      preferences: () => ({ ...DEFAULT_VIEWER_PREFERENCES, clipboardSync: true }),
      clipboard: { stop, version: async () => '1', read: async () => '', write: async () => '1' },
    });
    try {
      connection.bind({ deviceId: 'target', name: 'Target' });
      connection.setActive(true);
      const generation = connection.generation;
      await connection.request(generation, { op: 'capabilities' });
      await connection.request(generation, { op: 'start', displayId: '1' });
      await connection.request(generation, { op: 'control', lease: 'lease', enabled: true });
      const pending = connection.safety(generation);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      focused = false;
      const paused = connection.focusChanged();
      expect(stop).toHaveBeenCalledOnce();
      finish();
      await Promise.all([pending, paused]);
      expect(
        request.mock.calls.filter(([, m]) => m.op === 'clipboardSync').map(([, m]) => m.enabled),
      ).toEqual([true, false]);
      expect(tick).not.toHaveBeenCalled();
      focused = true;
      await connection.safety(generation);
      expect(tick).toHaveBeenCalledOnce();
      connection.deactivate();
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      tick.mockRestore();
    }
  });
  it.each(['target', 'owner'])(
    'does not block a new %s behind the old scope cleanup',
    async (changed) => {
      const current = fixture();
      let resolve!: (value: unknown) => void;
      let starts = 0;
      current.request.mockImplementation(async (_target, request, check) => {
        check();
        if (request.op === 'start' && ++starts === 1)
          return new Promise((done) => {
            resolve = done;
          });
        return request.op === 'start'
          ? { lease: 'new-lease', display: { id: 'screen' }, controlling: false }
          : {};
      });
      const old = current.connection.request(current.connection.generation, {
        op: 'start',
        displayId: 'screen',
      });
      if (changed === 'owner') current.owner('account-b:2');
      current.connection.bind({
        deviceId: changed === 'target' ? 'computer-b' : 'computer-a',
        name: 'New scope',
      });
      current.connection.setActive(true);
      const latest = await current.connection.request(current.connection.generation, {
        op: 'start',
        displayId: 'screen',
      });
      expect(latest).toMatchObject({ ok: true, result: { lease: 'new-lease' } });
      resolve({ lease: 'old-lease', display: { id: 'screen' }, controlling: false });
      expect(await old).toEqual({ ok: false, code: 'DESKTOP_STOPPED' });
      expect(current.connection.snapshot().active).toBe(true);
      const stops = current.request.mock.calls.filter(([, request]) => request.op === 'stop');
      if (changed === 'owner') expect(stops).toHaveLength(0);
      else
        expect(stops.map(([target, request]) => ({ target, request }))).toEqual([
          { target: 'computer-a', request: { op: 'stop', lease: 'old-lease' } },
        ]);
    },
  );
  it('view-only cannot read or write the local clipboard even when the renderer asks', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    for (const action of ['copy', 'paste'])
      expect(await f.connection.clipboard(f.connection.generation, action)).toEqual({
        ok: false,
        code: 'DESKTOP_VIEW_ONLY',
      });
    expect(f.readClipboard).not.toHaveBeenCalled();
    expect(f.writeClipboard).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('a control release discards a pending copy and a stale heartbeat cannot restore clipboard access', async () => {
    const f = fixture(),
      generation = f.connection.generation;
    await f.connection.request(generation, { op: 'start', displayId: 'screen' });
    f.request.mockResolvedValueOnce({ controlling: true });
    await f.connection.request(generation, { op: 'control', lease: 'lease-a', enabled: true });
    let copied!: (value: unknown) => void, heartbeat!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          copied = resolve;
        }),
    );
    const copy = f.connection.clipboard(generation, 'copy');
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          heartbeat = resolve;
        }),
    );
    const renewal = f.connection.request(generation, { op: 'heartbeat', lease: 'lease-a' });
    f.request.mockResolvedValueOnce({ controlling: false });
    await f.connection.request(generation, { op: 'control', lease: 'lease-a', enabled: false });
    heartbeat({ controlling: true });
    await renewal;
    copied({ text: 'stale remote text' });
    expect(await copy).toEqual({ ok: false, code: 'DESKTOP_VIEW_ONLY' });
    expect(f.writeClipboard).not.toHaveBeenCalled();
    expect(await f.connection.clipboard(generation, 'paste')).toEqual({
      ok: false,
      code: 'DESKTOP_VIEW_ONLY',
    });
    expect(f.readClipboard).not.toHaveBeenCalled();
  });
  it('keeps the legacy bitrate on forwarded offers so older hosts accept video settings', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    const generation = f.connection.generation;
    f.connection.beginMedia(generation, '1');
    f.request.mockImplementationOnce(async () => ({ sdp: 'answer' }));
    await f.connection.request(
      generation,
      {
        op: 'offer',
        lease: 'lease-a',
        sdp: 'offer',
        settings: remoteDesktopVideoSettingsWire({ fps: 60, quality: 'hd', audio: false }),
      },
      '1',
    );
    expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({
      op: 'offer',
      settings: { fps: 60, quality: 'hd', audio: false, bitrate: 20_000_000 },
    });
  });
  it('invalidates queued signaling after a newer media attempt without closing the lease', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    const generation = f.connection.generation;
    f.connection.beginMedia(generation, '1');
    let beforeSend!: () => void;
    f.request.mockImplementationOnce(async (_peer, _body, check) => {
      beforeSend = check;
      return { sdp: 'answer' };
    });
    await f.connection.request(generation, { op: 'offer', lease: 'lease-a', sdp: 'offer' }, '1');
    f.connection.beginMedia(generation, '2');
    expect(() => beforeSend()).toThrow('DESKTOP_VIDEO_STOPPED');
    expect(f.connection.snapshot().active).toBe(true);
    const count = f.request.mock.calls.length;
    expect(
      await f.connection.request(generation, { op: 'offer', lease: 'lease-a', sdp: 'old' }, '1'),
    ).toEqual({ ok: false, code: 'DESKTOP_VIDEO_STOPPED' });
    expect(f.request).toHaveBeenCalledTimes(count);
  });
  it('releases only its lease while another desktop link remains usable', async () => {
    const { connection, request } = fixture();
    await connection.request(connection.generation, { op: 'start', displayId: 'screen' });
    connection.setActive(false);
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'computer-a',
      { op: 'stop', lease: 'lease-a' },
    ]);
    expect(
      (
        await connection.request(connection.generation, {
          op: 'input',
          lease: 'lease-a',
          sequence: 1,
          events: [{ kind: 'release' }],
        })
      ).ok,
    ).toBe(false);
    expect(connection.snapshot().resume).toBe(true);
  });
  it('retires a late successful start after the viewer closes', async () => {
    const { connection, request } = fixture();
    let finish!: (result: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = connection.request(connection.generation, { op: 'start', displayId: 'screen' });
    connection.setActive(false);
    finish({ lease: 'late-lease' });
    expect(await pending).toEqual({ ok: false, code: 'DESKTOP_STOPPED' });
    expect(request.mock.calls.at(-1)?.[1]).toEqual({ op: 'stop', lease: 'late-lease' });
  });
  it('cannot send a stale queued input or cleanup through a new account', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    const generation = f.connection.generation;
    let check!: () => void;
    f.request.mockImplementationOnce(async (_peer, _body, preSend) => {
      check = preSend;
      return null;
    });
    await f.connection.request(generation, { op: 'frame', lease: 'lease-a' });
    f.owner('account-b:2');
    expect(() => check()).toThrow('DESKTOP_STOPPED');
    const count = f.request.mock.calls.length;
    f.connection.deactivate();
    expect(f.request).toHaveBeenCalledTimes(count);
  });
  it('rejects other leases, password operations and arbitrary clipboard access', async () => {
    const { connection, request } = fixture();
    for (const message of [
      { op: 'input', lease: 'someone-else', sequence: 1, events: [] },
      { op: 'credential', version: 1, kind: 'prepare' },
      { op: 'clipboard', lease: 'someone-else', action: 'copy' },
    ])
      expect((await connection.request(connection.generation, message)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps native clipboard text out of the renderer and never replays uncertain pastes', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    f.request.mockResolvedValueOnce({ controlling: true });
    await f.connection.request(f.connection.generation, {
      op: 'control',
      lease: 'lease-a',
      enabled: true,
    });
    f.request.mockResolvedValueOnce({ text: 'remote text' });
    expect(await f.connection.clipboard(f.connection.generation, 'copy')).toEqual({
      ok: true,
      result: null,
    });
    expect(f.writeClipboard).toHaveBeenCalledWith('remote text');
    f.request.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
    expect(await f.connection.clipboard(f.connection.generation, 'paste')).toEqual({
      ok: false,
      code: 'INVOKE_TIMEOUT',
    });
    expect(
      f.request.mock.calls.filter(([, r]) => r.op === 'clipboard' && r.action === 'paste'),
    ).toHaveLength(1);
  });
  it('tells an empty text-only clipboard apart from an oversized one', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    f.request.mockResolvedValueOnce({ controlling: true });
    await f.connection.request(f.connection.generation, {
      op: 'control',
      lease: 'lease-a',
      enabled: true,
    });
    const clipboard = (action: 'copy' | 'paste') =>
      f.connection.clipboard(f.connection.generation, action);
    f.request.mockResolvedValueOnce({ text: '' });
    expect(await clipboard('copy')).toEqual({ ok: false, code: 'CLIPBOARD_EMPTY' });
    f.request.mockResolvedValueOnce({ text: 'x'.repeat(16_385) });
    expect(await clipboard('copy')).toEqual({ ok: false, code: 'CLIPBOARD_TOO_LONG' });
    f.readClipboard.mockReturnValueOnce('');
    expect(await clipboard('paste')).toEqual({ ok: false, code: 'CLIPBOARD_EMPTY' });
    expect(f.writeClipboard).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  'explicit close honors lock-on-exit capability %s and cancels authentication before stopping',
  async (supported) => {
    const dispose = vi.fn();
    let finish!: () => void;
    const request = vi.fn(
      async (
        _target: string,
        message: RemoteDesktopRequest,
        check: () => void,
      ): Promise<unknown> => {
        check();
        if (message.op === 'capabilities') return { platform: 'darwin', lockOnExit: supported };
        if (message.op === 'start') return { lease: 'lease', controlling: false };
        if (message.op === 'stop') {
          expect(dispose).toHaveBeenCalledOnce();
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return {};
      },
    );
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request,
      readClipboard: () => '',
      writeClipboard: () => {},
      preferences: () => ({
        audio: true,
        privacyScreen: false,
        hostMute: false,
        clipboardSync: false,
        lockOnExit: true,
      }),
      credentials: { dispose, run: vi.fn() },
    });
    connection.bind({ deviceId: 'target', name: 'Target' });
    connection.setActive(true);
    dispose.mockClear();
    const generation = connection.generation;
    await connection.request(generation, { op: 'capabilities' });
    await connection.request(generation, { op: 'start', displayId: 'screen' });
    const closed = connection.close(generation);
    expect(closed).toBeUndefined();
    expect(connection.active).toBe(false);
    expect(() => connection.check(generation)).toThrow('DESKTOP_STOPPED');
    expect(dispose).toHaveBeenCalledOnce();
    expect(request.mock.calls.at(-1)?.[1]).toEqual({
      op: 'stop',
      lease: 'lease',
      ...(supported ? { lockScreen: true } : {}),
    });
    finish();
    await closed;
  },
);

it('keeps explicit exit locking on a start reply that arrives after close and rebind', async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn(async (_device, message, check) => {
    check();
    if (message.op === 'capabilities') return { lockOnExit: true };
    if (message.op === 'start')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {};
  });
  const connection = new RemoteViewerConnection({
    owner: () => 'owner',
    request,
    readClipboard: () => '',
    writeClipboard: () => {},
    preferences: () => ({ ...DEFAULT_VIEWER_PREFERENCES, lockOnExit: true }),
  });
  connection.bind({ deviceId: 'old', name: 'Old' });
  connection.setActive(true);
  const generation = connection.generation;
  await connection.request(generation, { op: 'capabilities' });
  const pending = connection.request(generation, { op: 'start', displayId: 'screen' });
  connection.close(generation);
  connection.bind({ deviceId: 'new', name: 'New' });
  connection.setActive(true);
  finish({ lease: 'late-lease' });
  expect(await pending).toEqual({ ok: false, code: 'DESKTOP_STOPPED' });
  expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
    'old',
    { op: 'stop', lease: 'late-lease', lockScreen: true },
  ]);
  expect(connection.active).toBe(true);
});

it.each([false, true])(
  'returns the saved preference before a failed remote sync, enabled=%s',
  async (enabled) => {
    let fail!: (error: Error) => void;
    const sync = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const request = vi.fn(async (_target, message, check) => {
      check();
      if (message.op === 'heartbeat') return sync;
      return message.op === 'start' ? { lease: 'lease' } : {};
    });
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request,
      readClipboard: () => '',
      writeClipboard: () => {},
      preferences: () => ({ ...DEFAULT_VIEWER_PREFERENCES, lockOnExit: !enabled }),
      savePreferences: async (_device, patch) => ({ ...DEFAULT_VIEWER_PREFERENCES, ...patch }),
    });
    connection.bind({ deviceId: 'target', name: 'Target' });
    connection.setActive(true);
    const generation = connection.generation;
    await connection.request(generation, { op: 'start', displayId: 'screen' });
    await expect(
      connection.preferences(generation, { lockOnExit: enabled }),
    ).resolves.toMatchObject({ lockOnExit: enabled });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ op: 'heartbeat', lockOnExit: enabled });
    fail(new Error('INVOKE_TIMEOUT'));
    await connection.request(generation, { op: 'heartbeat', lease: 'lease' });
    await expect(connection.preferences(generation)).resolves.toMatchObject({
      lockOnExit: enabled,
    });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ lockOnExit: enabled });
  },
);

it('sends the lock policy before a lease starts and immediately after changing the preference', async () => {
  const request = vi.fn(async (_target, message, check) => {
    check();
    return message.op === 'start' ? { lease: 'lease', controlling: false } : {};
  });
  const connection = new RemoteViewerConnection({
    owner: () => 'owner',
    request,
    readClipboard: () => '',
    writeClipboard: () => {},
    preferences: () => ({ ...DEFAULT_VIEWER_PREFERENCES, lockOnExit: true }),
    savePreferences: async (_device, patch) => ({ ...DEFAULT_VIEWER_PREFERENCES, ...patch }),
  });
  connection.bind({ deviceId: 'target', name: 'Target' });
  connection.setActive(true);
  const generation = connection.generation;
  await connection.request(generation, { op: 'start', displayId: 'screen' });
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ op: 'start', lockOnExit: true });
  await connection.preferences(generation, { lockOnExit: false });
  expect(request.mock.calls.at(-1)?.[1]).toEqual({
    op: 'heartbeat',
    lease: 'lease',
    lockOnExit: false,
  });
  await connection.request(generation, { op: 'heartbeat', lease: 'lease' });
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ lockOnExit: false });
});

it.each([false, true])(
  'keeps rich clipboard payloads in Main and cancels writes after control release %s',
  async (release) => {
    const content = JSON.stringify({ text: 'synthetic text', html: '<b>synthetic text</b>' });
    let finish!: (value: unknown) => void;
    const write = vi.fn(
      async (_json: string, _version: string | undefined, current: () => boolean) => {
        if (!current()) throw new Error('DESKTOP_STOPPED');
        return 'new-version';
      },
    );
    const request = vi.fn(
      async (
        _target: string,
        message: RemoteDesktopRequest,
        check: () => void,
      ): Promise<unknown> => {
        check();
        if (message.op === 'capabilities') return { clipboardContent: true };
        if (message.op === 'start') return { lease: 'lease', controlling: false };
        if (message.op === 'control') return { controlling: message.enabled };
        if (message.op === 'clipboardContent' && message.action === 'copy')
          return { id: 'transfer', length: content.length };
        if (message.op === 'clipboardContent' && message.action === 'read')
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {};
      },
    );
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request,
      readClipboard: () => '',
      writeClipboard: vi.fn(),
      clipboard: { version: async () => 'version', read: async () => content, write },
    });
    connection.bind({ deviceId: 'target', name: 'Target' });
    connection.setActive(true);
    const generation = connection.generation;
    await connection.request(generation, { op: 'capabilities' });
    await connection.request(generation, { op: 'start', displayId: 'screen' });
    await connection.request(generation, { op: 'control', lease: 'lease', enabled: true });
    const copy = connection.clipboard(generation, 'copy');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (release)
      await connection.request(generation, { op: 'control', lease: 'lease', enabled: false });
    finish({ data: content });
    expect(await copy).toEqual(
      release ? { ok: false, code: 'DESKTOP_VIEW_ONLY' } : { ok: true, result: null },
    );
    if (release) expect(write).not.toHaveBeenCalled();
    else expect(write).toHaveBeenCalledWith(content, undefined, expect.any(Function));
  },
);

describe('remembered viewer resolution', () => {
  function memoryFixture() {
    const stored = new Map<string, unknown>();
    const saveResolution = vi.fn(async (device: string, display: string, value: unknown) => {
      stored.set(`${device}/${display}`, value);
    });
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request: async (_target, message, check) => {
        check();
        return message.op === 'capabilities'
          ? { displays: [{ id: 'screen', width: 1280, height: 720 }] }
          : {};
      },
      readClipboard: () => '',
      writeClipboard: () => {},
      resolution: (device, display) =>
        (stored.get(`${device}/${display}`) as ReturnType<
          NonNullable<ConstructorParameters<typeof RemoteViewerConnection>[0]['resolution']>
        >) ?? null,
      saveResolution,
    });
    connection.bind({ deviceId: 'computer-a', name: 'Computer' });
    connection.setActive(true);
    return { connection, saveResolution, stored };
  }

  it('binds the device in Main and only accepts monitors the target reported', async () => {
    const { connection, saveResolution } = memoryFixture();
    const generation = connection.generation;
    // Before capabilities nothing is known about the target's monitors.
    await expect(connection.resolution(generation, 'screen')).rejects.toThrow('INVALID_REQUEST');
    await connection.request(generation, { op: 'capabilities' });
    const fit = { kind: 'fit', width: 1920, height: 960 };
    await expect(connection.resolution(generation, 'screen', fit)).resolves.toEqual(fit);
    expect(saveResolution).toHaveBeenCalledWith('computer-a', 'screen', fit);
    await expect(connection.resolution(generation, 'screen')).resolves.toEqual(fit);
    await expect(connection.resolution(generation, 'other', fit)).rejects.toThrow(
      'INVALID_REQUEST',
    );
    await connection.resolution(generation, 'screen', null);
    await expect(connection.resolution(generation, 'screen')).resolves.toBeNull();
  });

  it.each([
    { kind: 'fit', width: 4000, height: 2000 },
    { kind: 'mode', modeId: '', width: 1920, height: 1080 },
    { kind: 'mode', modeId: 'hd', width: 1.5, height: 1080 },
    { kind: 'other', width: 1920, height: 1080 },
    'fit',
  ])('rejects a malformed remembered value %#', async (value) => {
    const { connection, saveResolution } = memoryFixture();
    await connection.request(connection.generation, { op: 'capabilities' });
    await expect(connection.resolution(connection.generation, 'screen', value)).rejects.toThrow(
      'INVALID_REQUEST',
    );
    expect(saveResolution).not.toHaveBeenCalled();
  });

  it('rejects a retired generation', async () => {
    const { connection } = memoryFixture();
    const generation = connection.generation;
    await connection.request(generation, { op: 'capabilities' });
    connection.setActive(false);
    await expect(connection.resolution(generation, 'screen')).rejects.toThrow();
  });
});

describe('requests carried by the viewer window’s media data channel', () => {
  function channelFixture(channelRequests = true) {
    const relay = vi.fn(
      async (_target: string, message: RemoteDesktopRequest, check: () => void) => {
        check();
        if (message.op === 'capabilities') return { channelRequests, clipboardText: true };
        if (message.op === 'start') return { lease: 'lease', controlling: false };
        if (message.op === 'control') return { controlling: message.enabled };
        return { ok: true };
      },
    );
    const carried: { generation: number; id: string; request: RemoteDesktopRequest }[] = [];
    let accept = true;
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request: relay,
      readClipboard: () => 'local text',
      writeClipboard: () => {},
      channel: (generation, id, request) => {
        if (accept) carried.push({ generation, id, request });
        return accept;
      },
    });
    connection.bind({ deviceId: 'target', name: 'Target' });
    connection.setActive(true);
    const generation = connection.generation;
    const start = async () => {
      await connection.request(generation, { op: 'capabilities' });
      await connection.request(generation, { op: 'start', displayId: 'screen' });
    };
    const reply = (index: number, outcome: unknown) =>
      connection.channelReply(generation, carried[index].id, outcome);
    return {
      connection,
      relay,
      carried,
      generation,
      start,
      reply,
      refuse: () => {
        accept = false;
      },
    };
  }
  const relayed = (relay: ReturnType<typeof vi.fn>, op: string) =>
    relay.mock.calls.filter(([, message]) => (message as RemoteDesktopRequest).op === op).length;

  it('keeps Main’s control state and clipboard gate when control rides the channel', async () => {
    const f = channelFixture();
    await f.start();
    expect(f.carried).toEqual([]); // No lease yet: capabilities and start use the relay.
    const control = f.connection.request(f.generation, {
      op: 'control',
      lease: 'lease',
      enabled: true,
    });
    await vi.waitFor(() => expect(f.carried).toHaveLength(1));
    expect(f.carried[0].request).toEqual({ op: 'control', lease: 'lease', enabled: true });
    f.reply(0, { kind: 'result', value: { controlling: true } });
    await expect(control).resolves.toEqual({ ok: true, result: { controlling: true } });
    expect(relayed(f.relay, 'control')).toBe(0);
    // Main recorded the control result, so the native clipboard is usable.
    await expect(f.connection.clipboard(f.generation, 'paste')).resolves.toEqual({
      ok: true,
      result: null,
    });
  });

  it('uses the relay only for requests the window did not send', async () => {
    const f = channelFixture();
    await f.start();
    const unsent = f.connection.request(f.generation, { op: 'displayModes', lease: 'lease' });
    await vi.waitFor(() => expect(f.carried).toHaveLength(1));
    f.reply(0, { kind: 'relay' });
    await expect(unsent).resolves.toMatchObject({ ok: true });
    expect(relayed(f.relay, 'displayModes')).toBe(1);
    const failed = f.connection.request(f.generation, {
      op: 'control',
      lease: 'lease',
      enabled: true,
    });
    await vi.waitFor(() => expect(f.carried).toHaveLength(2));
    f.reply(1, { kind: 'error', code: 'DESKTOP_INPUT_BUSY' });
    await expect(failed).resolves.toEqual({ ok: false, code: 'DESKTOP_INPUT_BUSY' });
    expect(relayed(f.relay, 'control')).toBe(0);
    f.refuse();
    await f.connection.request(f.generation, { op: 'displayModes', lease: 'lease' });
    expect(relayed(f.relay, 'displayModes')).toBe(2);
  });

  it('never routes requests outside the channel list or to a host without support', async () => {
    const f = channelFixture();
    await f.start();
    await f.connection.request(f.generation, { op: 'heartbeat', lease: 'lease' });
    await f.connection.request(f.generation, {
      op: 'windowAction',
      lease: 'lease',
      action: 'list',
    });
    expect(f.carried).toEqual([]);
    const old = channelFixture(false);
    await old.start();
    await old.connection.request(old.generation, { op: 'displayModes', lease: 'lease' });
    expect(old.carried).toEqual([]);
  });

  it('settles carried requests as unknown when the viewer retires, and ignores late replies', async () => {
    const f = channelFixture();
    await f.start();
    const pending = f.connection.request(f.generation, { op: 'displayModes', lease: 'lease' });
    await vi.waitFor(() => expect(f.carried).toHaveLength(1));
    f.connection.setActive(false);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(relayed(f.relay, 'displayModes')).toBe(0);
    expect(() => f.reply(0, { kind: 'result', value: [] })).toThrow();
  });

  it('rejects malformed replies from the window', async () => {
    const f = channelFixture();
    await f.start();
    void f.connection.request(f.generation, { op: 'displayModes', lease: 'lease' });
    await vi.waitFor(() => expect(f.carried).toHaveLength(1));
    expect(() => f.reply(0, { kind: 'error', code: 'lowercase' })).toThrow('INVALID_REQUEST');
    expect(() => f.reply(0, { kind: 'other' })).toThrow('INVALID_REQUEST');
    expect(() => f.connection.channelReply(f.generation, 7, { kind: 'relay' })).toThrow(
      'INVALID_REQUEST',
    );
    f.reply(0, { kind: 'relay' });
  });
});

describe('control granted with the lease (autoControl)', () => {
  it('records a grant from start or a display change like a control reply', async () => {
    const relay = vi.fn(
      async (_target: string, message: RemoteDesktopRequest, check: () => void) => {
        check();
        if (message.op === 'capabilities') return { autoControl: true, clipboardText: true };
        if (message.op === 'start')
          return { lease: 'lease', controlling: message.control === true, display: { id: 's' } };
        if (message.op === 'viewerDisplay')
          return { lease: 'lease', controlling: message.control === true, display: { id: 'v' } };
        return { ok: true };
      },
    );
    const connection = new RemoteViewerConnection({
      owner: () => 'owner',
      request: relay,
      readClipboard: () => 'local text',
      writeClipboard: () => {},
    });
    connection.bind({ deviceId: 'target', name: 'Target' });
    connection.setActive(true);
    const generation = connection.generation;
    await connection.request(generation, { op: 'capabilities' });
    await connection.request(generation, { op: 'start', displayId: 's', control: true });
    await expect(connection.clipboard(generation, 'paste')).resolves.toEqual({
      ok: true,
      result: null,
    });
    await connection.request(generation, {
      op: 'viewerDisplay',
      lease: 'lease',
      width: 1280,
      height: 640,
      control: true,
    });
    await expect(connection.clipboard(generation, 'paste')).resolves.toMatchObject({ ok: true });
    // A start without the flag stays view only until control is confirmed.
    await connection.request(generation, { op: 'stop', lease: 'lease' });
    await connection.request(generation, { op: 'start', displayId: 's' });
    await expect(connection.clipboard(generation, 'paste')).resolves.toEqual({
      ok: false,
      code: 'DESKTOP_VIEW_ONLY',
    });
  });
});
