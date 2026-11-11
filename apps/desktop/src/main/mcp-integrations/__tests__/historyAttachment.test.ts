import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { historyAttachmentSource, readHistoryAttachment } from '../historyAttachment.js';
import { readDesktopHistoryAttachment } from '../historyAttachment.desktop.js';
import type { readRemoteDeviceFile } from '../../device-link/fileAccess.js';
import { DL_MEDIA_FETCH_CHANNEL } from '@cindy/device-link';

const host = vi.hoisted(() => {
  const queryOne = vi.fn();
  return { db: { queryOne, drizzle: {} }, queryOne, generation: 1, plugin: false,
    bytes: vi.fn(async () => Buffer.from('text')), resolve: vi.fn(async () => ({ absPath: '/fixture/notes.txt', mimeType: 'text/plain' })),
    copy: vi.fn(async () => [{ ref: 'handoff:00000000-0000-4000-8000-000000000000' }]),
    remoteFile: vi.fn(async (..._args: Parameters<typeof readRemoteDeviceFile>) => ({ inlineBase64: Buffer.from('remote').toString('base64'), mimeType: 'text/plain', ossKey: '', size: 6 })),
    ingest: vi.fn(async () => ({ hash: createHash('sha256').update('text').digest('hex') })),
    canRead: vi.fn(async () => true),
    blobInfo: vi.fn(async () => ({ ext: '.png', mimeType: 'image/png', bytes: 4 })),
    readChunk: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Buffer.from('text').copy(buffer, offset, position, position + length);
      return { buffer, bytesRead };
    }), close: vi.fn(async () => {}) };
});
vi.mock('../../appSessionState.js', () => ({ getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: host.generation }) }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => host.db, tryGetDbClient: () => host.db }));
vi.mock('../hostToolCaller.js', () => ({ getPluginHostToolCaller: () => host.plugin ? {
  caller: { kind: 'plugin', pluginId: 'installed-instance' }, assertCurrent() {},
} : undefined }));
vi.mock('../../utils/readBoundedFile.js', () => ({ readBoundedFileNoFollow: host.bytes }));
vi.mock('../../device-link/mediaFetch.js', () => ({ resolveAuthorizedMedia: host.resolve }));
vi.mock('../../device-link/fileAccess.js', () => ({ readRemoteDeviceFile: host.remoteFile }));
vi.mock('../../device-link/mediaTransfer.js', () => ({ downloadToBuffer: vi.fn() }));
vi.mock('../../cindy-brain/handoffStore.desktop.js', () => ({ getGhostHandoffStore: () => ({ import: host.copy,
  open: async () => ({ info: { name: 'notes.txt', mimeType: 'text/plain', size: 4, sha256: createHash('sha256').update('text').digest('hex') },
    file: { read: host.readChunk, stat: async () => ({ size: 4 }), close: host.close } }),
}) }));
vi.mock('../../cindy-media/ingest.js', () => ({ supportedMime: (mime: string) => mime.startsWith('image/'), ingestMedia: host.ingest }));
vi.mock('../../cindy-media/refCompensationJournal.desktop.js', () => ({ captureMediaRefCompensationScope: () => ({ owner: 'owner' }) }));
vi.mock('../../cindy-media/ledger.js', () => ({ ghostCanRead: host.canRead, getBlobInfo: host.blobInfo }));
vi.mock('../../cindy-media/blobStore.desktop.js', () => ({
  blobUrl: (hash: string, ext: string) => `cindy-media://blobs/${hash}${ext}`,
  openBlobFile: vi.fn(async () => ({ totalSize: 4, mimeType: 'image/png', file: { read: host.readChunk, close: host.close } })),
}));

