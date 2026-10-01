/**
 * libraryBinding 单测:绑定/撤销/漂移三分支(disk-missing / binding-moved)、
 * 候选位置校验(受管根排斥/UNC 拒/云盘警告/可写探针)、损坏文件回落默认。
 * 注入 deps + os.tmpdir,零 Electron。identity 用例带平台能力探针。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LibraryBindingStore, assertLibraryMetaOwner, relocateLibraryMetaOwner, validateLibraryCandidateLocation, type LibraryBindingDeps } from '../libraryBinding.js';

const GHOST_ID = 'mivo-canvas';

describe('LibraryBindingStore', () => {
  let tmp: string;
  let bindingFile: string;
  let candidate: string;
  let managedRoot: string;
  let defaultRootBase: string;
  let deps: LibraryBindingDeps;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-binding-'));
    bindingFile = path.join(tmp, 'owners', 'k1', 'libraries-binding.json');
    candidate = path.join(tmp, 'picked-parent');
    managedRoot = path.join(tmp, 'managed');
    defaultRootBase = path.join(tmp, 'owners', 'k1', 'libraries');
    await fs.promises.mkdir(candidate, { recursive: true });
    await fs.promises.mkdir(managedRoot, { recursive: true });
    deps = {
      getFile: () => bindingFile,
      getManagedRoots: () => [managedRoot],
      getDefaultRoot: (ghostId) => path.join(defaultRootBase, ghostId),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  async function interruptRelocation(stage: 'before-folder' | 'folder' | 'binding'): Promise<void> {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    await fs.promises.mkdir(path.join(candidate, 'hello'));
    await fs.promises.writeFile(path.join(candidate, 'hello', 'keep.txt'), 'original');
    const rename = fs.promises.rename.bind(fs.promises);
    let bindingWrites = 0;
    const interrupted = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (stage === 'before-folder' && path.basename(String(to)) === '_ns__acme__hello') {
        throw new Error('simulated process interruption');
      }
      await rename(from, to);
      if (to === bindingFile) bindingWrites += 1;
      if ((stage === 'folder' && path.basename(String(to)) === '_ns__acme__hello') ||
          (stage === 'binding' && to === bindingFile && bindingWrites === 2)) {
        throw new Error('simulated process interruption');
      }
    });
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('interruption');
    interrupted.mockRestore();
  }

  it('recovers a durable custom relocation after rename but before binding commit', async () => {
    await interruptRelocation('folder');
    const restarted = new LibraryBindingStore(deps);
    await expect(restarted.assertCanRelocateBinding('hello', '_ns__acme__hello')).resolves.toBeUndefined();
    await restarted.relocateBinding('hello', '_ns__acme__hello');
    expect(await restarted.getBinding('hello')).toBeNull();
    expect((await restarted.getBinding('_ns__acme__hello'))?.generation).toBe(1);
    expect(await fs.promises.readFile(path.join(candidate, '_ns__acme__hello', 'keep.txt'), 'utf8')).toBe('original');
    expect(JSON.parse(await fs.promises.readFile(bindingFile, 'utf8')).pendingRelocation).toBeUndefined();
  });

  it('recovers binding committed before marker cleanup and supports reverse rollback', async () => {
    await interruptRelocation('binding');
    const interrupted = JSON.parse(await fs.promises.readFile(bindingFile, 'utf8'));
    expect(interrupted.bindings.hello).toBeUndefined();
    expect(interrupted.bindings._ns__acme__hello.generation).toBe(1);
    expect(interrupted.pendingRelocation).toBeDefined();
    const restarted = new LibraryBindingStore(deps);
    await restarted.relocateBinding('hello', '_ns__acme__hello');
    expect(await restarted.getBinding('hello')).toBeNull();
    expect((await restarted.getBinding('_ns__acme__hello'))?.generation).toBe(1);
    await restarted.relocateBinding('_ns__acme__hello', 'hello');
    expect((await restarted.getBinding('hello'))?.generation).toBe(1);
    expect(await restarted.getBinding('_ns__acme__hello')).toBeNull();
    expect(await fs.promises.readFile(path.join(candidate, 'hello', 'keep.txt'), 'utf8')).toBe('original');
  });

  it('supports reverse rollback directly from an interrupted forward rename', async () => {
    await interruptRelocation('folder');
    const restarted = new LibraryBindingStore(deps);
    await restarted.relocateBinding('_ns__acme__hello', 'hello');
    expect((await restarted.getBinding('hello'))?.generation).toBe(1);
    expect(await restarted.getBinding('_ns__acme__hello')).toBeNull();
    expect(await fs.promises.readFile(path.join(candidate, 'hello', 'keep.txt'), 'utf8')).toBe('original');
  });

  it('rejects a foreign target even with an unfinished relocation journal and retries after restoration', async () => {
    await interruptRelocation('folder');
    const target = path.join(candidate, '_ns__acme__hello');
    const original = path.join(candidate, 'saved-original');
    await fs.promises.rename(target, original);
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(path.join(target, 'foreign.txt'), 'foreign');
    const restarted = new LibraryBindingStore(deps);
    await expect(restarted.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('directory identity changed');
    await expect(restarted.getBinding('_ns__acme__hello')).rejects.toThrow('directory identity changed');
    expect(await fs.promises.readFile(path.join(target, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(JSON.parse(await fs.promises.readFile(bindingFile, 'utf8')).bindings.hello.generation).toBe(1);
    await fs.promises.rm(target, { recursive: true });
    await fs.promises.rename(original, target);
    await restarted.relocateBinding('hello', '_ns__acme__hello');
    expect(await fs.promises.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('rejects a changed parent identity without rewriting the binding or marker', async () => {
    await interruptRelocation('folder');
    const contents = await fs.promises.readFile(bindingFile, 'utf8');
    const saved = path.join(tmp, 'saved-parent');
    await fs.promises.rename(candidate, saved);
    await fs.promises.mkdir(candidate);
    const restarted = new LibraryBindingStore(deps);
    await expect(restarted.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('root identity changed');
    expect(await fs.promises.readFile(bindingFile, 'utf8')).toBe(contents);
    await fs.promises.rm(candidate, { recursive: true });
    await fs.promises.rename(saved, candidate);
    await restarted.relocateBinding('hello', '_ns__acme__hello');
    expect((await restarted.getBinding('_ns__acme__hello'))?.generation).toBe(1);
  });

  it('rejects a replaced source identity before a recorded rename', async () => {
    await interruptRelocation('before-folder');
    const source = path.join(candidate, 'hello');
    const original = path.join(candidate, 'saved-original');
    await fs.promises.rename(source, original);
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'foreign.txt'), 'foreign');
    const restarted = new LibraryBindingStore(deps);
    await expect(restarted.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('directory identity changed');
    expect(await fs.promises.readFile(path.join(source, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(fs.existsSync(path.join(candidate, '_ns__acme__hello'))).toBe(false);
    await fs.promises.rm(source, { recursive: true });
    await fs.promises.rename(original, source);
    await restarted.relocateBinding('hello', '_ns__acme__hello');
    expect(await fs.promises.readFile(path.join(candidate, '_ns__acme__hello', 'keep.txt'), 'utf8')).toBe('original');
  });

  it.each(['generation', 'owner', 'malformed', 'schema'] as const)('rejects %s journal drift', async (drift) => {
    await interruptRelocation('folder');
    const data = JSON.parse(await fs.promises.readFile(bindingFile, 'utf8'));
    if (drift === 'generation') data.bindings.hello.generation += 1;
    if (drift === 'owner') data.pendingRelocation.ownerFile = path.join(tmp, 'other-owner', 'libraries-binding.json');
    if (drift === 'malformed') data.pendingRelocation.libraryIdentity = { dev: 1, ino: 0 };
    if (drift === 'schema') data.version = 2;
    const contents = JSON.stringify(data);
    await fs.promises.writeFile(bindingFile, contents);
    await expect(new LibraryBindingStore(deps).relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      drift === 'generation' ? 'generation changed' : 'journal is invalid',
    );
    expect(await fs.promises.readFile(bindingFile, 'utf8')).toBe(contents);
    expect(await fs.promises.readFile(path.join(candidate, '_ns__acme__hello', 'keep.txt'), 'utf8')).toBe('original');
  });

  it('retains intent after a rename error and recovers only the recorded source', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    await fs.promises.mkdir(path.join(candidate, 'hello'));
    await fs.promises.writeFile(path.join(candidate, 'hello', 'keep.txt'), 'original');
    const rename = fs.promises.rename.bind(fs.promises);
    const failure = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === '_ns__acme__hello') throw new Error('rename unavailable');
      await rename(from, to);
    });
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('rename unavailable');
    failure.mockRestore();
    expect(JSON.parse(await fs.promises.readFile(bindingFile, 'utf8')).pendingRelocation).toBeDefined();
    const restarted = new LibraryBindingStore(deps);
    expect((await restarted.getBinding('_ns__acme__hello'))?.generation).toBe(1);
    expect(await fs.promises.readFile(path.join(candidate, '_ns__acme__hello', 'keep.txt'), 'utf8')).toBe('original');
  });

  it('rejects a symlink target rather than following the original directory identity', async () => {
    await interruptRelocation('folder');
    const target = path.join(candidate, '_ns__acme__hello');
    const original = path.join(candidate, 'saved-original');
    await fs.promises.rename(target, original);
    await fs.promises.symlink(original, target, 'junction');
    await expect(new LibraryBindingStore(deps).relocateBinding('hello', '_ns__acme__hello'))
      .rejects.toThrow('directory identity unavailable');
    expect(await fs.promises.readFile(path.join(original, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('does not recover an owner journal through a different owner-scoped binding file', async () => {
    await interruptRelocation('folder');
    const otherFile = path.join(tmp, 'owners', 'k2', 'libraries-binding.json');
    await fs.promises.mkdir(path.dirname(otherFile), { recursive: true });
    const contents = await fs.promises.readFile(bindingFile, 'utf8');
    await fs.promises.writeFile(otherFile, contents);
    const otherStore = new LibraryBindingStore({ ...deps, getFile: () => otherFile });
    await expect(otherStore.getBinding('_ns__acme__hello')).rejects.toThrow('journal is invalid');
    expect(await fs.promises.readFile(bindingFile, 'utf8')).toBe(contents);
    expect(await fs.promises.readFile(otherFile, 'utf8')).toBe(contents);
  });

  it('preserves a never-opened custom binding without creating a library directory', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    await store.relocateBinding('hello', '_ns__acme__hello');
    expect(await store.getBinding('hello')).toBeNull();
    expect(await store.getBinding('_ns__acme__hello')).toMatchObject({ generation: 1, libraryReady: false });
    expect(fs.existsSync(path.join(candidate, '_ns__acme__hello'))).toBe(false);
    await store.relocateBinding('_ns__acme__hello', 'hello');
    expect(await store.getBinding('hello')).toMatchObject({ generation: 1, libraryReady: false });
  });

  it('rejects a dangling foreign target before recording a relocation intent', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    const target = path.join(candidate, '_ns__acme__hello');
    await fs.promises.symlink(path.join(tmp, 'missing-foreign'), target, 'junction');
    await expect(store.assertCanRelocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('destination already exists');
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow('destination already exists');
    expect(JSON.parse(await fs.promises.readFile(bindingFile, 'utf8')).pendingRelocation).toBeUndefined();
    expect((await fs.promises.lstat(target)).isSymbolicLink()).toBe(true);
  });

  it('rejects an owner change while reading a pending relocation without touching either owner', async () => {
    await interruptRelocation('folder');
    const contents = await fs.promises.readFile(bindingFile, 'utf8');
    const originalFile = bindingFile;
    const readFile = fs.promises.readFile.bind(fs.promises);
    const changed = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      const value = await readFile(...args);
      bindingFile = path.join(tmp, 'owners', 'k2', 'libraries-binding.json');
      return value;
    });
    await expect(new LibraryBindingStore(deps).getBinding('_ns__acme__hello')).rejects.toThrow('owner changed');
    changed.mockRestore();
    expect(fs.existsSync(bindingFile)).toBe(false);
    bindingFile = originalFile;
    expect(await fs.promises.readFile(bindingFile, 'utf8')).toBe(contents);
  });

  it('moves a library owner exactly once without losing other metadata or reassigning another plugin', async () => {
    const root = path.join(defaultRootBase, 'hello');
    const file = path.join(root, '.cindy-library', 'meta.json');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, ghostId: 'hello', createdAt: 1, orphaned: { at: 2, name: 'old' } }));
    await expect(assertLibraryMetaOwner(root, 'other')).rejects.toThrow('different plugin');
    await expect(assertLibraryMetaOwner(root, 'hello')).resolves.toBeUndefined();
    expect(await relocateLibraryMetaOwner(root, 'hello', '_ns__acme__hello')).toBe(true);
    await expect(assertLibraryMetaOwner(root, '_ns__acme__hello')).resolves.toBeUndefined();
    expect(await relocateLibraryMetaOwner(root, 'hello', '_ns__acme__hello')).toBe(false);
    expect(JSON.parse(await fs.promises.readFile(file, 'utf8'))).toEqual({
      version: 1, ghostId: '_ns__acme__hello', createdAt: 1, orphaned: { at: 2, name: 'old' },
    });
    await expect(relocateLibraryMetaOwner(root, 'other', 'hello')).rejects.toThrow('different plugin');
    expect(await relocateLibraryMetaOwner(path.join(defaultRootBase, 'missing'), 'hello', '_ns__acme__hello')).toBe(false);
  });

  it('无 binding → 默认根;绑定后解析到 <candidate>/<ghostId>', async () => {
    const store = new LibraryBindingStore(deps);
    const before = await store.resolveLibraryRoot(GHOST_ID);
    expect(before.kind).toBe('default');
    if (before.kind === 'default') expect(before.root).toBe(path.join(defaultRootBase, GHOST_ID));

    const set = await store.setBinding(GHOST_ID, candidate);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.record.generation).toBe(1);
    expect(set.record.libraryReady).toBe(false);
    await store.markLibraryReady(GHOST_ID);
    expect((await store.getBinding(GHOST_ID))?.libraryReady).toBe(true);
    expect((await store.getBinding(GHOST_ID))?.generation).toBe(1);

    const after = await store.resolveLibraryRoot(GHOST_ID);
    expect(after.kind).toBe('custom');
    if (after.kind === 'custom' && after.root !== null) {
      // 解析结果基于 realpath(CI Windows 的 tmpdir 带 8.3 短名,如 RUNNER~1,
      // realpath 归一成长名)——按跨平台路径宪法用 realpath 构造期望值比对。
      expect(after.root).toBe(path.join(await fs.promises.realpath(candidate), GHOST_ID));
    }
    // binding 文件持久化(新实例可读)。
    const fresh = new LibraryBindingStore(deps);
    const reread = await fresh.resolveLibraryRoot(GHOST_ID);
    expect(reread.kind).toBe('custom');
  });

  it('企业实例 storage part 可绑定且与 root 分键;斜杠 id 非法', async () => {
    const store = new LibraryBindingStore(deps);
    const orgId = '_ns__acme__mivo-canvas';
    const set = await store.setBinding(orgId, candidate);
    expect(set.ok).toBe(true);
    const resolved = await store.resolveLibraryRoot(orgId);
    expect(resolved.kind).toBe('custom');
    if (resolved.kind === 'custom' && resolved.root !== null) {
      expect(resolved.root).toBe(path.join(await fs.promises.realpath(candidate), orgId));
    }
    const rootResolved = await store.resolveLibraryRoot(GHOST_ID);
    expect(rootResolved.kind).toBe('default');
    const bad = await store.setBinding('_ns/acme/mivo-canvas', candidate);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe('PATH_INVALID');
  });

  it('relocates a custom binding key and folder after an in-place instance moves', async () => {
    const store = new LibraryBindingStore(deps);
    const fromId = 'hello';
    const toId = '_ns__acme__hello';
    const set = await store.setBinding(fromId, candidate);
    expect(set.ok).toBe(true);
    const fromRoot = path.join(await fs.promises.realpath(candidate), fromId);
    await fs.promises.mkdir(fromRoot, { recursive: true });
    await fs.promises.writeFile(path.join(fromRoot, 'keep.txt'), 'org');
    await store.relocateBinding(fromId, toId);
    expect(await store.getBinding(fromId)).toBeNull();
    expect(await store.getBinding(toId)).not.toBeNull();
    const resolved = await store.resolveLibraryRoot(toId);
    expect(resolved.kind).toBe('custom');
    if (resolved.kind === 'custom' && resolved.root !== null) {
      expect(resolved.root).toBe(path.join(await fs.promises.realpath(candidate), toId));
      await expect(fs.promises.readFile(path.join(resolved.root, 'keep.txt'), 'utf8')).resolves.toBe('org');
    }
  });

  it('refuses to relocate a binding onto an existing destination', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    await store.setBinding('_ns__acme__hello', candidate);
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      'library binding destination already exists',
    );
    expect(await store.getBinding('hello')).not.toBeNull();
  });

  it('detects a binding conflict before moving the plugin directory', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    await store.setBinding('_ns__acme__hello', candidate);
    await expect(store.assertCanRelocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      'library binding destination already exists',
    );
    expect(await store.getBinding('hello')).not.toBeNull();
  });


  it('refuses to relocate onto an existing custom library folder without deleting source', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    const fromRoot = path.join(await fs.promises.realpath(candidate), 'hello');
    const toRoot = path.join(await fs.promises.realpath(candidate), '_ns__acme__hello');
    await fs.promises.mkdir(fromRoot, { recursive: true });
    await fs.promises.writeFile(path.join(fromRoot, 'keep.txt'), 'org');
    await fs.promises.mkdir(toRoot, { recursive: true });
    await fs.promises.writeFile(path.join(toRoot, 'old.txt'), 'orphan');
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      'library custom root destination already exists',
    );
    expect(await store.getBinding('hello')).not.toBeNull();
    await expect(fs.promises.readFile(path.join(fromRoot, 'keep.txt'), 'utf8')).resolves.toBe('org');
    await expect(fs.promises.readFile(path.join(toRoot, 'old.txt'), 'utf8')).resolves.toBe('orphan');
  });

  it('does not claim an existing destination folder when the source folder is missing', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding('hello', candidate);
    const destination = path.join(await fs.promises.realpath(candidate), '_ns__acme__hello');
    await fs.promises.mkdir(destination);
    await fs.promises.writeFile(path.join(destination, 'keep.txt'), 'other');
    await expect(store.assertCanRelocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      'library custom root destination already exists',
    );
    await expect(store.relocateBinding('hello', '_ns__acme__hello')).rejects.toThrow(
      'library custom root destination already exists',
    );
    expect(await store.getBinding('hello')).not.toBeNull();
    expect(await store.getBinding('_ns__acme__hello')).toBeNull();
    await expect(fs.promises.readFile(path.join(destination, 'keep.txt'), 'utf8')).resolves.toBe('other');
  });

  it('重新绑定 generation 递增;撤销后回落默认', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding(GHOST_ID, candidate);
    const second = path.join(tmp, 'picked-parent-2');
    await fs.promises.mkdir(second, { recursive: true });
    const set2 = await store.setBinding(GHOST_ID, second);
    if (set2.ok) expect(set2.record.generation).toBe(2);
    await store.removeBinding(GHOST_ID);
    const resolved = await store.resolveLibraryRoot(GHOST_ID);
    expect(resolved.kind).toBe('default');
  });

  it('目录被删 → disk-missing;同路径删后重建 → POSIX 上 binding-moved', async () => {
    const store = new LibraryBindingStore(deps);
    const set = await store.setBinding(GHOST_ID, candidate);
    expect(set.ok).toBe(true);

    await fs.promises.rm(candidate, { recursive: true });
    const missing = await store.resolveLibraryRoot(GHOST_ID);
    expect(missing.kind).toBe('custom');
    if (missing.kind === 'custom' && missing.root === null) {
      expect(missing.drift).toBe('disk-missing');
    }

    // 原地重建:路径字符串相同,靠 identity 检出(Windows ino=0 时退化为放行,
    // 已知平台限制,见模块头注释)。
    await fs.promises.mkdir(candidate, { recursive: true });
    const rebuilt = await store.resolveLibraryRoot(GHOST_ID);
    expect(rebuilt.kind).toBe('custom');
    if (rebuilt.kind === 'custom' && rebuilt.root === null) {
      expect(rebuilt.drift).toBe('binding-moved');
    }
  });

  it('binding 文件损坏 → 回落默认根且不抛(数据本体不动)', async () => {
    const store = new LibraryBindingStore(deps);
    await store.setBinding(GHOST_ID, candidate);
    await fs.promises.writeFile(bindingFile, '{corrupt', 'utf8');
    const resolved = await store.resolveLibraryRoot(GHOST_ID);
    expect(resolved.kind).toBe('default');
  });
});

describe('validateLibraryCandidateLocation', () => {
  let tmp: string;
  let managedRoot: string;
  let deps: LibraryBindingDeps;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-candidate-'));
    managedRoot = path.join(tmp, 'managed');
    await fs.promises.mkdir(managedRoot, { recursive: true });
    deps = {
      getFile: () => path.join(tmp, 'binding.json'),
      getManagedRoots: () => [managedRoot],
      getDefaultRoot: (ghostId) => path.join(tmp, 'default', ghostId),
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('合法目录通过并创建库根路径;返回 libraryRoot', async () => {
    const res = await validateLibraryCandidateLocation({
      candidate: path.join(tmp, 'plain-dir'),
      ghostId: GHOST_ID,
      deps,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.libraryRoot).toBe(path.join(tmp, 'plain-dir', GHOST_ID));
  });

  it('受管根内拒绝;UNC 网络路径拒绝;相对路径拒绝', async () => {
    const inside = await validateLibraryCandidateLocation({
      candidate: path.join(managedRoot, 'sub'),
      ghostId: GHOST_ID,
      deps,
    });
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.errorCode).toBe('PATH_INVALID');

    // UNC 在 POSIX 上先被「非绝对路径」拦下(宿主 path.isAbsolute 平台语义),
    // 只有 win32 走得到「网络位置」分支——两平台都必须是拒绝,话术按平台断言。
    const unc = await validateLibraryCandidateLocation({
      candidate: '\\\\server\\share',
      ghostId: GHOST_ID,
      deps,
    });
    expect(unc.ok).toBe(false);
    if (!unc.ok && process.platform === 'win32') {
      expect(unc.message).toContain('网络');
    }

    const rel = await validateLibraryCandidateLocation({ candidate: 'relative/path', ghostId: GHOST_ID, deps });
    expect(rel.ok).toBe(false);
  });

  it('云同步目录特征 → 强警告但放行', async () => {
    const res = await validateLibraryCandidateLocation({
      candidate: path.join(tmp, 'My Dropbox Files'),
      ghostId: GHOST_ID,
      deps,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings.length).toBe(1);
  });

  it('磁盘余量低于阈值 → DISK_FULL', async () => {
    const res = await validateLibraryCandidateLocation({
      candidate: path.join(tmp, 'small-disk'),
      ghostId: GHOST_ID,
      deps,
      getDiskFreeBytes: async () => 1024,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('DISK_FULL');
  });
});
