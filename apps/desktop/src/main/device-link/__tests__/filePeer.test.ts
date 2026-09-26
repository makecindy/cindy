import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  settings: { remoteControlEnabled: true, revokedControllers: [] as string[] },
  current: true,
  resolve: vi.fn(),
  iceConfig: vi.fn(async () => []),
  ready: vi.fn(async () => {}),
  replyDelay: 0,
  commandReply: vi.fn((_action: string) => 'v=0'),
  now: undefined as number | undefined,
  receiving: undefined as undefined | { sink: string; reply: () => void },
}));
vi.mock('@cindy/device-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/device-link')>();
  return {
    ...actual,
    createPeerTransferCooldown: () =>
      actual.createPeerTransferCooldown(() => mock.now ?? Date.now()),
  };
});
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => mock.handlers.set(key, fn) },
  app: { on: vi.fn(), getPath: () => os.tmpdir() },
}));
vi.mock('../mediaFetch', () => ({ resolveAuthorizedMedia: mock.resolve }));
vi.mock('../settings-store', () => ({ readDeviceLinkSettings: () => mock.settings }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => mock.current,
}));
vi.mock('../../remote-desktop/iceConfig', () => ({ loadDesktopIceServers: mock.iceConfig }));
vi.mock('../../remote-desktop/captureWindow', () => ({
  DesktopCaptureWindow: class {
    contents: any = null;
    async start() {
      await mock.ready();
      this.contents = {
        isDestroyed: () => false,
        send: (_channel: string, id: string, c: { action: string; sink?: string }) => {
          if (c.action !== 'close') {
            const reply = () =>
              mock.handlers.get('file-peer:host:reply')!({}, id, true, mock.commandReply(c.action));
            if (c.action === 'receive') {
              mock.receiving = { sink: c.sink!, reply };
              return;
            }
            if (mock.replyDelay) setTimeout(reply, mock.replyDelay);
            else reply();
          }
        },
      };
    }
    dispose() {
      this.contents = null;
    }
    assertSender() {}
    registered() {}
  },
}));
import {
  registerFilePeerIpc,
  requestFilePeer,
  stopFilePeers,
  tryPeerInvoke,
  tryPeerFile,
} from '../filePeer';

