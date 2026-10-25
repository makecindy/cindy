/**
 * PR #6551: folder copies use ordinary attachment ownership, not a folder job registry.
 * Production pack/extract + common file store, with native temp files and no network.
 * Existing archive tests do not cover draft discard, rejected sends or task deletion.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Header, type HeaderData } from 'tar';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
import {
  extractChatFolder,
  uploadChatFolder,
  type FolderUploadDeps,
} from '../chat-folder-transfer';
import {
  stageLocalFileToCache,
  cleanupOwnedUnpersistedStagedChatAttachments,
} from '../remote-file-cache';
import * as attachments from '../../imageCacheStore';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-folder-test-'));
});
afterEach(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});

async function fixture() {
  const source = path.join(state.root, 'source', '资料');
  await fs.mkdir(path.join(source, 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'note.txt'), 'folder contents');
  await fs.writeFile(path.join(source, '.hidden'), 'hidden contents');
  const deps: FolderUploadDeps = {
    tempRoot: () => state.root,
    assertCurrent: () => {},
    op: async <T>() => ({ folderAttachment: true }) as T,
    stage: (params) => stageLocalFileToCache({ ...params, ownerId: 'owner-a' }),
    discard: (filePath) =>
      cleanupOwnedUnpersistedStagedChatAttachments({
        ownerId: 'owner-a',
        filePaths: [filePath],
      }),
  };
  const prepare = () =>
    uploadChatFolder(
      { deviceId: 'target', sourcePath: source, requestId: 'r' },
      deps,
      vi.fn(),
      new AbortController().signal,
    );
  return { source, deps, prepare };
}

it.each(['reject', 'delete-task'] as const)(
  'reclaims the extracted folder with its ordinary attachment on %s',
  async (action) => {
    const { source, prepare } = await fixture();
    const staged = await prepare();
    const { url } = await attachments.copyFromPath({
      sessionId: 'target-task',
      sourcePath: staged.path,
      originalName: '资料.tar',
      lifecycle: 'committed',
    });
    const dest = await extractChatFolder(attachments.resolveSafe(url).absPath);
    expect(await fs.readFile(path.join(dest, 'note.txt'), 'utf8')).toBe('folder contents');
    expect(await fs.readFile(path.join(dest, '.hidden'), 'utf8')).toBe('hidden contents');
    expect((await fs.stat(path.join(dest, 'empty'))).isDirectory()).toBe(true);
    if (action === 'reject') await attachments.removeFile(url);
    else await attachments.removeSession('target-task');
    await expect(fs.stat(dest)).rejects.toThrow();
    expect(await fs.readFile(path.join(source, 'note.txt'), 'utf8')).toBe('folder contents');
  },
);

it('holds a local draft until normal draft discard; never creates an unclaimed receiver folder', async () => {
  const { prepare, deps } = await fixture();
  const staged = await prepare();
  expect(staged.size).toBeGreaterThan(0);
  expect(staged.path.endsWith('.bin')).toBe(true);
  await expect(fs.stat(attachments.getSessionDir('target-task'))).rejects.toThrow();
  await deps.discard(staged.path);
  await expect(fs.stat(staged.path)).rejects.toThrow();
});

it('old peers fail before staging any bytes', async () => {
  const { deps, prepare } = await fixture();
  deps.op = async <T>() => ({}) as T;
  const stage = vi.spyOn(deps, 'stage');
  await expect(prepare()).rejects.toThrow('REMOTE_UNSUPPORTED');
  expect(stage).not.toHaveBeenCalled();
});

it('does not pack its own scratch directory', async () => {
  const { source, deps, prepare } = await fixture();
  deps.tempRoot = () => source;
  const staged = await prepare();
  const dest = await extractChatFolder(staged.path);
  expect((await fs.readdir(dest)).sort()).toEqual(['.hidden', 'empty', 'note.txt']);
});

it('cancellation after staging discards the draft copy and preserves the source', async () => {
  const { source, deps } = await fixture();
  const controller = new AbortController();
  const stage = deps.stage;
  let staged = '';
  deps.stage = async (params) => {
    staged = await stage(params);
    controller.abort();
    return staged;
  };
  await expect(
    uploadChatFolder(
      { deviceId: 'target', sourcePath: source, requestId: 'r' },
      deps,
      vi.fn(),
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(fs.stat(staged)).rejects.toThrow();
  expect((await fs.stat(source)).isDirectory()).toBe(true);
  expect(
    (await fs.readdir(state.root)).some((name) => name.startsWith('cindy-folder-upload-')),
  ).toBe(false);
});

it('removes a partial extraction when the archive is corrupt', async () => {
  const archive = path.join(state.root, 'bad.bin');
  await fs.writeFile(archive, 'not a tar archive');
  await expect(extractChatFolder(archive)).rejects.toThrow();
  await expect(fs.stat(`${archive}.contents`)).rejects.toThrow();
});

// Write tar headers directly so hostile targets can be tested even when the
// machine cannot create symlinks (for example an unprivileged Windows runner).
async function linkArchive(entries: HeaderData[]) {
  const archive = path.join(state.root, 'links.tar');
  const blocks = entries.map((entry) => {
    const block = Buffer.alloc(512);
    new Header({ size: 0, mode: 0o755, ...entry }).encode(block);
    return block;
  });
  await fs.writeFile(archive, Buffer.concat([...blocks, Buffer.alloc(1024)]));
  return archive;
}

it.each([
  ['absolute', '/outside/private'],
  ['relative escape', '../../private'],
  ['Windows drive', 'C:\\private'],
  ['Windows UNC', '\\\\server\\share\\private'],
  ['dangling', 'missing'],
])('rejects a %s symlink and removes the partial chat attachment', async (_kind, target) => {
  const archive = await linkArchive([{ path: 'link', type: 'SymbolicLink', linkpath: target }]);
  await expect(extractChatFolder(archive)).rejects.toThrow('INCOMPLETE_FOLDER');
  await expect(fs.lstat(`${archive}.contents`)).rejects.toThrow();
});

it('rejects a symlink chain that escapes after resolving an intermediate directory', async () => {
  await fs.mkdir(path.join(state.root, 'private'));
  const archive = await linkArchive([
    { path: 'sub/', type: 'Directory' },
    { path: 'sub/up', type: 'SymbolicLink', linkpath: '..' },
    // Lexically inside the attachment; resolving "up" makes it escape.
    { path: 'escape', type: 'SymbolicLink', linkpath: 'sub/up/../private' },
  ]);
  await expect(extractChatFolder(archive)).rejects.toThrow('INCOMPLETE_FOLDER');
  await expect(fs.lstat(`${archive}.contents`)).rejects.toThrow();
  expect((await fs.stat(path.join(state.root, 'private'))).isDirectory()).toBe(true);
});

it('keeps in-tree relative symlink chains usable', async (context) => {
  try {
    await fs.symlink('.', path.join(state.root, 'symlink-probe'), 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
    context.skip();
    return;
  }
  const archive = await linkArchive([
    { path: 'Versions/', type: 'Directory' },
    { path: 'Versions/A/', type: 'Directory' },
    { path: 'Versions/A/file', type: 'File' },
    { path: 'file', type: 'SymbolicLink', linkpath: 'Versions/Current/file' },
    { path: 'Versions/Current', type: 'SymbolicLink', linkpath: 'A' },
  ]);
  const dest = await extractChatFolder(archive);
  expect(await fs.realpath(path.join(dest, 'file'))).toBe(
    path.join(await fs.realpath(dest), 'Versions', 'A', 'file'),
  );
});
