import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { XdtHelperToolRegistry } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry.js';
import { registerSessionShareTools } from '../../../../../../packages/lizi-mcps/src/xdt-helper/session_share.js';
import { createSessionShareToolCallbacks } from '../sessionShareTools.js';
import { writeNewSaveFile } from '../../cindy-brain/dirDeposit.js';

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
  beforeEach(async () => {
    current = true; directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-share-tools-test-'));
    await fs.writeFile(path.join(directory, 'source.cshare'), 'package');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  function fixture() {
    const assertCurrent = () => { if (!current) throw new Error('PERMISSION_DENIED'); };
    const handoff = { import: vi.fn(async () => [{ ref, name: 'task.cshare', size: 7, sha256: 'a'.repeat(64) }]),
      open: vi.fn(async () => ({ file: await fs.open(path.join(directory, 'source.cshare'), 'r'),
        filePath: path.join(directory, 'source.cshare'), info: { size: 7, sha256: createHash('sha256').update('package').digest('hex') } })),
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
      presetExportDestination: vi.fn(async (): Promise<{ directory: string; fileName: string } | null> => null),
      writeExportFile: vi.fn((directory: string, fileName: string, bytes: Uint8Array, assertCurrent: () => void) =>
        writeNewSaveFile(directory, fileName, bytes, { assertCurrent, exactCase: true })),
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
    expect(f.ports.presetExportDestination).not.toHaveBeenCalled();
    const exportedPath = f.ports.exportShare.mock.calls[0][0].targetPath;
    await expect(fs.stat(exportedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.callbacks.import({ attachmentRef: ref, overwrite: false, useWorktree: false }, plugin))
      .toMatchObject({ ok: true, status: 'imported', session_id: 'imported' });
    expect(f.ports.inspectShare).toHaveBeenCalledWith(path.join(directory, 'source.cshare'), Buffer.from('package'));
  });
  // Unit regression for #9979: the public schema must reject caller-selected
  // export paths; only a location chosen through the native dialog reaches the
  // packer. Existing native roundtrips do not cover this MCP-to-Host boundary.
  it('rejects an Agent-provided export path and uses the native save dialog', async () => {
    const f = fixture(), context = { agentKind: 'codex', sessionId: 'caller', workingDir: directory };
    const registry = new XdtHelperToolRegistry();
    registerSessionShareTools(registry, { callbacks: f.callbacks, getSessionContext: () => context });
    const supplied = path.join(directory, 'agent-selected.cshare');
    const rejected = (await registry.call('export_session', { session_id: 'task', output_path: supplied })).content[0];
    expect(rejected.type).toBe('text');
    if (rejected.type === 'text') expect(JSON.parse(rejected.text)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(f.ports.chooseExportPath).not.toHaveBeenCalled();
    expect(f.ports.exportShare).not.toHaveBeenCalled();
    const exported = (await registry.call('export_session', { session_id: 'task', exclude_media: true })).content[0];
    expect(exported.type).toBe('text');
    if (exported.type === 'text') expect(JSON.parse(exported.text))
      .toMatchObject({ ok: true, file_path: path.join(directory, 'chosen.cshare') });
    expect(f.ports.chooseExportPath).toHaveBeenCalledWith('task');
    expect(await fs.readFile(path.join(directory, 'chosen.cshare'), 'utf8')).toBe('package');
    await expect(fs.stat(supplied)).rejects.toMatchObject({ code: 'ENOENT' });
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
  it('rejects a same-size edited handoff before the native importer reads it', async () => {
    const f = fixture();
    await fs.writeFile(path.join(directory, 'source.cshare'), 'changed');
    expect(await f.callbacks.import({ attachmentRef: ref, overwrite: false, useWorktree: false }, plugin))
      .toMatchObject({ ok: false, errorCode: 'HANDOFF_UNAVAILABLE' });
    expect(f.ports.inspectShare).not.toHaveBeenCalled();
    expect(f.ports.commitShare).not.toHaveBeenCalled();
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
  it('rejects plugin import paths and SSH filesystem calls even at the Host callback boundary', async () => {
    const f = fixture();
    expect(await f.callbacks.import({ filePath: '/private/import', overwrite: false, useWorktree: false }, plugin)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await f.callbacks.import({ filePath: 'task.cshare', overwrite: false, useWorktree: false },
      { agentKind: 'codex', workingDir: directory, sessionId: 'caller', remoteHostId: 'ssh' })).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(f.ports.exportShare).not.toHaveBeenCalled();
    expect(f.ports.inspectShare).not.toHaveBeenCalled();
  });
  // Unit, #11480: with an owner-chosen Settings folder, repeated Agent exports
  // finish unattended and return paths, never overwrite an existing package,
  // and the packer never writes into that folder directly (#9979). The dialog
  // test above does not cover this branch. Minimum input: one existing
  // same-named file and two exports.
  it('saves Agent exports into the Settings folder without the dialog or overwriting', async () => {
    const f = fixture(), context = { agentKind: 'codex', sessionId: 'caller', workingDir: directory };
    await fs.mkdir(path.join(directory, 'exports'));
    const exports = await fs.realpath(path.join(directory, 'exports'));
    await fs.writeFile(path.join(exports, 'Task.cshare'), 'earlier');
    f.ports.presetExportDestination.mockResolvedValue({ directory: exports, fileName: 'Task.cshare' });
    const registry = new XdtHelperToolRegistry();
    registerSessionShareTools(registry, { callbacks: f.callbacks, getSessionContext: () => context });
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      const content = (await registry.call('export_session', { session_id: 'task' })).content[0];
      expect(content.type).toBe('text');
      if (content.type === 'text') paths.push(JSON.parse(content.text).file_path);
    }
    expect(paths).toEqual([path.join(exports, 'Task (1).cshare'), path.join(exports, 'Task (2).cshare')]);
    expect(await fs.readFile(path.join(exports, 'Task.cshare'), 'utf8')).toBe('earlier');
    for (const written of paths) expect(await fs.readFile(written, 'utf8')).toBe('package');
    expect(f.ports.chooseExportPath).not.toHaveBeenCalled();
    for (const [{ targetPath }] of f.ports.exportShare.mock.calls) {
      expect(path.dirname(targetPath)).not.toBe(exports);
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  // Unit, #11480: a set but missing folder must fail clearly instead of
  // silently falling back to a dialog nobody is there to answer.
  it('reports an unavailable Settings folder without packing or opening the dialog', async () => {
    const f = fixture();
    f.ports.presetExportDestination.mockRejectedValueOnce(new Error('EXPORT_DIRECTORY_UNAVAILABLE'));
    expect(await f.callbacks.export({ sessionId: 'task', excludeMedia: false }, { agentKind: 'codex', sessionId: 'caller', workingDir: directory }))
      .toMatchObject({ ok: false, errorCode: 'EXPORT_DIRECTORY_UNAVAILABLE' });
    expect(f.ports.exportShare).not.toHaveBeenCalled();
    expect(f.ports.chooseExportPath).not.toHaveBeenCalled();
  });
  // Unit, #12461 review: an approved folder (or an ancestor) later replaced by a
  // symlink / Windows junction must not redirect the export to the new target.
  // Minimum input: approve a real folder, then swap that path for a link.
  it('refuses a Settings folder that now resolves somewhere else', async () => {
    const f = fixture(), context = { agentKind: 'codex', sessionId: 'caller', workingDir: directory };
    await fs.mkdir(path.join(directory, 'approved'));
    const approved = await fs.realpath(path.join(directory, 'approved'));
    const elsewhere = path.join(directory, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.rename(approved, path.join(directory, 'approved-old'));
    await fs.symlink(elsewhere, approved, 'junction');
    f.ports.presetExportDestination.mockResolvedValue({ directory: approved, fileName: 'Task.cshare' });
    expect(await f.callbacks.export({ sessionId: 'task', excludeMedia: false }, context))
      .toMatchObject({ ok: false, errorCode: 'EXPORT_DIRECTORY_UNAVAILABLE' });
    expect(f.ports.exportShare).not.toHaveBeenCalled();
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
  // Unit, #12461 review: losing the caller (sign-out, account switch, revoked
  // task action) while the Settings-folder write is pending must not report
  // success or leave the package behind.
  it('removes the Settings-folder package and fails when the caller is revoked during the write', async () => {
    const f = fixture(), context = { agentKind: 'codex', sessionId: 'caller', workingDir: directory };
    await fs.mkdir(path.join(directory, 'exports'));
    const exports = await fs.realpath(path.join(directory, 'exports'));
    f.ports.presetExportDestination.mockResolvedValue({ directory: exports, fileName: 'Task.cshare' });
    f.ports.writeExportFile.mockImplementationOnce(async (dir, name, bytes, assertCurrent) => {
      current = false;
      return writeNewSaveFile(dir, name, bytes, { assertCurrent, exactCase: true });
    });
    expect(await f.callbacks.export({ sessionId: 'task', excludeMedia: false }, context))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(await fs.readdir(exports)).toEqual([]);
  });
});
