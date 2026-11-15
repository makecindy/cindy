import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHistoryTransfer, NATIVE_HISTORY_CHUNK_BYTES, transferNativeHistory, type NativeHistoryManifest } from '../nativeHistoryTransfer';
import { createRemoteAgentHost } from '../host/runHost';

const nativeId = '11111111-1111-4111-8111-111111111111';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-history-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function setup(bytes = Buffer.from('native tool results, compacted context and reasoning')) {
  const sourceFile = path.join(root, 'source.jsonl');
  const targetFile = path.join(root, 'restored.jsonl');
  const restore = vi.fn(async (file: string, _manifest: NativeHistoryManifest, _cwd: string, assertCurrent: () => void) => {
    assertCurrent();
    await fs.copyFile(file, targetFile);
    return '22222222-2222-4222-8222-222222222222';
  });
  const storage = { locate: async () => ({ file: sourceFile }), restore };
  const source = createNativeHistoryTransfer(path.join(root, 'source-staging'), storage);
  const target = createNativeHistoryTransfer(path.join(root, 'target-staging'), storage);
  const manifest: NativeHistoryManifest = { kind: 'codex', nativeId, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { bytes, sourceFile, targetFile, source, target, restore, manifest };
}

describe('native history transfer', () => {
  it('streams every byte across multiple chunks, keeps the source, and cleans staging', async () => {
    const h = setup(Buffer.from('原生上下文\n'.repeat(NATIVE_HISTORY_CHUNK_BYTES / 4)));
    await fs.writeFile(h.sourceFile, h.bytes);
    const result = await transferNativeHistory(
      command => h.source('owner:task', command, root, () => {}),
      command => h.target('owner:task', command, root, () => {}), 'codex', nativeId, () => {},
    );
    expect(result).toBe('22222222-2222-4222-8222-222222222222');
    expect((await fs.readFile(h.targetFile)).equals(h.bytes)).toBe(true);
    expect((await fs.readFile(h.sourceFile)).equals(h.bytes)).toBe(true);
    expect(await fs.readdir(path.join(root, 'source-staging'))).toEqual([]);
    expect(await fs.readdir(path.join(root, 'target-staging'))).toEqual([]);
  });

  it('does not publish partial or corrupted history', async () => {
    const h = setup(Buffer.from('original'));
    const { id } = await h.target('scope', { action: 'import', manifest: h.manifest }, root, () => {}) as { id: string };
    await expect(h.target('scope', { action: 'restore', id }, root, () => {})).rejects.toThrow('NATIVE_HISTORY_INCOMPLETE');
    await expect(h.target('scope', { action: 'write', id, offset: 2, data: Buffer.from('bad').toString('base64') }, root, () => {})).rejects.toThrow('REMOTE_AGENT_INVALID');
    await h.target('scope', { action: 'write', id, offset: 0, data: Buffer.from('corrupt!').toString('base64') }, root, () => {});
    await expect(h.target('scope', { action: 'restore', id }, root, () => {})).rejects.toThrow('NATIVE_HISTORY_INCOMPLETE');
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('counts exports still being created and releases capacity after failed creation', async () => {
    const h = setup();
    await fs.writeFile(h.sourceFile, h.bytes);
    let entered = 0;
    let allEntered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { allEntered = resolve; });
    const endpoint = createNativeHistoryTransfer(path.join(root, 'concurrent'), {
      locate: async () => {
        if (++entered === 16) allEntered();
        await pending;
        throw new Error('snapshot failed');
      },
      restore: h.restore,
    });
    const attempts = Array.from({ length: 16 }, () => endpoint('scope', { action: 'export', kind: 'codex', nativeId }, root, () => {}));
    const settled = Promise.allSettled(attempts);
    try {
      await ready;
      await expect(endpoint('scope', { action: 'import', manifest: h.manifest }, root, () => {})).rejects.toThrow('REMOTE_AGENT_BUSY');
    } finally { release(); }
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    const receipts = await Promise.all(Array.from({ length: 16 }, () => endpoint('scope', { action: 'import', manifest: h.manifest }, root, () => {}))) as Array<{ id: string }>;
    await Promise.all(receipts.map(({ id }) => endpoint('scope', { action: 'release', id }, root, () => {})));
  });

  it('binds handles to the original task and owner generation', async () => {
    const h = setup();
    let current = true;
    const assertOwner = () => { if (!current) throw new Error('owner changed'); };
    const { id } = await h.target('scope', { action: 'import', manifest: h.manifest }, root, assertOwner) as { id: string };
    await expect(h.target('other-task', { action: 'release', id }, root, () => {})).rejects.toThrow('REMOTE_AGENT_NOT_FOUND');
    current = false;
    await expect(h.target('scope', { action: 'restore', id }, root, () => {})).rejects.toThrow('owner changed');
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('cancellation after a chunk leaves the original intact and never restores a partial session', async () => {
    const h = setup(Buffer.alloc(NATIVE_HISTORY_CHUNK_BYTES + 10, 97));
    await fs.writeFile(h.sourceFile, h.bytes);
    let cancelled = false;
    await expect(transferNativeHistory(
      command => h.source('scope', command, root, () => {}),
      async command => {
        const result = await h.target('scope', command, root, () => {});
        if (command.action === 'write') cancelled = true;
        return result;
      }, 'codex', nativeId, () => { if (cancelled) throw new Error('cancelled'); },
    )).rejects.toThrow('cancelled');
    expect(h.restore).not.toHaveBeenCalled();
    expect((await fs.readFile(h.sourceFile)).equals(h.bytes)).toBe(true);
    expect(await fs.readdir(path.join(root, 'target-staging'))).toEqual([]);
  });

  it('does not let an incoming Codex manifest inject other threads', async () => {
    const h = setup();
    await expect(h.target('scope', { action: 'import', manifest: {
      ...h.manifest, state: { threads: [{ id: 'another-thread' }], threadDynamicTools: [], threadSpawnEdges: [] },
    } }, root, () => {})).rejects.toThrow('REMOTE_AGENT_INVALID');
  });
});

it('only advertises and accepts native transfer for same-account callers', async () => {
  const nativeHistory = vi.fn(async () => ({ ok: true }));
  const host = createRemoteAgentHost({
    nativeHistory, isAgentAvailable: () => true, startHosted: vi.fn(),
    isControllerAuthorized: () => true, controllerTrust: controller => controller === 'guest' ? 'guest' : 'owner',
    captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: root,
  });
  try {
    expect(await host.handle('owner-device', { op: 'caps' })).toMatchObject({ nativeHistoryTransfer: true });
    expect(await host.handle('guest', { op: 'caps' })).not.toHaveProperty('nativeHistoryTransfer');
    await expect(host.handle('guest', { op: 'native-history', sessionId: 'task', command: { action: 'export', kind: 'codex', nativeId } })).rejects.toThrow('REMOTE_AGENT_UNSUPPORTED');
    expect(nativeHistory).not.toHaveBeenCalled();
    await host.handle('owner-device', { op: 'native-history', sessionId: 'task', command: { action: 'export', kind: 'codex', nativeId } });
    expect(nativeHistory).toHaveBeenCalledOnce();
  } finally { host.dispose(); }
});