// Unit through the Host attachment reader: history approval must not turn arbitrary text
// into a file read, and a plugin receives only the existing grant/handoff receipt plus bytes.
// Minimal input: one registered file and a two-byte page; existing grant tests start at URLs.
describe('history attachment reader', () => {
  const args = { session_id: 'task', message_id: 'message', attachment_index: 0, offset: 0, length: 2 };
  const source = { url: 'xdt-file://attachment?path=%2Ffixture%2Fnotes.txt', name: 'notes.txt', originKind: 'user' as const };
  function fixture() {
    let active = true;
    const ports = { assertCurrent: () => { if (!active) throw new Error('PERMISSION_DENIED'); },
      source: vi.fn(async () => source), read: vi.fn(async () => ({ bytes: Buffer.from('text'), mimeType: 'text/plain' })),
      transfer: vi.fn(async () => ({ attachment_ref: 'handoff:00000000-0000-4000-8000-000000000000' })),
      handoff: vi.fn(async (_ref: string, offset: number, length: number) => ({ name: 'notes.txt', bytes: Buffer.from('text').subarray(offset, offset + length),
        size: 4, sha256: createHash('sha256').update('text').digest('hex'), mimeType: 'text/plain' })) };
    return { ports, revoke: () => { active = false; } };
  }
  it('reads only registered attachment fields, keeping user/tool provenance', () => {
    expect(historyAttachmentSource({ text: '/private/file' }, 'user', 0)).toBeNull();
    expect(historyAttachmentSource({ files: [{ name: 'notes.txt', path: '/fixture/notes.txt' }] }, 'assistant', 0))
      .toMatchObject({ name: 'notes.txt', originKind: 'tool', url: expect.stringContaining('xdt-file:') });
    expect(historyAttachmentSource({ images: [{ url: 'cindy-media://blobs/hash.png', originalName: 'shot.png' }] }, 'user', 0))
      .toMatchObject({ name: 'shot.png', originKind: 'user' });
  });
  it('returns bounded bytes and the existing handoff receipt without source paths', async () => {
    const f = fixture();
    const result = await readHistoryAttachment(args, f.ports);
    if (!result.ok) throw new Error(result.errorCode);
    expect(result).toMatchObject({ ok: true, base64: Buffer.from('te').toString('base64'), nextOffset: 2, size: 4, attachment_ref: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('/fixture');
    expect(f.ports.transfer).toHaveBeenCalledOnce();
    const tail = await readHistoryAttachment({ ...args, offset: 2, attachment_ref: result.attachment_ref }, f.ports);
    expect(tail).toMatchObject({ base64: Buffer.from('xt').toString('base64'), nextOffset: null, sha256: result.sha256 });
    expect(f.ports.read).toHaveBeenCalledOnce();
    expect(f.ports.transfer).toHaveBeenCalledOnce();
  });
  it('refuses expired or foreign handoff references without reading the source again', async () => {
    const f = fixture();
    f.ports.handoff.mockResolvedValueOnce(null as never);
    expect(await readHistoryAttachment({ ...args, attachment_ref: 'handoff:missing' }, f.ports)).toMatchObject({ ok: false, errorCode: 'HANDOFF_UNAVAILABLE' });
    expect(f.ports.source).not.toHaveBeenCalled();
  });
  it('revokes an in-flight read before handing bytes or receipts to a changed owner', async () => {
    const f = fixture();
    f.ports.read.mockImplementationOnce(async () => { f.revoke(); return { bytes: Buffer.from('text'), mimeType: 'text/plain' }; });
    await expect(readHistoryAttachment(args, f.ports)).rejects.toThrow('PERMISSION_DENIED');
    expect(f.ports.transfer).not.toHaveBeenCalled();
  });
  it('uses the production persisted-message lookup and handoff storage for a plugin file', async () => {
    host.plugin = true;
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: JSON.stringify({ files: [{ name: 'notes.txt', path: '/fixture/notes.txt' }] }) });
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } },
    { query: vi.fn(), invoke: vi.fn() });
    expect(result).toMatchObject({ ok: true, base64: 'dGU=', attachment_ref: expect.any(String) });
    expect(host.queryOne).toHaveBeenLastCalledWith(expect.stringContaining('session_id = ?'), ['message', 'task']);
    expect(host.copy).toHaveBeenCalledWith('installed-instance', [{ name: 'notes.txt', bytes: Buffer.from('text') }], expect.any(Function));
    expect(JSON.stringify(result)).not.toContain('/fixture');
  });
  it('places a historical tool image in the existing media grant flow with tool provenance', async () => {
    host.plugin = true;
    host.queryOne.mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: 'cindy-media://blobs/source.png', originalName: 'shot.png' }] } });
    host.resolve.mockResolvedValueOnce({ absPath: '/fixture/shot.png', mimeType: 'image/png' });
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } },
    { query: vi.fn(), invoke: vi.fn() });
    expect(result).toMatchObject({ ok: true, mediaHash: createHash('sha256').update('text').digest('hex') });
    expect(host.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [{ refKind: 'ghost-tool-grant', refId: 'installed-instance', originKind: 'tool' }],
      assertStillValid: expect.any(Function) }), host.db.drizzle);
  });

  // Unit, #9801: first-image coverage missed subsequent 64KiB pages rereading
  // and re-ingesting the entire source. Reuse the existing granted blob's range.
  it('continues image chunks from an owned media hash without reading or ingesting the source again', async () => {
    host.plugin = true;
    host.ingest.mockClear(); host.resolve.mockClear(); host.bytes.mockClear(); host.readChunk.mockClear(); host.close.mockClear();
    host.queryOne.mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: 'cindy-media://blobs/source.png', originalName: 'shot.png' }] } })
      .mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: 'cindy-media://blobs/source.png', originalName: 'shot.png' }] } });
    host.resolve.mockResolvedValueOnce({ absPath: '/fixture/shot.png', mimeType: 'image/png' });
    const context = { agentKind: 'codex' as const, workingDir: '',
      hostCaller: { kind: 'plugin' as const, pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } };
    const remote = { query: vi.fn(), invoke: vi.fn() };
    const first = await readDesktopHistoryAttachment(args, context, remote);
    expect(first).toMatchObject({ ok: true, mediaHash: expect.any(String), nextOffset: 2 });
    if (!first.ok || !('mediaHash' in first) || typeof first.mediaHash !== 'string') throw new Error('missing granted media');
    const tail = await readDesktopHistoryAttachment({ ...args, offset: 2, mediaHash: first.mediaHash }, context, remote);
    expect(tail).toMatchObject({ ok: true, base64: 'eHQ=', nextOffset: null, sha256: first.sha256, size: 4 });
    expect(host.resolve).toHaveBeenCalledOnce();
    expect(host.bytes).toHaveBeenCalledOnce();
    expect(host.ingest).toHaveBeenCalledOnce();
    expect(host.readChunk).toHaveBeenCalledWith(expect.any(Buffer), 0, 2, 2);
    expect(host.close).toHaveBeenCalledOnce();
  });

  it('refuses a continuation hash outside the calling plugin grant', async () => {
    host.plugin = true;
    host.canRead.mockResolvedValueOnce(false);
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: { images: [{ url: 'cindy-media://blobs/source.png', originalName: 'shot.png' }] } });
    host.readChunk.mockClear();
    const result = await readDesktopHistoryAttachment({ ...args, mediaHash: 'a'.repeat(64) }, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } },
    { query: vi.fn(), invoke: vi.fn() });
    expect(result).toMatchObject({ ok: false, errorCode: 'ATTACHMENT_UNAVAILABLE' });
    expect(host.readChunk).not.toHaveBeenCalled();
  });

  // Unit, #9801 performance: file receipts previously read/hash the whole 64MiB
  // copy on every 64KiB continuation. Exercise the real Desktop range port.
  it('continues a file receipt through a bounded handle read without reloading its source', async () => {
    host.plugin = true; host.queryOne.mockClear(); host.readChunk.mockClear(); host.close.mockClear();
    const result = await readDesktopHistoryAttachment({ ...args, offset: 2,
      attachment_ref: 'handoff:00000000-0000-4000-8000-000000000000' },
    { agentKind: 'codex', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } },
    { query: vi.fn(), invoke: vi.fn() });
    expect(result).toMatchObject({ ok: true, base64: 'eHQ=', nextOffset: null, size: 4,
      sha256: createHash('sha256').update('text').digest('hex') });
    expect(host.queryOne).not.toHaveBeenCalled();
    expect(host.readChunk).toHaveBeenCalledWith(expect.any(Buffer), 0, 2, 2);
    expect(host.close).toHaveBeenCalledOnce();
  });
  it.each([null, '12'])('resolves a remote message with source byte ceiling %s through the existing file channel', async ceiling => {
    host.plugin = false;
    const sourceUrl = 'xdt-file://attachment?path=remote-private' + (ceiling ? `&maxBytes=${ceiling}` : '');
    const query = vi.fn(async () => ({ ok: true, url: sourceUrl, name: 'notes.txt', originKind: 'user' }));
    const invoke = vi.fn();
    const result = await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' },
      { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' }, { query, invoke });
    expect(query).toHaveBeenCalledWith('device', expect.objectContaining({ session_id: 'task', message_id: 'message' }));
    expect(host.remoteFile).toHaveBeenCalledWith('device', `xdt-file://attachment?path=remote-private&maxBytes=${ceiling ?? 64 * 1024 * 1024}`,
      expect.any(Function), expect.objectContaining({ maxBytes: 64 * 1024 * 1024, cacheFirst: false }));
    expect(result).toMatchObject({ ok: true, base64: Buffer.from('re').toString('base64'), size: 6 });
    expect(JSON.stringify(result)).not.toContain('remote-private');
  });

  // Unit, #9801: reject source metadata before the existing transfer service
  // proceeds to peer/OSS bytes; the old maxBytes option did not constrain this path.
  it.each(['xdt-file://attachment?path=remote-private', 'cindy-media://blobs/source.png'])(
    'rejects oversized metadata before transferring any bytes from %s', async sourceUrl => {
    host.plugin = false;
    const transfer = vi.fn();
    host.remoteFile.mockImplementationOnce(async (device, url, invoke) => {
      await invoke(device, DL_MEDIA_FETCH_CHANNEL, [{ url, prepareOnly: true }]);
      transfer();
      return { inlineBase64: Buffer.from('remote').toString('base64'), mimeType: 'text/plain', ossKey: '', size: 6 };
    });
    const result = await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' },
      { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' }, {
        query: async () => ({ ok: true, url: sourceUrl, name: 'notes.txt', originKind: 'user' }),
        invoke: vi.fn(async () => ({ ok: true as const, result: { size: 64 * 1024 * 1024 + 1, ossKey: '', mimeType: 'text/plain', transferRequired: true } })),
      });
    expect(result.ok).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
    const request = host.remoteFile.mock.calls.at(-1)!;
    if (sourceUrl.startsWith('xdt-file:'))
      expect(new URL(request[1]).searchParams.get('maxBytes')).toBe(String(64 * 1024 * 1024));
    else expect(request[1]).toBe(sourceUrl);
    expect(request[3]).toMatchObject({ cacheFirst: false });
  });

  it('rejects malformed source constraints and mismatched transferred bytes before handing them off', async () => {
    host.plugin = true; host.copy.mockClear(); host.remoteFile.mockClear();
    const context = { agentKind: 'codex' as const, workingDir: '', hostCaller: {
      kind: 'plugin' as const, pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } };
    const remote = { query: async () => ({ ok: true, url: 'xdt-file://attachment?path=remote-private&maxBytes=invalid', name: 'notes.txt', originKind: 'user' }), invoke: vi.fn() };
    expect(await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' }, context, remote))
      .toMatchObject({ ok: false, errorCode: 'ATTACHMENT_UNAVAILABLE' });
    expect(host.remoteFile).not.toHaveBeenCalled();
    host.remoteFile.mockResolvedValueOnce({ inlineBase64: Buffer.from('short').toString('base64'), mimeType: 'text/plain', ossKey: '', size: 6 });
    expect(await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' }, context,
      { ...remote, query: async () => ({ ok: true, url: 'cindy-media://blobs/source.txt', name: 'notes.txt', originKind: 'user' }) }))
      .toMatchObject({ ok: false, errorCode: 'ATTACHMENT_UNAVAILABLE' });
    expect(host.copy).not.toHaveBeenCalled();
  });

  // Unit/old-peer compatibility: valid new-tool input rejected by an old query registry
  // means unsupported, while a missing registered attachment remains NOT_FOUND.
  it.each([['INVALID_ARGS', 'REMOTE_UNSUPPORTED'], ['REMOTE_UNSUPPORTED_QUERY', 'REMOTE_UNSUPPORTED'],
    ['NOT_FOUND', 'NOT_FOUND'], ['REMOTE_TIMEOUT', 'REMOTE_TIMEOUT']])('preserves remote attachment failure %s', async (remoteCode, expected) => {
    host.plugin = false;
    const result = await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' }, { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' },
      { query: async () => ({ ok: false, errorCode: remoteCode }), invoke: vi.fn() });
    expect(result).toMatchObject({ ok: false, errorCode: expected });
  });
});
