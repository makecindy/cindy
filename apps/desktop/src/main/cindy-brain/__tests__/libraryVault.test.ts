/**
 * libraryVault 单测:路径纪律攻击矩阵 / 原子写与分块流 / 用量记账 /
 * 游标分页 / readonly 与 unavailable 语义 / 磁盘水位。全部走注入 deps +
 * os.tmpdir 临时目录(规则 23:生成物不落仓库工作区),零 Electron。
 * symlink 用例带能力探针(Windows 无特权时跳过;POSIX CI 实跑)。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
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
  type LibraryFileIdentity,
  type LibraryReadHandle,
} from '../libraryVault.js';
import { initCustomLibraryTree, openExistingCustomLibrary, parseExistingStdout, PROVABLE_STAGING_NAME } from '../libraryDirFd.js';

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

  const makeVault = (over: Partial<LibraryVaultDeps> = {}): LibraryVault => {
    const deps: LibraryVaultDeps = {
      rootDir: () => libraryRoot,
      ghostId: 'test-ghost',
      getDiskFreeBytes: async () => diskFree,
      locationKind: 'default',
      limits: limitsOverride,
      ...over,
    };
    return new LibraryVault(deps);
  };

  const identityStub = (
    size: number,
    isFile = true,
    ino = 1,
    dev = 1,
  ): LibraryFileIdentity => ({
    size: BigInt(size),
    isFile: () => isFile,
    ino: BigInt(ino),
    dev: BigInt(dev),
  });

  const fakeReadHandle = (opts: {
    statSize: number;
    isFile?: boolean;
    data?: Buffer;
    ino?: number;
    dev?: number;
    readSpy?: () => void;
  }): LibraryReadHandle => {
    const data = opts.data ?? Buffer.alloc(opts.statSize);
    return {
      stat: async () => identityStub(opts.statSize, opts.isFile ?? true, opts.ino ?? 1, opts.dev ?? 1),
      read: async (buffer, offset, length, position) => {
        opts.readSpy?.();
        const bytesRead = data.copy(buffer, offset, position, position + length);
        return { bytesRead };
      },
      close: async () => undefined,
    };
  };

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-vault-'));
    libraryRoot = path.join(tmpRoot, 'libraries', 'test-ghost');
    diskFree = 1024 ** 4;
    limitsOverride = {};
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

    it('custom 已建过(allowCustomInit=false)且新 vault: ghost 子目录 MISSING 不得空库重建', async () => {
      const parent = path.join(tmpRoot, 'picked-no-init');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(parent, { recursive: true });
      const vault = makeVault({
        rootDir: () => custom,
        locationKind: 'custom',
        allowCustomInit: false,
      });
      const missing = await vault.open();
      expect(missing).toMatchObject({ ok: true, state: 'unavailable', reason: 'disk-missing' });
      expect(fs.existsSync(path.join(custom, '.cindy-library', 'meta.json'))).toBe(false);
    });

    it('custom 已 open 后 ghost 子目录消失: 再 open 报 disk-missing 且不重建空库', async () => {
      const parent = path.join(tmpRoot, 'picked-ghost-gone');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      await fs.promises.writeFile(path.join(custom, 'keep.txt'), 'keep-me');
      const vault = makeVault({ rootDir: () => custom, locationKind: 'custom' });
      expect(await vault.open()).toMatchObject({ ok: true, state: 'ready' });
      await fs.promises.rename(custom, `${custom}.parked`);
      const missing = await vault.open();
      expect(missing).toMatchObject({ ok: true, state: 'unavailable', reason: 'disk-missing' });
      expect(fs.existsSync(custom)).toBe(false);
      expect(fs.existsSync(path.join(parent, 'mivo-canvas', '.cindy-library', 'meta.json'))).toBe(false);
      expect(fs.existsSync(path.join(`${custom}.parked`, 'keep.txt'))).toBe(true);
    });
    it('custom 用户父目录消失: open 报 disk-missing 且不重建空库; keep 仍在 rename 走的目录', async () => {
      const parent = path.join(tmpRoot, 'picked');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      await fs.promises.writeFile(path.join(custom, 'keep.txt'), 'keep-me');
      const first = makeVault({ rootDir: () => custom, locationKind: 'custom' });
      const opened = await first.open();
      expect(opened).toMatchObject({ ok: true, state: 'ready' });
      await fs.promises.rename(parent, `${parent}.parked`);
      const second = makeVault({ rootDir: () => custom, locationKind: 'custom' });
      const missing = await second.open();
      expect(missing).toMatchObject({ ok: true, state: 'unavailable', reason: 'disk-missing' });
      expect(fs.existsSync(parent)).toBe(false);
      expect(fs.existsSync(custom)).toBe(false);
      expect(fs.existsSync(path.join(`${parent}.parked`, 'mivo-canvas', 'keep.txt'))).toBe(true);
    });

    it('custom 最后一次 inspect 后、骨架 mkdir 前父目录被移走:不得 recursive 重建空库', async () => {
      const parent = path.join(tmpRoot, 'picked-411');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      await fs.promises.writeFile(path.join(custom, 'keep.txt'), 'keep-me');
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const first = makeVault({ rootDir: () => custom, locationKind: 'custom', customParentGrant: grant });
      expect(await first.open()).toMatchObject({ ok: true, state: 'ready' });
      const parked = `${parent}.parked`;
      let injected = false;
      const raced = makeVault({
        rootDir: () => custom,
        locationKind: 'custom',
        customParentGrant: grant,
        openExistingCustom: async (req) => {
          if (!injected) {
            injected = true;
            if (fs.existsSync(parent)) await fs.promises.rename(parent, parked);
          }
          return openExistingCustomLibrary(req);
        },
      });
      const missing = await raced.open();
      expect(injected).toBe(true);
      expect(missing).toMatchObject({ ok: true, state: 'unavailable', reason: 'disk-missing' });
      expect(fs.existsSync(parent)).toBe(false);
      expect(fs.existsSync(path.join(custom, '.cindy-library', 'meta.json'))).toBe(false);
      expect(fs.existsSync(path.join(parked, 'mivo-canvas', 'keep.txt'))).toBe(true);
    });

    it('最后一次成功 inspect 后、mkdir(root) 前换成同路径新 inode:不得在替换目录创建/写 meta', async () => {
      if (process.platform === 'win32') return;
      const parent = path.join(tmpRoot, 'picked-379');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      await fs.promises.writeFile(path.join(custom, 'keep.txt'), 'keep-me');
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const first = makeVault({ rootDir: () => custom, locationKind: 'custom', customParentGrant: grant });
      expect(await first.open()).toMatchObject({ ok: true, state: 'ready' });
      const parked = `${parent}.parked`;
      let injected = false;
      const raced = makeVault({
        rootDir: () => custom,
        locationKind: 'custom',
        customParentGrant: grant,
        openExistingCustom: async (req) => {
          if (!injected) {
            injected = true;
            if (fs.existsSync(parent)) await fs.promises.rename(parent, parked);
            await fs.promises.mkdir(parent);
          }
          return openExistingCustomLibrary(req);
        },
      });
      const opened = await raced.open();
      expect(injected).toBe(true);
      expect(opened).toMatchObject({ ok: true, state: 'unavailable', reason: 'binding-moved' });
      expect(fs.existsSync(custom)).toBe(false);
      expect(fs.existsSync(path.join(custom, '.cindy-library', 'meta.json'))).toBe(false);
      expect(fs.existsSync(path.join(parked, 'mivo-canvas', 'keep.txt'))).toBe(true);
    });

    it('D: initCustomLibraryTree 后 sweep readdir 换根不得写 replacement usage.json', async () => {
      if (process.platform === 'win32') return;
      const parent = path.join(tmpRoot, 'picked-D');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(parent);
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const parked = `${parent}.parked`;
      let afterInit = false;
      let swapped = false;
      const origReaddir = fs.promises.readdir.bind(fs.promises);
      const origRename = fs.promises.rename.bind(fs.promises);
      const origMkdir = fs.promises.mkdir.bind(fs.promises);
      const origWriteFile = fs.promises.writeFile.bind(fs.promises);
      const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (target, options) => {
        const dest = String(target);
        if (afterInit && !swapped && dest.includes(`${path.sep}mivo-canvas${path.sep}.cindy-library${path.sep}tmp`)) {
          swapped = true;
          if (fs.existsSync(parent)) await origRename(parent, parked);
          await origMkdir(parent);
          await origMkdir(custom);
          await origMkdir(path.join(custom, '.cindy-library'));
          await origMkdir(path.join(custom, '.cindy-library', 'tmp'));
          await origWriteFile(path.join(custom, '.cindy-library', 'meta.json'), JSON.stringify({
            version: 1, ghostId: 'mivo-canvas', createdAt: 1,
          }));
          await origWriteFile(path.join(custom, 'user-keep.txt'), 'user');
          await origWriteFile(path.join(custom, '.cindy-library', 'tmp', 'old.tmp'), 'stale');
        }
        return origReaddir(target, options);
      });
      const vault = makeVault({
        rootDir: () => custom,
        locationKind: 'custom',
        customParentGrant: grant,
        ghostId: 'mivo-canvas',
        initCustomTree: async (req) => {
          const r = await initCustomLibraryTree(req);
          afterInit = true;
          return r;
        },
      });
      const opened = await vault.open();
      readdirSpy.mockRestore();
      expect(opened.ok).toBe(true);
      expect(fs.existsSync(path.join(custom, '.cindy-library', 'usage.json'))).toBe(false);
      if (swapped) {
        expect(fs.existsSync(path.join(custom, 'user-keep.txt'))).toBe(true);
        expect(opened).toMatchObject({ state: 'unavailable' });
      } else {
        expect(opened).toMatchObject({ state: 'ready' });
        expect(fs.existsSync(path.join(parent, 'mivo-canvas', '.cindy-library', 'usage.json'))).toBe(false);
      }
    });

    it('已有 custom 再 open 走 existing,不调用 create helper', async () => {
      const parent = path.join(tmpRoot, 'picked-exist');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const first = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      expect(await first.open()).toMatchObject({ ok: true, state: 'ready' });
      const init = vi.fn(async () => ({ ok: false as const, code: 'UNSUPPORTED' as const }));
      const second = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
        initCustomTree: init,
      });
      expect(await second.open()).toMatchObject({ ok: true, state: 'ready' });
      expect(init).not.toHaveBeenCalled();
    });

    it('existing UNSUPPORTED 且无完整结构: permission 且不 mkdir', async () => {
      const parent = path.join(tmpRoot, 'picked-win');
      await fs.promises.mkdir(parent);
      const custom = path.join(parent, 'mivo-canvas');
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const vault = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
        openExistingCustom: async () => ({ ok: false as const, code: 'UNSUPPORTED' as const }),
        initCustomTree: async () => ({ ok: false as const, code: 'UNSUPPORTED' as const }),
      });
      const opened = await vault.open();
      expect(opened).toMatchObject({ ok: true, state: 'unavailable', reason: 'permission' });
      expect(fs.existsSync(custom)).toBe(false);
    });

    it('合法 usage.json 只读复用,不因 custom open 丢账本', async () => {
      const parent = path.join(tmpRoot, 'picked-ledger');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const first = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      expect(await first.open()).toMatchObject({ ok: true, state: 'ready' });
      const w = await first.write({ path: 'keep.txt', content: 'abcdef' });
      expect(w.ok).toBe(true);
      const second = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      const opened = await second.open();
      expect(opened).toMatchObject({ ok: true, state: 'ready', usedBytes: Buffer.byteLength('abcdef') });
    });

    it('existing-open payload: pretty 与 compact 合法 meta 都读, malformed 仍 CORRUPT', () => {
      const compact = 'OK\n{"version":1,"ghostId":"mivo-canvas","createdAt":1}\n{"files":2,"bytes":10,"updatedAt":1,"mutations":0}';
      const prettyMeta = JSON.stringify({ version: 1, ghostId: 'mivo-canvas', createdAt: 1 }, null, 2);
      const prettyUsage = JSON.stringify({ files: 2, bytes: 10, updatedAt: 1, mutations: 0 }, null, 2);
      const pretty = `OK\n${prettyMeta}\n${prettyUsage}`;
      expect(parseExistingStdout(compact)).toMatchObject({
        ok: true, meta: { version: 1, ghostId: 'mivo-canvas', createdAt: 1 }, usage: { files: 2, bytes: 10 },
      });
      expect(parseExistingStdout(pretty)).toMatchObject({
        ok: true, meta: { version: 1, ghostId: 'mivo-canvas', createdAt: 1 }, usage: { files: 2, bytes: 10 },
      });
      expect(parseExistingStdout('OK\n{"version":1,"ghostId":"mivo-canvas","createdAt":1}')).toMatchObject({
        ok: true, usage: null,
      });
      expect(parseExistingStdout('OK\n{not json')).toMatchObject({ ok: false, code: 'CORRUPT' });
      expect(parseExistingStdout('OK\n{"version":2,"ghostId":"mivo-canvas","createdAt":1}')).toMatchObject({ ok: false, code: 'CORRUPT' });
      expect(parseExistingStdout('OK\n{"version":1,"ghostId":"mivo-canvas","createdAt":1}\n{nope')).toMatchObject({ ok: false, code: 'CORRUPT' });
      expect(parseExistingStdout('MISSING')).toMatchObject({ ok: false, code: 'MISSING' });
    });

    it('pretty-printed 落盘 meta 再 open 仍 ready,不降校验', async () => {
      const parent = path.join(tmpRoot, 'picked-pretty');
      const custom = path.join(parent, 'mivo-canvas');
      await fs.promises.mkdir(custom, { recursive: true });
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const first = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      expect(await first.open()).toMatchObject({ ok: true, state: 'ready' });
      const metaPath = path.join(custom, '.cindy-library', 'meta.json');
      const compact = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
      await fs.promises.writeFile(metaPath, JSON.stringify(compact, null, 2));
      const second = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      expect(await second.open()).toMatchObject({ ok: true, state: 'ready' });
      await fs.promises.writeFile(metaPath, '{not json');
      const third = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      expect(await third.open()).toMatchObject({ ok: true, state: 'unavailable', reason: 'corrupt' });
    });

    it('可证 staging 名只匹配 uuid.tmp/stream,不匹配 old.tmp 或原件', () => {
      expect(PROVABLE_STAGING_NAME.test('25ae5922-06f7-46dd-99f1-6d914d53af33.tmp')).toBe(true);
      expect(PROVABLE_STAGING_NAME.test('25ae5922-06f7-46dd-99f1-6d914d53af33.stream')).toBe(true);
      expect(PROVABLE_STAGING_NAME.test('old.tmp')).toBe(false);
      expect(PROVABLE_STAGING_NAME.test('keep.txt')).toBe(false);
      expect(PROVABLE_STAGING_NAME.test('meta.json')).toBe(false);
    });

    it('Windows 新建 custom 走稳定 parent handle 首建 ready', async () => {
      if (process.platform !== 'win32') return;
      const parent = path.join(tmpRoot, 'picked-win-new');
      await fs.promises.mkdir(parent);
      const custom = path.join(parent, 'mivo-canvas');
      const parentStat = await fs.promises.lstat(parent);
      const grant = {
        realPathAtGrant: await fs.promises.realpath(parent),
        identity: { dev: parentStat.dev, ino: parentStat.ino },
      };
      const vault = makeVault({
        rootDir: () => custom, locationKind: 'custom', customParentGrant: grant, ghostId: 'mivo-canvas',
      });
      const opened = await vault.open();
      expect(opened).toMatchObject({ ok: true, state: 'ready' });
      expect(fs.existsSync(path.join(custom, '.cindy-library', 'meta.json'))).toBe(true);
    });

    it('default 缺失根仍可首次创建', async () => {
      const missing = path.join(tmpRoot, 'brand-new-default', 'ghost');
      const vault = makeVault({ rootDir: () => missing, locationKind: 'default' });
      const opened = await vault.open();
      expect(opened).toMatchObject({ ok: true, state: 'ready' });
      expect(fs.existsSync(path.join(missing, '.cindy-library', 'meta.json'))).toBe(true);
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
      const dirSync = await vault.fsyncDir('assets');
      expect(dirSync.ok).toBe(true);
      if (dirSync.ok) {
        if (process.platform === 'win32') expect(dirSync.fsynced).toBe(false);
        else expect(dirSync.fsynced).toBe(true);
      }
      const residue = await vault.tmpResidueBytes();
      expect(residue).toEqual({ ok: true, bytes: 0 });
    });

    it('fsyncCreatedAncestors 同步新建根的父目录项,只 fsync 根不等于根 entry 已耐久', async () => {
      const nestedRoot = path.join(tmpRoot, 'owners', 'a', 'library-staging', 'test-ghost');
      const vault = makeVault({ rootDir: () => nestedRoot });
      const opened = await vault.open();
      expect(opened.ok).toBe(true);
      const parent = path.dirname(nestedRoot);
      expect(fs.existsSync(parent)).toBe(true);
      const synced = new Set<string>();
      const origOpen = fs.promises.open.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await origOpen(file, flags, mode);
        if (typeof file === 'string' && flags === 'r') {
          const origSync = handle.sync.bind(handle);
          handle.sync = async () => {
            synced.add(path.resolve(file));
            return origSync();
          };
        }
        return handle;
      });
      try {
        const ok = await vault.fsyncCreatedAncestors();
        expect(ok.ok).toBe(true);
        if (process.platform === 'win32') {
          if (ok.ok) expect(ok.fsynced).toBe(false);
        } else {
          if (ok.ok) expect(ok.fsynced).toBe(true);
          expect(synced.has(path.resolve(parent))).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('fsyncCreatedAncestors 父目录 fsync 失败则 INTERNAL,不得当耐久', async () => {
      const nestedRoot = path.join(tmpRoot, 'owners', 'b', 'library-staging', 'test-ghost');
      const vault = makeVault({ rootDir: () => nestedRoot });
      await vault.open();
      const parent = path.resolve(path.dirname(nestedRoot));
      const origOpen = fs.promises.open.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
        if (typeof file === 'string' && path.resolve(file) === parent && flags === 'r') {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return origOpen(file, flags, mode);
      });
      try {
        const failed = await vault.fsyncCreatedAncestors();
        if (process.platform === 'win32') {
          expect(failed).toEqual({ ok: true, fsynced: false });
        } else {
          expect(failed.ok).toBe(false);
          if (!failed.ok) expect(failed.errorCode).toBe('INTERNAL');
        }
      } finally {
        spy.mockRestore();
      }
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
      const compatible = await vault.list({ recursive: false });
      expect(compatible.ok).toBe(true);
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
      const compatible = await vault.list({ recursive: false });
      expect(compatible.ok).toBe(true);
      const strict = await vault.list({ recursive: false, strict: true });
      expect(strict.ok).toBe(false);
      if (!strict.ok) expect(strict.errorCode).toBe('LIBRARY_UNAVAILABLE');
    });
  });

  describe('read 路径 O_NOFOLLOW + identity 复核', () => {
    it('常规 blob 可读(真实 fs,正本 assets/<2>/<hash>/blob.ext)', async () => {
      const vault = makeVault();
      await vault.open();
      const rel = 'assets/ab/abc123def456abc123def456abc123de/blob.png';
      const body = 'pixel-bytes';
      const w = await vault.write({ path: rel, content: body });
      expect(w.ok).toBe(true);
      const r = await vault.read({ path: rel });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.content).toBe(body);
        expect(r.sha256).toBe(sha256Of(body));
        expect(r.bytes).toBe(Buffer.byteLength(body));
      }
      const hashed = await vault.hashFile(rel);
      expect(hashed).toEqual({ ok: true, path: rel, bytes: Buffer.byteLength(body), sha256: sha256Of(body) });
    });

    it('打开后目标 identity 变化 → INTERNAL 且不得返回字节', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'assets/ab/deadbeefdeadbeefdeadbeefdeadbeef/blob.bin', content: 'secret' });
      let readCalled = false;
      const vaultSwap = makeVault({
        lstatForRead: async () => identityStub(6, true, 1, 1),
        openForRead: async () =>
          fakeReadHandle({
            statSize: 6,
            data: Buffer.from('secret'),
            ino: 999,
            readSpy: () => {
              readCalled = true;
            },
          }),
      });
      await vaultSwap.open();
      const r = await vaultSwap.read({ path: 'assets/ab/deadbeefdeadbeefdeadbeefdeadbeef/blob.bin' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('INTERNAL');
      expect(r).not.toHaveProperty('content');
      expect(readCalled).toBe(false);
    });

    it('ino=0 身份不可用 → fail-closed INTERNAL,不得返回字节', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'assets/cd/cafecafecafecafecafecafecafecafe/blob.bin', content: 'leak' });
      let readCalled = false;
      const vaultZero = makeVault({
        lstatForRead: async () => identityStub(4, true, 0, 1),
        openForRead: async () =>
          fakeReadHandle({
            statSize: 4,
            data: Buffer.from('leak'),
            ino: 0,
            readSpy: () => {
              readCalled = true;
            },
          }),
      });
      await vaultZero.open();
      const r = await vaultZero.read({ path: 'assets/cd/cafecafecafecafecafecafecafecafe/blob.bin' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('INTERNAL');
      expect(r).not.toHaveProperty('content');
      expect(readCalled).toBe(false);
    });

    it('openForRead 收到 O_RDONLY|O_NOFOLLOW;失败不得回落无复核 read', async () => {
      const vault = makeVault();
      await vault.open();
      await vault.write({ path: 'assets/ef/efefefefefefefefefefefefefefefef/blob.bin', content: 'payload' });
      const seenFlags: number[] = [];
      const vaultFlags = makeVault({
        lstatForRead: async () => identityStub(7, true, 1, 1),
        openForRead: async (_abs, flags) => {
          seenFlags.push(flags);
          const err = new Error('ELOOP') as NodeJS.ErrnoException;
          err.code = 'ELOOP';
          throw err;
        },
      });
      await vaultFlags.open();
      const r = await vaultFlags.read({ path: 'assets/ef/efefefefefefefefefefefefefefefef/blob.bin' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('INTERNAL');
      expect(r).not.toHaveProperty('content');
      expect(seenFlags).toHaveLength(1);
      expect(seenFlags[0] & fs.constants.O_RDONLY).toBe(fs.constants.O_RDONLY);
      if (typeof fs.constants.O_NOFOLLOW === 'number') {
        expect(seenFlags[0] & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      }
    });
  });
});
