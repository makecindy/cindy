import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { removeMergeWorktreeResidue } from '../mergeCleanupResidue';

const fs = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
}));
vi.mock('original-fs', () => ({ default: { promises: fs } }));

const root = path.resolve('test-profile', 'merge-worktrees', 'candidate');
const modules = path.join(root, 'node_modules');
const link = path.join(modules, 'dependency');
const nodes = new Map<string, { kind: 'directory' | 'link' | 'file'; ino: number }>();
let nextInode = 1;
const add = (target: string, kind: 'directory' | 'link' | 'file') =>
  nodes.set(target, { kind, ino: nextInode++ });
const children = (target: string) =>
  [...nodes.keys()].filter((entry) => entry !== target && path.dirname(entry) === target);
beforeEach(() => {
  vi.resetAllMocks();
  nodes.clear();
  add(root, 'directory');
  add(modules, 'directory');
  add(link, 'link');
  fs.realpath.mockImplementation(async (target: string) => target);
  fs.readdir.mockImplementation(async (target: string) =>
    children(target).map((p) => path.basename(p)),
  );
  fs.lstat.mockImplementation(async (target: string) => {
    const node = nodes.get(target);
    if (!node) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return {
      dev: 1,
      ino: node.ino,
      isDirectory: () => node.kind === 'directory',
      isSymbolicLink: () => node.kind === 'link',
    };
  });
  fs.unlink.mockImplementation(async (target: string) => {
    nodes.delete(target);
  });
  fs.rmdir.mockImplementation(async (target: string) => {
    if (children(target).length) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
    nodes.delete(target);
  });
});

it('unlinks dependency links without traversing their targets and removes empty parents', async () => {
  expect(await removeMergeWorktreeResidue(root, () => true)).toBe(true);
  expect(nodes.size).toBe(0);
  expect(fs.unlink).toHaveBeenCalledExactlyOnceWith(link);
  expect(fs.readdir).not.toHaveBeenCalledWith(link);
  expect(fs.realpath).not.toHaveBeenCalledWith(link);
});

it.each(['keep.txt', path.join('node_modules', 'keep.txt'), '.git'])(
  'preserves residue containing %s',
  async (name) => {
    add(path.join(root, name), 'file');
    expect(await removeMergeWorktreeResidue(root, () => true)).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.rmdir).not.toHaveBeenCalled();
  },
);

it.each(['root-link', 'parent-junction', 'source-link'])(
  'rejects a substituted path: %s',
  async (kind) => {
    if (kind === 'root-link') add(root, 'link');
    if (kind === 'parent-junction') fs.realpath.mockResolvedValue(path.resolve('outside-profile'));
    if (kind === 'source-link') add(path.join(root, 'user-link'), 'link');
    expect(await removeMergeWorktreeResidue(root, () => true)).toBe(false);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.rmdir).not.toHaveBeenCalled();
  },
);

it('stops after ownership changes during deletion and permits a later authorized retry', async () => {
  let current = true;
  fs.unlink.mockImplementation(async (target: string) => {
    nodes.delete(target);
    current = false;
  });
  expect(await removeMergeWorktreeResidue(root, () => current)).toBe(false);
  expect(nodes.has(root)).toBe(true);
  expect(fs.rmdir).not.toHaveBeenCalled();
  expect(await removeMergeWorktreeResidue(root, () => true)).toBe(true);
});

it('preserves new files written after inspection instead of recursively deleting them', async () => {
  const added = path.join(modules, 'new-work.txt');
  fs.unlink.mockImplementation(async (target: string) => {
    nodes.delete(target);
    add(added, 'file');
  });
  await expect(removeMergeWorktreeResidue(root, () => true)).rejects.toMatchObject({
    code: 'ENOTEMPTY',
  });
  expect(nodes.has(added)).toBe(true);
  expect(nodes.has(root)).toBe(true);
});

it('preserves a replacement path installed while cleanup was inspecting the parent', async () => {
  const original = fs.realpath.getMockImplementation()!;
  fs.realpath.mockImplementation(async (target: string) => {
    if (target === modules && fs.readdir.mock.calls.some(([dir]) => dir === modules))
      add(link, 'link');
    return original(target);
  });
  expect(await removeMergeWorktreeResidue(root, () => true)).toBe(false);
  expect(nodes.has(link)).toBe(true);
  expect(fs.unlink).not.toHaveBeenCalled();
});
