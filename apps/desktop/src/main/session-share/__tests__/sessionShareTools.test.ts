import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionShareToolCallbacks } from '../sessionShareTools.js';

// Unit, capability list #10/#15 and plugin authoring §4: a native export must
// stay in its caller's existing handoff storage. Existing package roundtrips
// do not cover the Agent/plugin caller boundary or pending native UI results.
// Minimum inputs: one local task and one instance-bound reference. No engines,
// Electron, network or real account data are loaded.
describe('native package Host tools', () => {
  let directory: string;
  let current = true;
  const plugin = { agentKind: 'codex', workingDir: '', hostCaller: {
    kind: 'plugin' as const, pluginId: 'installed', dataOwnerId: 'owner', ownerGeneration: 1,
  } };
  const ref = 'handoff:00000000-0000-4000-8000-000000000000';
  const preview = { title: 'Task', agentKind: 'codex' as const, workspaceKind: 'dialogue' as const,
    originalWorkingDir: null, exportedAt: '', appVersion: '', fidelity: 'full' as const,
    messageCount: 1, mediaCount: 0, orcaWorkerCount: 0 };
  beforeEach(async () => { current = true; directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-share-tools-test-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  function fixture() {
    const assertCurrent = () => { if (!current) throw new Error('PERMISSION_DENIED'); };
    const handoff = { import: vi.fn(async () => [{ ref, name: 'task.cshare', size: 7, sha256: 'a'.repeat(64) }]),
      open: vi.fn(async () => ({ file: { close: vi.fn(async () => {}) }, filePath: path.join(directory, 'source.cshare') })),
      touch: vi.fn(async () => {}) };
    const ports = {
      capture: vi.fn(async (context: typeof plugin | { sessionId?: string }) => ({ assertCurrent,
        pluginId: 'hostCaller' in context ? 'installed' : undefined })),
      exportShare: vi.fn(async (options: { targetPath: string; sessionId: string }) => {
        await fs.writeFile(options.targetPath, 'package');
        return { status: 'ok' as const, unpackedBytes: 7, filePath: options.targetPath, fidelity: 'full' as const,
          missingTranscripts: [], mediaMissing: 0, mediaDropped: 0, orcaWorkers: 0 };
      }),
      inspectShare: vi.fn(async () => ({ draftId: 'draft', encrypted: false as const, preview })),
      commitShare: vi.fn(async () => ({ sessionId: 'imported', fidelity: 'full' as const, notes: [], orcaWorkers: 0 })),
      cancelDraft: vi.fn(), chooseExportPath: vi.fn(async () => path.join(directory, 'chosen.cshare')),
      openImportWizard: vi.fn(), handoff: () => handoff,
    };
    return { ports, handoff, callbacks: createSessionShareToolCallbacks(ports) };
  }
  it('exports through the original packer into this plugin’s handoff without returning a host path', async () => {
    const f = fixture();
    const result = await f.callbacks.export({ sessionId: 'task', excludeMedia: false }, plugin);
    expect(result).toMatchObject({ ok: true, scope: 'local', status: 'ok', attachment_ref: ref, fidelity: 'full' });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain('filePath');
    expect(f.handoff.import).toHaveBeenCalledWith('installed', [{ name: 'task.cshare', bytes: Buffer.from('package') }], expect.any(Function));
    expect(f.ports.chooseExportPath).not.toHaveBeenCalled();
    const exportedPath = f.ports.exportShare.mock.calls[0][0].targetPath;
    await expect(fs.stat(exportedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps Agent filesystem paths on the existing native path', async () => {
    const f = fixture(), context = { agentKind: 'codex', sessionId: 'caller', workingDir: directory };
    expect(await f.callbacks.export({ sessionId: 'task', excludeMedia: true }, context))
      .toMatchObject({ ok: true, file_path: path.join(directory, 'chosen.cshare') });
    expect(await f.callbacks.import({ filePath: 'source.cshare', overwrite: false, useWorktree: false }, context))
      .toMatchObject({ ok: true, status: 'imported', session_id: 'imported' });
    expect(f.ports.inspectShare).toHaveBeenCalledWith(path.join(directory, 'source.cshare'));
    expect(f.ports.commitShare).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft', overwrite: false }), expect.any(Function));
    expect(f.handoff.import).not.toHaveBeenCalled();
    expect(f.handoff.open).not.toHaveBeenCalled();
  });
  it('rejects expired or foreign handoff references before inspecting any file', async () => {
    const f = fixture(); f.handoff.open.mockResolvedValueOnce(null as never);
    expect(await f.callbacks.import({ attachmentRef: ref, overwrite: false, useWorktree: false }, plugin))
      .toMatchObject({ ok: false, errorCode: 'HANDOFF_UNAVAILABLE' });
    expect(f.handoff.open).toHaveBeenCalledWith('installed', ref);
    expect(f.ports.inspectShare).not.toHaveBeenCalled();
    expect(f.ports.commitShare).not.toHaveBeenCalled();
  });
  it('preserves the native conflict result without leaking its source path or retrying an overwrite', async () => {
    const f = fixture();
    f.ports.commitShare.mockRejectedValueOnce(Object.assign(new Error(path.join(directory, 'private.cshare')), { code: 'SHARE_CONFLICT' }));
    const result = await f.callbacks.import({ attachmentRef: ref, overwrite: false, useWorktree: false }, plugin);
    expect(result).toMatchObject({ ok: false, errorCode: 'SHARE_CONFLICT' });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(f.ports.commitShare).toHaveBeenCalledOnce();
  });
  it.each(['password', 'project'] as const)('opens the existing wizard for %s and never reports import completion', async reason => {
    const f = fixture();
    f.ports.inspectShare.mockResolvedValueOnce(reason === 'password'
      ? { draftId: 'draft', encrypted: true } as never
      : { draftId: 'draft', encrypted: false, preview: { ...preview, workspaceKind: 'project' } } as never);
    expect(await f.callbacks.import({ attachmentRef: ref, overwrite: false, useWorktree: false }, plugin))
      .toMatchObject({ ok: true, status: 'awaiting_user' });
    expect(f.ports.openImportWizard).toHaveBeenCalledWith(path.join(directory, 'source.cshare'));
    expect(f.ports.commitShare).not.toHaveBeenCalled();
    expect(f.ports.cancelDraft).toHaveBeenCalledWith('draft');
  });
  it('discards an export if the caller is revoked while packing', async () => {
    const f = fixture(); f.ports.exportShare.mockImplementationOnce(async options => {
      await fs.writeFile(options.targetPath, 'package'); current = false;
      return { status: 'ok', unpackedBytes: 7, filePath: options.targetPath, fidelity: 'full', missingTranscripts: [], mediaMissing: 0, mediaDropped: 0, orcaWorkers: 0 };
    });
    expect(await f.callbacks.export({ sessionId: 'task', excludeMedia: false }, plugin))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(f.handoff.import).not.toHaveBeenCalled();
    await expect(fs.stat(f.ports.exportShare.mock.calls[0][0].targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects plugin paths and SSH filesystem calls even at the Host callback boundary', async () => {
    const f = fixture();
    expect(await f.callbacks.export({ sessionId: 'task', outputPath: '/private/export', excludeMedia: false }, plugin)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await f.callbacks.import({ filePath: '/private/import', overwrite: false, useWorktree: false }, plugin)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await f.callbacks.import({ filePath: 'task.cshare', overwrite: false, useWorktree: false },
      { agentKind: 'codex', workingDir: directory, sessionId: 'caller', remoteHostId: 'ssh' })).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(f.ports.exportShare).not.toHaveBeenCalled();
    expect(f.ports.inspectShare).not.toHaveBeenCalled();
  });
});