describe('authorized file peer source', () => {
  it.each([0, 15_001])(
    'preserves a file receive after concurrent RPC failure (reply delay %i)',
    async (delay) => {
      const peer = 'concurrent-read-peer';
      const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => {
        const action = (args[0] as { action: string }).action;
        return {
          ok: true,
          result:
            action === 'caps'
              ? { version: 1, streaming: true }
              : action === 'open'
                ? {
                    ticket: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                    size: 5,
                    mimeType: 'text/plain',
                  }
                : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
        };
      });
      const transfer = tryPeerFile(peer, 'xdt-file://test', invoke);
      await vi.waitFor(() => expect(mock.receiving).toBeDefined());
      mock.replyDelay = delay;
      expect(
        await tryPeerInvoke(peer, 'file-browser:remote-op', [{ op: 'readFile' }], invoke),
      ).toBeNull();
      await mock.handlers.get('file-peer:host:write')!({}, mock.receiving!.sink, 0, 'aGVsbG8=');
      mock.receiving!.reply();
      const result = await transfer;
      expect(result?.size).toBe(5);
      await result?.dispose();
    },
    20_000,
  );
  it('warms reads, preserves application errors, and retries transport failure only after cooldown', async () => {
    const peer = 'warm-recovery-peer';
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => {
      const action = (args[0] as { action: string }).action;
      return {
        ok: true,
        result:
          action === 'caps'
            ? { version: 1, streaming: true }
            : {
                connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                sdp: 'v=0',
              },
      };
    });
    const read = () => tryPeerInvoke(peer, 'file-browser:remote-op', [{ op: 'readFile' }], invoke);
    mock.commandReply.mockImplementation((action) =>
      action === 'invoke' ? JSON.stringify({ ok: false, error: 'FILE_NOT_FOUND' }) : 'v=0',
    );
    expect(await read()).toBeNull();
    await vi.waitFor(() => expect(mock.commandReply).toHaveBeenCalledWith('stats'));
    expect(await read()).toEqual({ ok: false, error: 'FILE_NOT_FOUND' });
    expect(invoke.mock.calls.filter((call) => (call[2][0] as any).action === 'caps')).toHaveLength(
      1,
    );
    // Broken renderer reply models transport failure, not a remote application error.
    mock.commandReply.mockReturnValue('broken-json');
    expect(await read()).toBeNull();
    for (let i = 0; i < 3; i++) expect(await read()).toBeNull();
    expect(invoke.mock.calls.filter((call) => (call[2][0] as any).action === 'caps')).toHaveLength(
      1,
    );
    mock.now = Date.now() + 30_001;
    try {
      mock.commandReply
        .mockClear()
        .mockImplementation((action) =>
          action === 'invoke' ? JSON.stringify({ ok: true, result: 'recovered' }) : 'v=0',
        );
      expect(await read()).toBeNull();
      await vi.waitFor(() => expect(mock.commandReply).toHaveBeenCalledWith('stats'));
      expect(await read()).toEqual({ ok: true, result: 'recovered' });
      expect(
        invoke.mock.calls.filter((call) => (call[2][0] as any).action === 'caps'),
      ).toHaveLength(2);
    } finally {
      mock.now = undefined;
    }
  });
  it('returns cold reads immediately while a single capability request remains pending', async () => {
    let resolve!: (value: { ok: boolean }) => void;
    const invoke = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((done) => {
          resolve = done;
        }),
    );
    expect(
      await tryPeerInvoke('cold-peer', 'file-browser:remote-op', [{ op: 'listDir' }], invoke),
    ).toBeNull();
    expect(
      await tryPeerInvoke('cold-peer', 'file-browser:remote-op', [{ op: 'readFile' }], invoke),
    ).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ ok: false });
    await new Promise((done) => setImmediate(done));
    expect(
      await tryPeerInvoke('cold-peer', 'file-browser:remote-op', [{ op: 'listDir' }], invoke),
    ).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('reuses host dispatch for peer reads and rechecks revocation without closing another peer', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: 'preview' }));
    const { connection } = (await requestFilePeer(
      'a',
      { action: 'offer', sdp: 'v=0' },
      invoke,
    )) as { connection: string };
    const read = (channel: string, args: unknown[]) =>
      mock.handlers.get('file-peer:host:invoke')!(
        {},
        connection,
        JSON.stringify({ channel, args }),
      );
    expect(JSON.parse(await read('file-browser:remote-op', [{ op: 'readFile' }]))).toEqual({
      ok: true,
      result: 'preview',
    });
    await expect(read('maker:send', [{}])).rejects.toThrow('DENIED');
    mock.settings.revokedControllers.push('a');
    await expect(read('file-browser:remote-op', [{ op: 'readFile' }])).rejects.toThrow('REVOKED');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  let directory: string, file: string;
  beforeEach(async () => {
    mock.current = true;
    mock.receiving = undefined;
    mock.now = undefined;
    mock.iceConfig.mockReset().mockResolvedValue([]);
    mock.ready.mockReset().mockResolvedValue();
    mock.replyDelay = 0;
    mock.commandReply.mockReset().mockReturnValue('v=0');
    mock.settings = { remoteControlEnabled: true, revokedControllers: [] };
    mock.handlers.clear();
    registerFilePeerIpc();
    directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-file-peer-test-'));
    file = path.join(directory, 'input');
    await writeFile(file, 'hello');
    mock.resolve
      .mockReset()
      .mockResolvedValue({ absPath: file, mimeType: 'text/plain', maxBytes: 100 });
  });
  afterEach(async () => {
    stopFilePeers();
    await rm(directory, { recursive: true, force: true });
  });
  async function connect(peer = 'device-a') {
    return (await requestFilePeer(peer, { action: 'offer', sdp: 'v=0' })) as { connection: string };
  }
  async function open(connection: string, peer = 'device-a') {
    return (await requestFilePeer(peer, {
      action: 'open',
      connection,
      url: 'xdt-file://local/?path=/test',
    })) as { ticket: string; size: number };
  }
  const read = (connection: string, ticket: string, offset: number) =>
    mock.handlers.get('file-peer:host:read')!({}, connection, ticket, offset);
  it('fits slow config, cold host and command reply within the 30s offer RPC', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mock.iceConfig.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 8_000)),
      );
      mock.ready.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 10_000)),
      );
      mock.replyDelay = 14_000;
      let settled = false;
      const result = connect().then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(23_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await result).connection).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not let one stopped config request close another peer', async () => {
    let finish!: (value: never[]) => void;
    mock.iceConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const slow = connect('device-a');
    const rejected = expect(slow).rejects.toThrow('CLOSED');
    const healthy = await connect('device-b');
    stopFilePeers('device-a');
    finish([]);
    await rejected;
    const source = await open(healthy.connection, 'device-b');
    expect(await read(healthy.connection, source.ticket, 0)).toBe(
      Buffer.from('hello').toString('base64'),
    );
  });
  it('reads bounded bytes and consumes the ticket only after verified EOF', async () => {
    const { connection } = await connect(),
      { ticket, size } = await open(connection);
    expect(size).toBe(5);
    expect(mock.resolve).toHaveBeenCalledWith(expect.anything(), 2147483648);
    expect(await read(connection, ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
    expect(await read(connection, ticket, 5)).toBe('');
    await expect(read(connection, ticket, 5)).rejects.toThrow();
    expect((await open(connection)).ticket).not.toBe(ticket);
  });
  it('accepts a sparse 2 GiB source and rejects one byte above the transport limit', async () => {
    const limit = 2 * 1024 * 1024 * 1024;
    await truncate(file, limit);
    mock.resolve.mockResolvedValue({
      absPath: file,
      mimeType: 'application/octet-stream',
      maxBytes: limit,
    });
    expect(await requestFilePeer('device-a', { action: 'caps' })).toEqual({
      version: 1,
      maxBytes: limit,
      streaming: true,
      attachments: true,
    });
    const first = await connect();
    expect((await open(first.connection)).size).toBe(limit);
    stopFilePeers();
    await truncate(file, limit + 1);
    const second = await connect();
    await expect(open(second.connection)).rejects.toThrow('SIZE');
  });
  it('rejects another peer using a connection handle', async () => {
    const { connection } = await connect();
    await expect(open(connection, 'device-b')).rejects.toThrow('DENIED');
  });
  it('reserves open before filesystem awaits', async () => {
    const { connection } = await connect();
    let finish!: (value: unknown) => void;
    mock.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = open(connection);
    await expect(open(connection)).rejects.toThrow('BUSY');
    finish({ absPath: file, maxBytes: 100 });
    await first;
  });
  it('rechecks the requested limit on the opened file descriptor', async () => {
    const { connection } = await connect();
    mock.resolve.mockResolvedValueOnce({ absPath: file, maxBytes: 4 });
    await expect(open(connection)).rejects.toThrow('SIZE');
  });
  it('rejects changed files and subsequent reads on the stopped connection', async () => {
    const { connection } = await connect(),
      { ticket } = await open(connection);
    await writeFile(file, 'changed');
    await expect(read(connection, ticket, 0)).rejects.toThrow('CHANGED');
    await expect(read(connection, ticket, 0)).rejects.toThrow();
  });
  it('rejects revoked or old-owner chunks without affecting a second peer', async () => {
    const a = await connect(),
      b = await connect('device-b');
    const fa = await open(a.connection),
      fb = await open(b.connection, 'device-b');
    mock.settings.revokedControllers.push('device-a');
    await expect(read(a.connection, fa.ticket, 0)).rejects.toThrow('REVOKED');
    expect(await read(b.connection, fb.ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
    mock.current = false;
    await expect(read(b.connection, fb.ticket, 5)).rejects.toThrow('CLOSED');
  });
  it('keeps a stalled transfer alive past 30 seconds, renews on progress and closes after 60 idle seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { connection } = await connect();
      const { ticket } = await open(connection);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await read(connection, ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await read(connection, ticket, 5)).toBe('');
      const next = await open(connection);
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(read(connection, next.ticket, 0)).rejects.toThrow('FILE_PEER_BLOCK');
    } finally {
      vi.useRealTimers();
    }
  });
});
