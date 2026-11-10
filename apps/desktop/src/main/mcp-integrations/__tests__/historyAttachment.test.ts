import { describe, expect, it, vi } from 'vitest';
import { historyAttachmentSource, readHistoryAttachment } from '../historyAttachment.js';
import { readDesktopHistoryAttachment } from '../historyAttachment.desktop.js';

const host = vi.hoisted(() => {
  const queryOne = vi.fn();
  return { db: { queryOne, drizzle: {} }, queryOne, generation: 1, plugin: false,
    bytes: vi.fn(async () => Buffer.from('text')), resolve: vi.fn(async () => ({ absPath: '/fixture/notes.txt', mimeType: 'text/plain' })),
    copy: vi.fn(async () => [{ ref: 'handoff:00000000-0000-4000-8000-000000000000' }]),
    remoteFile: vi.fn(async () => ({ inlineBase64: Buffer.from('remote').toString('base64'), mimeType: 'text/plain', ossKey: '', size: 6 })),
    ingest: vi.fn(async () => ({ hash: 'media-hash' })) };
});
vi.mock('../../appSessionState.js', () => ({ getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: host.generation }) }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => host.db, tryGetDbClient: () => host.db }));
vi.mock('../hostToolCaller.js', () => ({ getPluginHostToolCaller: () => host.plugin ? {
  caller: { kind: 'plugin', pluginId: 'installed-instance' }, assertCurrent() {},
} : undefined }));
vi.mock('../../utils/readBoundedFile.js', () => ({ readBoundedFileNoFollow: host.bytes }));
vi.mock('../../device-link/mediaFetch.js', () => ({ resolveAuthorizedMedia: host.resolve }));
vi.mock('../../device-link/fileAccess.js', () => ({ readRemoteDeviceFile: host.remoteFile }));
vi.mock('../../cindy-brain/index.js', () => ({ getGhostHandoffStore: () => ({ import: host.copy, read: async () => null }) }));
vi.mock('../../cindy-media/ingest.js', () => ({ supportedMime: (mime: string) => mime.startsWith('image/'), ingestMedia: host.ingest }));
vi.mock('../../cindy-media/refCompensationJournal.desktop.js', () => ({ captureMediaRefCompensationScope: () => ({ owner: 'owner' }) }));

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
      handoff: vi.fn(async () => ({ name: 'notes.txt', bytes: Buffer.from('text'), mimeType: 'text/plain' })) };
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
    expect(result).toMatchObject({ ok: true, mediaHash: 'media-hash' });
    expect(host.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [{ refKind: 'ghost-tool-grant', refId: 'installed-instance', originKind: 'tool' }],
      assertStillValid: expect.any(Function) }), host.db.drizzle);
  });
  it('resolves a remote message on its source computer and moves bytes through the existing file channel', async () => {
    host.plugin = false;
    const query = vi.fn(async () => ({ ok: true, url: 'xdt-file://attachment?path=remote-private', name: 'notes.txt', originKind: 'user' }));
    const invoke = vi.fn();
    const result = await readDesktopHistoryAttachment({ ...args, session_id: 'device::task' },
      { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' }, { query, invoke });
    expect(query).toHaveBeenCalledWith('device', expect.objectContaining({ session_id: 'task', message_id: 'message' }));
    expect(host.remoteFile).toHaveBeenCalledWith('device', 'xdt-file://attachment?path=remote-private', invoke, expect.objectContaining({ maxBytes: expect.any(Number) }));
    expect(result).toMatchObject({ ok: true, base64: Buffer.from('re').toString('base64'), size: 6 });
    expect(JSON.stringify(result)).not.toContain('remote-private');
  });
});
