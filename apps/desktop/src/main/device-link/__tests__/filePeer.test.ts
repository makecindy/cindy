import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
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
  sent: [] as string[],
  commands: [] as Record<string, any>[],
  commandReply: vi.fn((_action: string): string | undefined => 'v=0'),
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
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
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
            mock.sent.push(c.action);
            mock.commands.push(c);
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
  tryUploadPeerAttachment,
} from '../filePeer';
import { createHash } from 'node:crypto';

describe('peer attachment upload preflight', () => {
  it('checks the peer before reading a large file and never connects to an old peer', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-peer-upload-'));
    try {
      const file = path.join(dir, 'movie.mov');
      await writeFile(file, '');
      await truncate(file, 3 * 1024 ** 3);
      const invoke = vi.fn(async () => ({
        ok: true,
        result: { version: 1, streaming: true, attachments: true },
      }));
      vi.mocked(createHash).mockClear();
      expect(await tryUploadPeerAttachment('old-large-peer', file, 'video/quicktime', invoke)).toBeNull();
      expect(invoke.mock.calls.map((call) => (call as unknown[])[2])).toEqual([[{ action: 'caps' }]]);
      expect(createHash).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
      const progress = vi.fn().mockImplementationOnce(() => {
        throw new Error('observer failed');
      });
      const transfer = tryPeerFile(peer, 'xdt-file://test', invoke, undefined, progress);
      await vi.waitFor(() => expect(mock.receiving).toBeDefined());
      expect(progress).toHaveBeenLastCalledWith(0, 5);
      mock.replyDelay = delay;
      expect(
        await tryPeerInvoke(peer, 'file-browser:remote-op', [{ op: 'readFile' }], invoke),
      ).toBeNull();
      await mock.handlers.get('file-peer:host:write')!({}, mock.receiving!.sink, 0, 'aGU=');
      // Partial writes must reach the UI before EOF, even when diagnostic RPCs fail.
      expect(progress).toHaveBeenLastCalledWith(2, 5);
      await mock.handlers.get('file-peer:host:write')!({}, mock.receiving!.sink, 2, 'bGxv');
      expect(progress).toHaveBeenLastCalledWith(5, 5);
      mock.receiving!.reply();
      const result = await transfer;
      expect(result?.size).toBe(5);
      await result?.dispose();
      expect(progress.mock.calls.map(([received]) => received)).toEqual([0, 2, 5]);
    },
    20_000,
  );
  it.each(['abort', 'owner'] as const)(
    'stops receive progress after %s invalidation',
    async (reason) => {
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
      const abort = new AbortController();
      const progress = vi.fn();
      const pending = tryPeerFile(
        `invalidated-${reason}`,
        'xdt-file://test',
        invoke,
        abort.signal,
        progress,
      );
      const rejected = expect(pending).rejects.toThrow('FILE_PEER_CANCELLED');
      await vi.waitFor(() => expect(mock.receiving).toBeDefined());
      const receive = mock.receiving!;
      await mock.handlers.get('file-peer:host:write')!({}, receive.sink, 0, 'aGU=');
      if (reason === 'abort') {
        abort.abort();
        await expect(
          mock.handlers.get('file-peer:host:write')!({}, receive.sink, 2, 'bGxv'),
        ).rejects.toThrow('FILE_PEER_BLOCK');
      } else {
        mock.current = false;
        await expect(
          mock.handlers.get('file-peer:host:write')!({}, receive.sink, 2, 'bGxv'),
        ).rejects.toThrow('FILE_PEER_CLOSED');
        receive.reply();
      }
      await rejected;
      expect(progress.mock.calls).toEqual([
        [0, 5],
        [2, 5],
      ]);
    },
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
    mock.sent.length = 0;
    mock.commands.length = 0;
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
      largeAttachments: true,
      streamAttachments: true,
    });
    const first = await connect();
    expect((await open(first.connection)).size).toBe(limit);
    stopFilePeers();
    await truncate(file, limit + 1);
    const second = await connect();
    await expect(open(second.connection)).rejects.toThrow('SIZE');
  });
  it('hands a streamed block body to the attachment write as raw bytes, never to other requests', async () => {
    const invoke = vi.fn(async (_channel: string, args: unknown[]) => ({ ok: true, args }));
    const { connection } = (await requestFilePeer(
      'device-a',
      { action: 'offer', sdp: 'v=0' },
      invoke as never,
    )) as { connection: string };
    const handle = mock.handlers.get('file-peer:host:invoke')!;
    const payload = (request: Record<string, unknown>) =>
      JSON.stringify({
        channel: 'device-link:file-peer',
        args: [{ action: 'attachment', connection, request }],
      });
    const body = new Uint8Array(Buffer.from('hi'));
    await handle({}, connection, payload({ op: 'write', ticket: 't', offset: 0 }), body);
    const data = (invoke.mock.calls[0][1][0] as { request: { data: unknown } }).request.data;
    expect(Buffer.isBuffer(data) && data.toString()).toBe('hi');
    for (const [text, bytes] of [
      [payload({ op: 'finish', ticket: 't' }), body],
      [payload({ op: 'write', ticket: 't', offset: 0, data: 'aGk=' }), body],
      [payload({ op: 'write', ticket: 't', offset: 0 }), new Uint8Array(1024 * 1024 + 1)],
      [payload({ op: 'write', ticket: 't', offset: 0 }), 'aGk='],
      [JSON.stringify({ channel: 'file-browser:remote-op', args: [{ op: 'readFile' }] }), body],
    ] as const)
      await expect(handle({}, connection, text, bytes)).rejects.toThrow('DENIED');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['stream-peer', true],
    ['old-attachment-peer', false],
  ])('uploads blocks to %s with the advertised write format', async (peer, stream) => {
    const source = path.join(directory, 'upload');
    await writeFile(source, Buffer.alloc(2.5 * 1024 * 1024, 7));
    const ticket = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => ({
      ok: true,
      result:
        (args[0] as { action: string }).action === 'caps'
          ? { version: 1, streaming: true, attachments: true, streamAttachments: stream }
          : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
    }));
    // Replies are synchronous, so the command being answered is the last one recorded.
    mock.commandReply.mockImplementation((action) =>
      action === 'invoke'
        ? JSON.stringify({
            ok: true,
            result:
              JSON.parse(mock.commands.at(-1)!.payload).args[0].request.op === 'begin'
                ? { ticket }
                : {},
          })
        : 'v=0',
    );
    const ref = await tryUploadPeerAttachment(peer, source, 'application/octet-stream', invoke);
    expect(ref).toContain(ticket);
    const writes = mock.commands
      .filter((c) => c.action === 'invoke')
      .map((c) => ({
        body: c.body as string | undefined,
        timeoutMs: c.timeoutMs as number | undefined,
        request: JSON.parse(c.payload).args[0].request,
      }))
      .filter((c) => c.request.op === 'write');
    expect(writes.map((c) => c.request.offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    for (const c of writes) {
      // Old receivers only understand the base64 field; streaming ones get the raw-byte body.
      expect(c.body !== undefined).toBe(stream);
      expect(c.request.data !== undefined).toBe(!stream);
      expect(c.timeoutMs).toBe(stream ? 45_000 : undefined);
    }
    expect(Buffer.from(writes[2].body ?? writes[2].request.data, 'base64')).toEqual(
      Buffer.alloc(0.5 * 1024 * 1024, 7),
    );
  });
  it('stops a cancelled upload mid-file, discards the staging and keeps the peer usable', async () => {
    const peer = 'cancel-upload-peer';
    const source = path.join(directory, 'upload');
    await writeFile(source, Buffer.alloc(5 * 1024 * 1024, 3));
    const ticket = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => ({
      ok: true,
      result:
        (args[0] as { action: string }).action === 'caps'
          ? { version: 1, streaming: true, attachments: true, streamAttachments: true }
          : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
    }));
    const abort = new AbortController();
    const ops = () =>
      mock.commands
        .filter((c) => c.action === 'invoke')
        .map((c) => JSON.parse(c.payload).args[0].request.op as string);
    mock.commandReply.mockImplementation((action) => {
      if (action !== 'invoke') return 'v=0';
      const op = JSON.parse(mock.commands.at(-1)!.payload).args[0].request.op;
      // The user cancels while the second block is on the wire.
      if (op === 'write' && ops().filter((o) => o === 'write').length === 2) abort.abort();
      return JSON.stringify({ ok: true, result: op === 'begin' ? { ticket } : {} });
    });
    await expect(
      tryUploadPeerAttachment(peer, source, undefined, invoke, undefined, abort.signal),
    ).rejects.toThrow('FILE_PEER_CANCELLED');
    // No further blocks after the cancel; the receiver is then told to drop what it staged
    // (the abandoned upload sends that after the caller has already returned).
    await vi.waitFor(() => expect(ops().at(-1)).toBe('cancel'));
    expect(ops().filter((o) => o === 'write').length).toBeLessThanOrEqual(4);
    // A cancel is not a transport failure: the next upload still goes direct.
    mock.commands.length = 0;
    expect(await tryUploadPeerAttachment(peer, source, undefined, invoke)).toContain(ticket);
    expect(ops().at(-1)).toBe('finish');
  });
  it('returns at once when cancelled while a block reply is still pending', async () => {
    const peer = 'pending-reply-cancel-peer';
    const source = path.join(directory, 'upload');
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 5));
    const ticket = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => ({
      ok: true,
      result:
        (args[0] as { action: string }).action === 'caps'
          ? { version: 1, streaming: true, attachments: true, streamAttachments: true }
          : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
    }));
    const abort = new AbortController();
    const ops = () =>
      mock.commands
        .filter((c) => c.action === 'invoke')
        .map((c) => JSON.parse(c.payload).args[0].request.op as string);
    mock.commandReply.mockImplementation((action) => {
      if (action !== 'invoke') return 'v=0';
      const op = JSON.parse(mock.commands.at(-1)!.payload).args[0].request.op;
      // From the first block on, replies stall like a slow link; then the user cancels.
      if (op === 'write' && !mock.replyDelay) {
        mock.replyDelay = 4_000;
        setTimeout(() => abort.abort(), 10);
      }
      return JSON.stringify({ ok: true, result: op === 'begin' ? { ticket } : {} });
    });
    const startedAt = Date.now();
    await expect(
      tryUploadPeerAttachment(peer, source, undefined, invoke, undefined, abort.signal),
    ).rejects.toThrow('FILE_PEER_CANCELLED');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The connection stays up, so the target is still told to drop the partial staging.
    await vi.waitFor(() => expect(ops().at(-1)).toBe('cancel'));
  });
  it('returns at once when cancelled during the capability probe, with the source already closed', async () => {
    const source = path.join(directory, 'upload');
    await writeFile(source, 'hello');
    const opened = vi.spyOn(fsPromises, 'open');
    let answer!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const abort = new AbortController();
    const upload = tryUploadPeerAttachment(
      'silent-peer',
      source,
      undefined,
      invoke as never,
      undefined,
      abort.signal,
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const handle = await (opened.mock.results[0].value as ReturnType<typeof fsPromises.open>);
    // A slow close (like a busy disk) makes a caller that settles early observable.
    const close = handle.close.bind(handle);
    let closed = false;
    handle.close = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await close();
      closed = true;
    };
    abort.abort();
    // The caller may delete the file straight away (Windows), so the close must have finished
    // when the call settles — not still be running in the background.
    const settled = await upload.then(
      () => ({ error: '', closed }),
      (error: Error) => ({ error: error.message, closed }),
    );
    opened.mockRestore();
    expect(settled).toEqual({ error: 'FILE_PEER_CANCELLED', closed: true });
    // The late probe result is ignored: nothing is hashed or sent afterwards.
    answer({ ok: true, result: { version: 1, streaming: true, attachments: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(mock.commands.filter((c) => c.action === 'invoke')).toEqual([]);
  });
  it('drops the ticket of a begin answered only after the upload was cancelled', async () => {
    const peer = 'late-begin-peer';
    const source = path.join(directory, 'upload');
    await writeFile(source, 'hello');
    const ticket = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => ({
      ok: true,
      result:
        (args[0] as { action: string }).action === 'caps'
          ? { version: 1, streaming: true, attachments: true, streamAttachments: true }
          : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
    }));
    const abort = new AbortController();
    const requests = () =>
      mock.commands
        .filter((c) => c.action === 'invoke')
        .map((c) => JSON.parse(c.payload).args[0].request as { op: string; ticket?: string });
    mock.commandReply.mockImplementation((action) => {
      // Once connected, the target answers slowly.
      if (action === 'answer') mock.replyDelay = 50;
      if (action !== 'invoke') return 'v=0';
      const op = JSON.parse(mock.commands.at(-1)!.payload).args[0].request.op;
      return JSON.stringify({ ok: true, result: op === 'begin' ? { ticket } : {} });
    });
    const upload = tryUploadPeerAttachment(peer, source, undefined, invoke, undefined, abort.signal);
    // The target has created the ticket, but before its answer arrives the user cancels.
    await vi.waitFor(() => expect(requests().map((r) => r.op)).toContain('begin'));
    abort.abort();
    await expect(upload).rejects.toThrow('FILE_PEER_CANCELLED');
    // The cancel returned at once; the late ticket is still released on the target.
    await vi.waitFor(() => expect(requests().at(-1)).toEqual({ op: 'cancel', ticket }));
    expect(requests().filter((r) => r.op === 'write')).toEqual([]);
  });
  it('cancelling an upload during connection setup leaves another peer and its transfer untouched', async () => {
    const source = path.join(directory, 'upload');
    await writeFile(source, 'hello');
    // Peer B: an established connection with a download in flight.
    const invokeB = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => {
      const action = (args[0] as { action: string }).action;
      return {
        ok: true,
        result:
          action === 'caps'
            ? { version: 1, streaming: true }
            : action === 'open'
              ? { ticket: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', size: 5, mimeType: 'text/plain' }
              : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
      };
    });
    const download = tryPeerFile('fault-radius-peer-b', 'xdt-file://test', invokeB);
    await vi.waitFor(() => expect(mock.receiving).toBeDefined());
    const inFlightB = mock.receiving!;
    // Peer A: the upload is cancelled while its connection is still being set up (no answer).
    const invokeA = vi.fn(async (_peer: string, _channel: string, args: unknown[]) =>
      (args[0] as { action: string }).action === 'caps'
        ? {
            ok: true,
            result: { version: 1, streaming: true, attachments: true, streamAttachments: true },
          }
        : new Promise<never>(() => {}),
    );
    const abort = new AbortController();
    const upload = tryUploadPeerAttachment(
      'fault-radius-peer-a',
      source,
      undefined,
      invokeA as never,
      undefined,
      abort.signal,
    );
    await vi.waitFor(() =>
      expect(invokeA.mock.calls.map((call) => (call[2][0] as { action: string }).action)).toContain(
        'offer',
      ),
    );
    abort.abort();
    await expect(upload).rejects.toThrow('FILE_PEER_CANCELLED');
    // B never notices: its in-flight transfer completes on the same connection.
    await mock.handlers.get('file-peer:host:write')!({}, inFlightB.sink, 0, 'aGVsbG8=');
    inFlightB.reply();
    const result = await download;
    expect(result?.size).toBe(5);
    await result?.dispose();
    expect(invokeB.mock.calls.map((call) => (call[2][0] as { action: string }).action)).not.toContain(
      'close',
    );
  });
  it('drops a cancelled upload still queued behind another transfer on the same peer', async () => {
    const peer = 'queued-cancel-peer';
    const source = path.join(directory, 'upload');
    await writeFile(source, 'hello');
    const invoke = vi.fn(async (_peer: string, _channel: string, args: unknown[]) => {
      const action = (args[0] as { action: string }).action;
      return {
        ok: true,
        result:
          action === 'caps'
            ? { version: 1, streaming: true, attachments: true, streamAttachments: true }
            : action === 'open'
              ? { ticket: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', size: 5, mimeType: 'text/plain' }
              : { connection: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sdp: 'v=0' },
      };
    });
    // A preview download holds the peer's transfer queue until its bytes arrive.
    const download = tryPeerFile(peer, 'xdt-file://test', invoke);
    await vi.waitFor(() => expect(mock.receiving).toBeDefined());
    const abort = new AbortController();
    const upload = tryUploadPeerAttachment(
      peer,
      source,
      undefined,
      invoke,
      undefined,
      abort.signal,
    );
    abort.abort();
    await expect(upload).rejects.toThrow('FILE_PEER_CANCELLED');
    await mock.handlers.get('file-peer:host:write')!({}, mock.receiving!.sink, 0, 'aGVsbG8=');
    mock.receiving!.reply();
    const result = await download;
    expect(result?.size).toBe(5);
    await result?.dispose();
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
  it('keeps a connection alive while a long attachment request is handled, then idles out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let finish!: (value: unknown) => void;
      const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
      const { connection } = (await requestFilePeer(
        'device-a',
        { action: 'offer', sdp: 'v=0' },
        invoke as never,
      )) as { connection: string };
      const payload = JSON.stringify({
        channel: 'device-link:file-peer',
        args: [{ action: 'attachment', connection, request: { op: 'finish' } }],
      });
      // 接收端整读重算大附件摘要可能远超 60 秒空闲时限。
      const handled = mock.handlers.get('file-peer:host:invoke')!({}, connection, payload);
      await vi.advanceTimersByTimeAsync(150_000);
      finish({ ok: true });
      await expect(handled).resolves.toBe(JSON.stringify({ ok: true }));
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(
        mock.handlers.get('file-peer:host:invoke')!({}, connection, payload),
      ).rejects.toThrow('FILE_PEER_CLOSED');
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps only the stalled peer alive; another controller link and in-flight request are unaffected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let finishA!: (value: unknown) => void;
      let finishB!: (value: unknown) => void;
      const invokeA = vi.fn(() => new Promise((resolve) => { finishA = resolve; }));
      const invokeB = vi.fn(() => new Promise((resolve) => { finishB = resolve; }));
      const offer = async (peer: string, invoke: unknown) =>
        ((await requestFilePeer(peer, { action: 'offer', sdp: 'v=0' }, invoke as never)) as {
          connection: string;
        }).connection;
      const a = await offer('device-a', invokeA);
      const b = await offer('device-b', invokeB);
      const handle = (connection: string) =>
        mock.handlers.get('file-peer:host:invoke')!(
          {},
          connection,
          JSON.stringify({
            channel: 'device-link:file-peer',
            args: [{ action: 'attachment', connection, request: { op: 'finish' } }],
          }),
        );
      // device-a 停在一次很长的请求上(不回包);device-b 同时有自己的在途请求。
      const stalledA = handle(a);
      const inflightB = handle(b);
      await vi.advanceTimersByTimeAsync(20_000);
      finishB({ ok: 'b' });
      await expect(inflightB).resolves.toBe(JSON.stringify({ ok: 'b' }));
      // A 的保活只刷新 A 自己的连接:B 按自身空闲时限关闭,不被 A 延长。
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(handle(b)).rejects.toThrow('FILE_PEER_CLOSED');
      finishA({ ok: 'a' });
      await expect(stalledA).resolves.toBe(JSON.stringify({ ok: 'a' }));
    } finally {
      vi.useRealTimers();
    }
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
  it('samples send progress without renewing the idle deadline and stops with the connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { connection } = await connect();
      const { ticket } = await open(connection);
      mock.commandReply.mockClear();
      await vi.advanceTimersByTimeAsync(3_000);
      const samples = () => mock.commandReply.mock.calls.filter(([action]) => action === 'stats');
      expect(samples().length).toBeGreaterThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(58_000);
      await expect(read(connection, ticket, 0)).rejects.toThrow('FILE_PEER_BLOCK');
      mock.commandReply.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(samples()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a transfer usable when a diagnostics stats probe stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { connection } = await connect();
      mock.replyDelay = 20_000;
      const { ticket } = await open(connection);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await read(connection, ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
      expect(await read(connection, ticket, 5)).toBe('');
      expect((await open(connection)).ticket).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps sampling after a failed stats probe while the transfer runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { connection } = await connect();
      // Every stats reply stalls past the 5s probe budget: each sample times out.
      mock.replyDelay = 20_000;
      const { ticket } = await open(connection);
      await vi.advanceTimersByTimeAsync(30_000);
      // A transient stats failure skips one sample instead of silencing the rest
      // of the transfer: probes keep flowing (old code sent exactly two).
      expect(mock.sent.filter((action) => action === 'stats').length).toBeGreaterThanOrEqual(5);
      expect(await read(connection, ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not let transfer chunks stretch a stalled stats probe past its budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      await truncate(file, 100_000);
      mock.resolve.mockResolvedValue({ absPath: file, mimeType: 'text/plain', maxBytes: 100_000 });
      const { connection } = await connect();
      mock.replyDelay = 20_000;
      const { ticket, size } = await open(connection);
      expect(size).toBe(100_000);
      // Chunks keep arriving well within 5s; a shared timer would let them refresh
      // the stalled probe forever and skip every later sample.
      for (let offset = 0; ; offset += 16_384) {
        await vi.advanceTimersByTimeAsync(3_000);
        const base64 = await read(connection, ticket, Math.min(offset, size));
        if (!base64) break;
      }
      expect(mock.sent.filter((action) => action === 'stats').length).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('attributes channel drain to one file at a time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      mock.commandReply.mockImplementation((action) =>
        action === 'stats' ? JSON.stringify({ channel: { bufferedAmount: 5 } }) : 'v=0',
      );
      const { connection } = await connect();
      const first = await open(connection);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await read(connection, first.ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
      expect(await read(connection, first.ticket, 5)).toBe('');
      // The first file is still draining (bufferedAmount stays above zero) when the
      // next transfer starts and owns the channel buffer.
      await vi.advanceTimersByTimeAsync(1_000);
      await open(connection);
      mock.sent.length = 0;
      await vi.advanceTimersByTimeAsync(3_000);
      // Only the new file samples now; a superseded drain monitor would double the rate.
      expect(mock.sent.filter((action) => action === 'stats').length).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
