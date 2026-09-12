import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  settings: { remoteControlEnabled: true, revokedControllers: [] as string[] },
  current: true,
  resolve: vi.fn(),
}));
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
vi.mock('../../remote-desktop/iceConfig', () => ({ loadDesktopIceServers: async () => [] }));
vi.mock('../../remote-desktop/captureWindow', () => ({
  DesktopCaptureWindow: class {
    contents: any = null;
    async start() {
      this.contents = {
        isDestroyed: () => false,
        send: (_channel: string, id: string, c: { action: string }) => {
          if (c.action !== 'close') mock.handlers.get('file-peer:host:reply')!({}, id, true, 'v=0');
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
import { registerFilePeerIpc, requestFilePeer, stopFilePeers } from '../filePeer';

describe('authorized file peer source', () => {
  let directory: string, file: string;
  beforeEach(async () => {
    mock.current = true;
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
  it('reads bounded bytes and consumes the ticket only after verified EOF', async () => {
    const { connection } = await connect(),
      { ticket, size } = await open(connection);
    expect(size).toBe(5);
    expect(mock.resolve).toHaveBeenCalledWith(expect.anything(), 104857600);
    expect(await read(connection, ticket, 0)).toBe(Buffer.from('hello').toString('base64'));
    expect(await read(connection, ticket, 5)).toBe('');
    await expect(read(connection, ticket, 5)).rejects.toThrow();
    expect((await open(connection)).ticket).not.toBe(ticket);
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
});
