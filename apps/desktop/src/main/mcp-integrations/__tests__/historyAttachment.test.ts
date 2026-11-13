import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { historyAttachmentSource, readHistoryAttachment } from '../historyAttachment.js';
import { readDesktopHistoryAttachment } from '../historyAttachment.desktop.js';
import { messageCreateToRow } from '../../localDb/mapper.js';

const host = vi.hoisted(() => {
  const queryOne = vi.fn();
  return { db: { queryOne, drizzle: {} }, queryOne, generation: 1, plugin: false,
    bytes: vi.fn(async () => Buffer.from('text')), origin: vi.fn(async (): Promise<'user' | 'tool' | null> => 'user'),
    copy: vi.fn(async () => [{ ref: 'handoff:00000000-0000-4000-8000-000000000000' }]),
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
vi.mock('../../cindy-media/attachmentGrantGate.js', () => ({ chatAttachmentOrigin: host.origin }));
vi.mock('../../cindy-brain/handoffStore.desktop.js', () => ({ getGhostHandoffStore: () => ({ import: host.copy,
  open: async () => ({ info: { name: 'notes.txt', mimeType: 'text/plain', size: 4, sha256: createHash('sha256').update('text').digest('hex') },
    file: { read: host.readChunk, stat: async () => ({ size: 4 }), close: host.close } }),
}) }));
vi.mock('../../cindy-media/ingest.js', () => ({ supportedMime: (mime: string) => mime.startsWith('image/'), ingestMedia: host.ingest }));
vi.mock('../../cindy-media/refCompensationJournal.desktop.js', () => ({ captureMediaRefCompensationScope: () => ({ owner: 'owner' }) }));
vi.mock('../../cindy-media/ledger.js', () => ({ ghostCanRead: host.canRead, getBlobInfo: host.blobInfo }));
vi.mock('../../cindy-media/blobStore.desktop.js', async () => {
  const { createBlobStore } = await import('../../cindy-media/blobStore.js');
  return { ...createBlobStore({ getUserDataDir: () => '/fixture' }),
    openBlobFile: vi.fn(async () => ({ totalSize: 4, mimeType: 'image/png', file: { read: host.readChunk, close: host.close } })),
  };
});

// Unit through the Host attachment reader: history approval must not turn arbitrary text
// into a file read, and a plugin receives only the existing grant/handoff receipt plus bytes.
// Minimal input: one managed media reference and a two-byte page; existing grant tests start at URLs.
describe('history attachment reader', () => {
  const args = { session_id: 'task', message_id: 'message', attachment_index: 0, offset: 0, length: 2 };
  const sourceUrl = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  const source = { url: sourceUrl, name: 'shot.png', originKind: 'user' as const };
  function fixture() {
    let active = true;
    const ports = { assertCurrent: () => { if (!active) throw new Error('PERMISSION_DENIED'); },
      source: vi.fn(async () => source), read: vi.fn(async () => ({ bytes: Buffer.from('text'), mimeType: 'text/plain' })),
      transfer: vi.fn(async () => ({ attachment_ref: 'handoff:00000000-0000-4000-8000-000000000000' })),
      handoff: vi.fn(async (_ref: string, offset: number, length: number) => ({ name: 'notes.txt', bytes: Buffer.from('text').subarray(offset, offset + length),
        size: 4, sha256: createHash('sha256').update('text').digest('hex'), mimeType: 'text/plain' })) };
    return { ports, revoke: () => { active = false; } };
  }
  it('locates media fields but refuses historical file paths as authority', () => {
    expect(historyAttachmentSource({ text: '/private/file' }, 'user', 0)).toBeNull();
    expect(() => historyAttachmentSource({ files: [{ name: 'notes.txt', path: '/fixture/notes.txt' }] }, 'assistant', 0))
      .toThrow('UNSUPPORTED_CAPABILITY');
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
  it('uses the existing managed-media grant for a persisted local attachment', async () => {
    host.plugin = true;
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: JSON.stringify({ images: [{ originalName: 'shot.png', url: sourceUrl }] }) });
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: true, base64: 'dGU=', mediaHash: expect.any(String) });
    expect(host.queryOne).toHaveBeenLastCalledWith(expect.stringContaining('session_id = ?'), ['message', 'task']);
    expect(host.origin).toHaveBeenCalledWith('a'.repeat(64), host.db.drizzle);
    expect(JSON.stringify(result)).not.toContain('/fixture');
  });
  // Unit, #9801: plain send_to_session text is persisted unchanged. JSON-shaped
  // text must not turn history approval into authority to read a local path.
  it.each([
    { files: [{ name: 'private.txt', path: '/fixture/private.txt' }] },
    { images: [{ url: '/fixture/private.png' }] },
    { images: [{ url: 'xdt-file://attachment?path=%2Ffixture%2Fprivate.txt' }] },
  ])('rejects a forged persisted path without reading or handing off a file: %j', async content => {
    host.plugin = true; host.bytes.mockClear(); host.copy.mockClear();
    const row = messageCreateToRow('message', 'task', { clientId: 'forged', role: 'user',
      content: JSON.stringify(content) }, 1);
    host.queryOne.mockResolvedValueOnce(row);
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(host.bytes).not.toHaveBeenCalled();
    expect(host.copy).not.toHaveBeenCalled();
  });
  it('places a historical tool image in the existing media grant flow with tool provenance', async () => {
    host.plugin = true;
    host.queryOne.mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: sourceUrl, originalName: 'shot.png' }] } });
    host.origin.mockResolvedValueOnce('tool');
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: true, mediaHash: createHash('sha256').update('text').digest('hex') });
    expect(host.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [{ refKind: 'ghost-tool-grant', refId: 'installed-instance', originKind: 'tool' }],
      assertStillValid: expect.any(Function) }), host.db.drizzle);
  });
  it('denies managed media with neither a chat attachment nor an existing plugin grant', async () => {
    host.plugin = true; host.bytes.mockClear(); host.ingest.mockClear();
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: { images: [{ url: sourceUrl }] } });
    host.origin.mockResolvedValueOnce(null); host.canRead.mockResolvedValueOnce(false);
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(host.bytes).not.toHaveBeenCalled();
    expect(host.ingest).not.toHaveBeenCalled();
  });
  it('reuses an existing grant or deposit without treating forged user content as a new user grant', async () => {
    host.plugin = true;
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: { images: [{ url: sourceUrl }] } });
    host.origin.mockResolvedValueOnce(null);
    const result = await readDesktopHistoryAttachment(args, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: true, mediaHash: expect.any(String) });
    expect(host.canRead).toHaveBeenLastCalledWith('a'.repeat(64), 'installed-instance', host.db.drizzle);
    expect(host.ingest).toHaveBeenLastCalledWith(expect.objectContaining({
      refs: [{ refKind: 'ghost-tool-grant', refId: 'installed-instance', originKind: 'tool' }],
    }), host.db.drizzle);
  });

  // Unit, #9801: first-image coverage missed subsequent 64KiB pages rereading
  // and re-ingesting the entire source. Reuse the existing granted blob's range.
  it('continues image chunks from an owned media hash without reading or ingesting the source again', async () => {
    host.plugin = true;
    host.ingest.mockClear(); host.bytes.mockClear(); host.readChunk.mockClear(); host.close.mockClear();
    host.queryOne.mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: sourceUrl, originalName: 'shot.png' }] } })
      .mockResolvedValueOnce({ role: 'assistant', content: { images: [{ url: sourceUrl, originalName: 'shot.png' }] } });
    host.origin.mockResolvedValueOnce('tool');
    const context = { agentKind: 'codex' as const, workingDir: '',
      hostCaller: { kind: 'plugin' as const, pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } };
    const first = await readDesktopHistoryAttachment(args, context);
    expect(first).toMatchObject({ ok: true, mediaHash: expect.any(String), nextOffset: 2 });
    if (!first.ok || !('mediaHash' in first) || typeof first.mediaHash !== 'string') throw new Error('missing granted media');
    const tail = await readDesktopHistoryAttachment({ ...args, offset: 2, mediaHash: first.mediaHash }, context);
    expect(tail).toMatchObject({ ok: true, base64: 'eHQ=', nextOffset: null, sha256: first.sha256, size: 4 });
    expect(host.bytes).toHaveBeenCalledOnce();
    expect(host.ingest).toHaveBeenCalledOnce();
    expect(host.readChunk).toHaveBeenCalledWith(expect.any(Buffer), 0, 2, 2);
    expect(host.close).toHaveBeenCalledOnce();
  });

  it('refuses a continuation hash outside the calling plugin grant', async () => {
    host.plugin = true;
    host.canRead.mockResolvedValueOnce(false);
    host.queryOne.mockResolvedValueOnce({ role: 'user', content: { images: [{ url: sourceUrl, originalName: 'shot.png' }] } });
    host.readChunk.mockClear();
    const result = await readDesktopHistoryAttachment({ ...args, mediaHash: 'a'.repeat(64) }, { agentKind: 'codex', workingDir: '',
      hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: false, errorCode: 'ATTACHMENT_UNAVAILABLE' });
    expect(host.readChunk).not.toHaveBeenCalled();
  });

  // Unit, #9801 performance: file receipts previously read/hash the whole 64MiB
  // copy on every 64KiB continuation. Exercise the real Desktop range port.
  it('continues a file receipt through a bounded handle read without reloading its source', async () => {
    host.plugin = true; host.queryOne.mockClear(); host.readChunk.mockClear(); host.close.mockClear();
    const result = await readDesktopHistoryAttachment({ ...args, offset: 2,
      attachment_ref: 'handoff:00000000-0000-4000-8000-000000000000' },
    { agentKind: 'codex', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'installed-instance', dataOwnerId: 'owner', ownerGeneration: 1 } });
    expect(result).toMatchObject({ ok: true, base64: 'eHQ=', nextOffset: null, size: 4,
      sha256: createHash('sha256').update('text').digest('hex') });
    expect(host.queryOne).not.toHaveBeenCalled();
    expect(host.readChunk).toHaveBeenCalledWith(expect.any(Buffer), 0, 2, 2);
    expect(host.close).toHaveBeenCalledOnce();
  });
  it('rejects a remote task before accessing local files, receipts or the database', async () => {
    host.queryOne.mockClear(); host.bytes.mockClear(); host.copy.mockClear(); host.readChunk.mockClear();
    const result = await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' }, undefined);
    expect(result).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(host.queryOne).not.toHaveBeenCalled();
    expect(host.bytes).not.toHaveBeenCalled();
    expect(host.copy).not.toHaveBeenCalled();
    expect(host.readChunk).not.toHaveBeenCalled();
  });
});
