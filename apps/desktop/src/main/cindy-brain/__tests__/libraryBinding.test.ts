/**
 * libraryBinding 单测:绑定/撤销/漂移三分支(disk-missing / binding-moved)、
 * 候选位置校验(受管根排斥/UNC 拒/云盘警告/可写探针)、损坏文件回落默认。
 * 注入 deps + os.tmpdir,零 Electron。identity 用例带平台能力探针。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LibraryBindingStore, validateLibraryCandidateLocation, type LibraryBindingDeps } from '../libraryBinding.js';

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
    await fs.promises.rm(tmp, { recursive: true, force: true });
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
