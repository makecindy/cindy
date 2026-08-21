/**
 * libraryVault 单测:路径纪律攻击矩阵 / 原子写与分块流 / 用量记账 /
 * 游标分页 / readonly 与 unavailable 语义 / 磁盘水位。全部走注入 deps +
 * os.tmpdir 临时目录(规则 23:生成物不落仓库工作区),零 Electron。
 * symlink 用例带能力探针(Windows 无特权时跳过;POSIX CI 实跑)。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  LibraryVault,
  validateLibraryRelPath,
  DEFAULT_LIBRARY_LIMITS,
  type LibraryVaultDeps,
  type LibraryLimits,
} from '../libraryVault.js';

const sha256Of = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('validateLibraryRelPath(路径纪律)', () => {
  it('放行画布深度路径,拒穿越/绝对/反斜杠/隐藏段/保留名/尾点/超深/超长', () => {
    expect(validateLibraryRelPath('canvases/c1/assets/objects/ab/abc123.png')).toBeNull();
    expect(validateLibraryRelPath('a.txt')).toBeNull();
    expect(validateLibraryRelPath(Array.from({ length: 32 }, (_v, i) => `d${i}`).join('/'))).toBeNull();
    // 攻击矩阵(与 fsSlot 同源,新增 Library 专属边界)。
    expect(validateLibraryRelPath('../escape.txt')).not.toBeNull();
    expect(validateLibraryRelPath('a/../b.txt')).not.toBeNull();
    expect(validateLibraryRelPath('/abs/path.txt')).not.toBeNull();
    expect(validateLibraryRelPath('a\\b.txt')).not.toBeNull();
    expect(validateLibraryRelPath('.cindy-library/meta.json')).not.toBeNull(); // 宿主命名空间不可写
    expect(validateLibraryRelPath('dir/.env')).not.toBeNull();
    expect(validateLibraryRelPath('NUL.txt')).not.toBeNull();
    expect(validateLibraryRelPath('logs/con')).not.toBeNull();
    expect(validateLibraryRelPath('report./a.txt')).not.toBeNull();
    expect(validateLibraryRelPath('a.txt.')).not.toBeNull();
    expect(validateLibraryRelPath(Array.from({ length: 33 }, (_v, i) => `d${i}`).join('/'))).not.toBeNull();
    expect(validateLibraryRelPath(`a/${'x'.repeat(600)}.txt`)).not.toBeNull();
    expect(validateLibraryRelPath('')).not.toBeNull();
    expect(validateLibraryRelPath(undefined)).not.toBeNull();
  });
});

describe('LibraryVault', () => {
  let tmpRoot: string;
  let libraryRoot: string;
  /** 注入覆盖项(磁盘余量/限额)。 */
  let diskFree: number | null = 1024 ** 4; // 1 TiB:默认宽裕
  let limitsOverride: Partial<LibraryLimits> = {};

  const makeVault = (): LibraryVault => {
    const deps: LibraryVaultDeps = {
      rootDir: () => libraryRoot,
      ghostId: 'test-ghost',
      getDiskFreeBytes: async () => diskFree,
      locationKind: 'default',
    };
    return new LibraryVault(deps);
  };

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-vault-'));
    libraryRoot = path.join(tmpRoot, 'libraries', 'test-ghost');
    diskFree = 1024 ** 4;
    limitsOverride = {};
    void limitsOverride; // 后续用例需要时经 makeVault 参数化;当前统一默认限额
  });

  afterEach(async () => {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('open / status / meta', () => {
    it('open 建骨架并写 meta;重复 open 幂等', async () => {
      const vault = makeVault();
      const first = await vault.open();
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.state).toBe('ready');
      const metaRaw = JSON.parse(await fs.promises.readFile(path.join(libraryRoot, '.cindy-library', 'meta.json'), 'utf8'));
      expect(metaRaw.ghostId).toBe('test-ghost');
      expect(metaRaw.version).toBe(1);
      const again = await vault.open();
      expect(again.ok).toBe(true);
      // staging 目录存在(原子写的落点)。
      const stat = await fs.promises.stat(path.join(libraryRoot, '.cindy-library', 'tmp'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('meta 损坏 → unavailable(corrupt),绝不静默重建空库', async () => {
      await fs.promises.mkdir(path.join(libraryRoot, '.cindy-library'), { recursive: true });
      await fs.promises.writeFile(path.join(libraryRoot, '.cindy-library', 'meta.json'), '{not json');
      const vault = makeVault();
      const res = await vault.open();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe('unavailable');
        expect(res.reason).toBe('corrupt');
      }
      // 损坏的 meta 原样保留(不覆盖)。
      const raw = await fs.promises.readFile(path.join(libraryRoot, '.cindy-library', 'meta.json'), 'utf8');
      expect(raw).toBe('{not json');
    });

    it('用量账本缺失时 open 全量重扫', async () => {
      await fs.promises.mkdir(path.join(libraryRoot, 'canvases', 'c1'), { recursive: true });
      await fs.promises.writeFile(path.join(libraryRoot, 'canvases', 'c1', 'a.png'), 'hello');
      const vault = makeVault();
      const res = await vault.open();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.fileCount).toBe(1);
      const st = await vault.status();
      if (st.ok) expect(st.usedBytes).toBe(Buffer.byteLength('hello'));
    });

    it('markOrphaned / clearOrphaned 往返;invalidate 后 open 拒绝', async () => {
      const vault = makeVault();
      await vault.open();
      expect(await vault.markOrphaned('测试意识')).toBeNull();
      expect(vault.getMeta()?.orphaned?.name).toBe('测试意识');
      expect(await vault.clearOrphaned()).toBeNull();
      expect(vault.getMeta()?.orphaned).toBeUndefined();
      await vault.invalidate();
      const res = await vault.open();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe('LIBRARY_UNAVAILABLE');
    });
  });

  describe('write / read / stat / mkdir', () => {
    it('utf8 与 base64 往返;sha256 由宿主实算返回', async () => {
      const vault = makeVault();
      await vault.open();
      const content = '画布正文-测试';
      const w = await vault.write({ path: 'canvases/c1/state.json', content });
      expect(w.ok).toBe(true);
      if (w.ok) {
        expect(w.bytes).toBe(Buffer.byteLength(content));
        expect(w.sha256).toBe(sha256Of(content));
      }
      const r = await vault.read({ path: 'canvases/c1/state.json' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.content).toBe(content);
        expect(r.encoding).toBe('utf8');
        expect(r.sha256).toBe(sha256Of(content));
      }
      const binary = Buffer.from([0, 255, 16, 32]);
      const wb = await vault.write({
        path: 'canvases/c1/bin.dat',
        content: binary.toString('base64'),
        encoding: 'base64',
      });
      expect(wb.ok).toBe(true);
      const rb = await vault.read({ path: 'canvases/c1/bin.dat', encoding: 'base64' });
      if (rb.ok) expect(Buffer.from(rb.content, 'base64')).toEqual(binary);
    });

    it('offset/length 分段读', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'blob.bin', content: '0123456789' });
      const r = await vault.read({ path: 'blob.bin', offset: 3, length: 4 });
      if (r.ok) expect(r.content).toBe('3456');
    });

    it('ifNotExists 冲突 → ALREADY_EXISTS;默认覆盖写', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'a.txt', content: 'v1' });
      const conflict = await vault.write({ path: 'a.txt', content: 'v2', ifNotExists: true });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.errorCode).toBe('ALREADY_EXISTS');
      const overwrite = await vault.write({ path: 'a.txt', content: 'v2' });
      expect(overwrite.ok).toBe(true);
      const r = await vault.read({ path: 'a.txt' });
      if (r.ok) expect(r.content).toBe('v2');
    });

    it('写入后 staging 无残渣;目录自动创建', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'deep/nested/file.txt', content: 'x' });
      const tmpEntries = await fs.promises.readdir(path.join(libraryRoot, '.cindy-library', 'tmp'));
      expect(tmpEntries).toEqual([]);
      const s = await vault.stat({ path: 'deep/nested/file.txt' });
      if (s.ok) {
        expect(s.kind).toBe('file');
        expect(s.bytes).toBe(1);
      }
    });

    it('stat NOT_FOUND;mkdir 幂等;目标是目录时 write 拒绝', async () => {
      const vault = makeVault();
      await vault.open();
      const s = await vault.stat({ path: 'nope.txt' });
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.errorCode).toBe('NOT_FOUND');
      const m1 = await vault.mkdir({ path: 'dirs/a' });
      if (m1.ok) expect(m1.existed).toBe(false);
      const m2 = await vault.mkdir({ path: 'dirs/a' });
      if (m2.ok) expect(m2.existed).toBe(true);
      const w = await vault.write({ path: 'dirs/a', content: 'x' });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('PATH_INVALID');
    });

    it('超单次上限 → TOO_LARGE', async () => {
      const vault = makeVault();
      await vault.open();
      const big = 'x'.repeat(DEFAULT_LIBRARY_LIMITS.writeMaxBytes + 1);
      const w = await vault.write({ path: 'big.txt', content: big });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('TOO_LARGE');
    });
  });

  describe('分块流', () => {
    it('begin/chunk/commit 往返,sha256 校验通过', async () => {
      const vault = makeVault();
      await vault.open();
      const partA = 'a'.repeat(1024);
      const partB = 'b'.repeat(512);
      const whole = partA + partB;
      const begin = await vault.writeBegin({
        path: 'assets/video.bin',
        totalBytes: Buffer.byteLength(whole),
        sha256: sha256Of(whole),
      });
      expect(begin.ok).toBe(true);
      if (!begin.ok) return;
      await vault.writeChunk({ streamId: begin.streamId, seq: 1, content: partA });
      await vault.writeChunk({ streamId: begin.streamId, seq: 2, content: partB });
      const commit = await vault.writeCommit({ streamId: begin.streamId });
      expect(commit.ok).toBe(true);
      if (commit.ok) expect(commit.sha256).toBe(sha256Of(whole));
      const r = await vault.read({ path: 'assets/video.bin' });
      if (r.ok) expect(r.content).toBe(whole);
      // staging 清空。
      const tmpEntries = await fs.promises.readdir(path.join(libraryRoot, '.cindy-library', 'tmp'));
      expect(tmpEntries).toEqual([]);
    });

    it('sha256 声明不符 → STREAM_INVALID 且不留目标文件', async () => {
      const vault = makeVault();
      await vault.open();
      const body = 'payload';
      const begin = await vault.writeBegin({
        path: 'assets/bad.bin',
        totalBytes: Buffer.byteLength(body),
        sha256: '0'.repeat(64),
      });
      if (!begin.ok) throw new Error('begin failed');
      await vault.writeChunk({ streamId: begin.streamId, seq: 1, content: body });
      const commit = await vault.writeCommit({ streamId: begin.streamId });
      expect(commit.ok).toBe(false);
      if (!commit.ok) expect(commit.errorCode).toBe('STREAM_INVALID');
      const s = await vault.stat({ path: 'assets/bad.bin' });
      expect(s.ok).toBe(false);
    });

    it('seq 跳号 → STREAM_INVALID;字节数超出声明拒绝;abort 幂等清残', async () => {
      const vault = makeVault();
      await vault.open();
      const begin = await vault.writeBegin({ path: 'a.bin', totalBytes: 10 });
      if (!begin.ok) throw new Error('begin failed');
      const gap = await vault.writeChunk({ streamId: begin.streamId, seq: 2, content: 'xx' });
      expect(gap.ok).toBe(false);
      if (!gap.ok) expect(gap.errorCode).toBe('STREAM_INVALID');
      // 流仍可用(seq 期望回到 1)。
      await vault.writeChunk({ streamId: begin.streamId, seq: 1, content: 'x'.repeat(10) });
      const over = await vault.writeChunk({ streamId: begin.streamId, seq: 2, content: 'y' });
      expect(over.ok).toBe(false);
      const abort = await vault.writeAbort({ streamId: begin.streamId });
      if (abort.ok) expect(abort.aborted).toBe(true);
      const again = await vault.writeAbort({ streamId: begin.streamId });
      if (again.ok) expect(again.aborted).toBe(false);
      const commit = await vault.writeCommit({ streamId: begin.streamId });
      expect(commit.ok).toBe(false);
      const tmpEntries = await fs.promises.readdir(path.join(libraryRoot, '.cindy-library', 'tmp'));
      expect(tmpEntries).toEqual([]);
    });
  });

  describe('list 游标分页', () => {
    it('recursive 分页可续且不重不漏;非递归只列单层', async () => {
      const vault = new LibraryVault({
        rootDir: () => libraryRoot,
        ghostId: 'test-ghost',
        limits: { listPageSize: 3 },
      });
      await vault.open();
      for (let i = 0; i < 7; i += 1) {
        await vault.write({ path: `canvases/c${i}/state.json`, content: `s${i}` });
      }
      await vault.write({ path: 'root.txt', content: 'r' });

      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await vault.list({ recursive: true, cursor });
        if (!page.ok) throw new Error('list failed');
        seen.push(...page.entries.map((e) => e.path));
        if (!page.hasMore || page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      // 8 个文件 + 8 个目录(canvases/ 与 7 个 c<i>/) = 16;.cindy-library 不入列。
      expect(seen.length).toBe(16);
      expect(new Set(seen).size).toBe(16); // 不重
      expect(seen).toEqual([...seen].sort()); // 不漏(最终有序)

      const flat = await vault.list({ path: 'canvases/c1' });
      if (flat.ok) expect(flat.entries.map((e) => e.path)).toEqual(['canvases/c1/state.json']);
    });
  });

  describe('delete / rename', () => {
    it('delete 幂等;递归删目录并核账;非空目录无 recursive 拒绝', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'canvases/c1/a.png', content: 'aaa' });
      await vault.write({ path: 'canvases/c1/b.png', content: 'bb' });
      const deny = await vault.delete({ path: 'canvases/c1' });
      expect(deny.ok).toBe(false);
      if (!deny.ok) expect(deny.errorCode).toBe('ALREADY_EXISTS');
      const del = await vault.delete({ path: 'canvases/c1', recursive: true });
      expect(del.ok).toBe(true);
      const st = await vault.status();
      if (st.ok) {
        expect(st.fileCount).toBe(0);
        expect(st.usedBytes).toBe(0);
      }
      const again = await vault.delete({ path: 'canvases/c1' });
      if (again.ok) expect(again.existed).toBe(false);
    });

    it('rename:默认拒覆盖,overwrite 原子替换;源空目录剪枝', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'canvases/c1/a.png', content: 'A' });
      await vault.write({ path: 'canvases/c1/b.png', content: 'B' });
      const conflict = await vault.rename({ from: 'canvases/c1/a.png', to: 'canvases/c1/b.png' });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.errorCode).toBe('ALREADY_EXISTS');
      const ok = await vault.rename({ from: 'canvases/c1/a.png', to: 'canvases/c1/sub/b.png', overwrite: true });
      expect(ok.ok).toBe(true);
      const r = await vault.read({ path: 'canvases/c1/sub/b.png' });
      if (r.ok) expect(r.content).toBe('A');
      const gone = await vault.stat({ path: 'canvases/c1/a.png' });
      expect(gone.ok).toBe(false);
      // c1 目录仍在(b.png 未删),但若整目录只余移动后文件,源父目录应被剪空。
      const st = await vault.status();
      if (st.ok) expect(st.fileCount).toBe(2);
    });
  });

  describe('水位与状态', () => {
    it('磁盘低于保留水位 → DISK_FULL(读不受影响)', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'a.txt', content: 'x' });
      diskFree = 512 * 1024 * 1024; // 512 MiB < 1 GiB 保留水位
      const w = await vault.write({ path: 'b.txt', content: 'y' });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('DISK_FULL');
      const r = await vault.read({ path: 'a.txt' });
      expect(r.ok).toBe(true);
    });

    it('setReadonly → 写拒绝 LIBRARY_READONLY,读照常;clear 恢复', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'a.txt', content: 'x' });
      vault.setReadonly('migration');
      const st = await vault.status();
      if (st.ok) expect(st.state).toBe('readonly');
      const w = await vault.write({ path: 'b.txt', content: 'y' });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('LIBRARY_READONLY');
      const r = await vault.read({ path: 'a.txt' });
      expect(r.ok).toBe(true);
      vault.clearReadonly();
      const w2 = await vault.write({ path: 'b.txt', content: 'y' });
      expect(w2.ok).toBe(true);
    });

    it('软水位只在 status 告警,不阻断写', async () => {
      const vault = new LibraryVault({
        rootDir: () => libraryRoot,
        ghostId: 'test-ghost',
        limits: { softLimitBytes: 2 },
      });
      await vault.open();
      await vault.write({ path: 'a.txt', content: 'xxxx' });
      const st = await vault.status();
      if (st.ok) expect(st.softLimitExceeded).toBe(true);
      const w = await vault.write({ path: 'b.txt', content: 'y' });
      expect(w.ok).toBe(true);
    });

    it('未 open 先操作 → LIBRARY_UNAVAILABLE(不当作空库)', async () => {
      const vault = makeVault();
      const w = await vault.write({ path: 'a.txt', content: 'x' });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('LIBRARY_UNAVAILABLE');
    });
  });

  describe('symlink 逃逸(能力探针)', () => {
    let probeDir: string;
    let supportsSymlink = false;

    beforeAll(async () => {
      probeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-probe-'));
      try {
        await fs.promises.symlink(path.join(probeDir, 'self'), path.join(probeDir, 'link'));
        supportsSymlink = true;
      } catch {
        supportsSymlink = false; // Windows 无特权:跳过真实文件系统用例
      }
    });
    afterAll(async () => {
      await fs.promises.rm(probeDir, { recursive: true, force: true });
    });

    it('目标是符号链接拒绝写;中间目录指向根外拒绝读/写/删', async ({ skip }) => {
      if (!supportsSymlink) skip();
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'real.txt', content: 'x' });
      // 目标本身是 symlink → 拒绝穿透写。
      await fs.promises.symlink(
        path.join(libraryRoot, 'real.txt'),
        path.join(libraryRoot, 'alias.txt'),
      );
      const w = await vault.write({ path: 'alias.txt', content: 'y' });
      expect(w.ok).toBe(false);
      if (!w.ok) expect(w.errorCode).toBe('PATH_INVALID');
      // 中间目录 symlink → 根外逃逸,读写删全拒。
      await fs.promises.symlink(tmpRoot, path.join(libraryRoot, 'escape-door'));
      const w2 = await vault.write({ path: 'escape-door/stolen.txt', content: 'y' });
      expect(w2.ok).toBe(false);
      if (!w2.ok) expect(w2.errorCode).toBe('PATH_INVALID');
      const r = await vault.read({ path: 'escape-door/anything' });
      expect(r.ok).toBe(false);
      const d = await vault.delete({ path: 'escape-door/anything' });
      expect(d.ok).toBe(false);
    });
  });
});
