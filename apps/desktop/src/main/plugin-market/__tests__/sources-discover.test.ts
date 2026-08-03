import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 跳过明细只落日志(不进返回值、不进 IPC),所以断言必须打在 logger 上。
const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { discoverMarketplace } from '../sources/discover';

const roots: string[] = [];
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-symlink-probe-'));
  try {
    const target = path.join(probeDir, 'target.txt');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  mocks.warn.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-discover-'));
  roots.push(root);
  return root;
}

function ghostJson(id: string, version = '1.0.0') {
  return JSON.stringify({
    schemaVersion: 2,
    id,
    name: `Plugin ${id}`,
    version,
    entry: 'main.js',
    slots: ['notify'],
  });
}

function writePlugin(root: string, rel: string, id: string, version = '1.0.0') {
  const dir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ghost.json'), ghostJson(id, version));
  fs.writeFileSync(path.join(dir, 'main.js'), '// entry');
}

function writeManifest(root: string, manifest: unknown, rel = '.agents/plugins/marketplace.json') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
}

/** LF / CR / NEL / LINE SEPARATOR / PARAGRAPH SEPARATOR 的码位。 */
const LINE_BREAK_CODE_POINTS = [0x0a, 0x0d, 0x85, 0x2028, 0x2029];

/**
 * 读最后一次跳过日志。顺带锁住两件事:payload 是**字符串**、且是**单个物理行**。
 * main logger 走 util.format,传对象会被 util.inspect 按 breakLength 展开——实测
 * 1 条明细 15 个物理行、20 条 129 行,续行还丢掉时间戳/级别/scope。
 */
function lastSkipLog(): {
  market: string;
  declared: number;
  accepted: number;
  skippedCount: number;
  unreadableCount: number;
  entries: Array<{ index: number; path?: string; reason: string; errno?: string }>;
  detailsTruncated?: number;
} {
  const call = mocks.warn.mock.calls.at(-1);
  expect(call?.[0]).toBe('marketplace skipped plugin entries');
  const json = call?.[1];
  expect(typeof json).toBe('string');
  for (const cp of LINE_BREAK_CODE_POINTS) {
    expect(json as string).not.toContain(String.fromCharCode(cp));
  }
  return JSON.parse(json as string);
}

describe('discoverMarketplace', () => {
  it('discovers plugins from the primary manifest location', async () => {
    const root = makeRoot();
    writePlugin(root, 'plugins/alpha', 'alpha');
    writePlugin(root, 'plugins/beta', 'beta', '2.0.0');
    writeManifest(root, {
      name: 'team-market',
      interface: { displayName: 'Team Market' },
      plugins: [{ name: 'alpha', source: './plugins/alpha' }, { name: 'beta', source: 'plugins/beta' }],
    });

    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.name).toBe('team-market');
    expect(result.marketplace.displayName).toBe('Team Market');
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(result.marketplace.plugins[1]?.version).toBe('2.0.0');
    expect(result.marketplace.skippedCount).toBe(0);
  });

  it.each([
    '.claude-plugin/marketplace.json',
    '.cursor-plugin/marketplace.json',
    '.agents/plugins/api_marketplace.json',
  ])('falls back to the alternate manifest location %s', async (rel) => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, { name: 'alt', plugins: [{ name: 'solo', source: 'p' }] }, rel);
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.marketplace.name).toBe('alt');
  });

  it('prefers the primary manifest when several locations exist', async () => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, { name: 'primary', plugins: [] });
    writeManifest(root, { name: 'secondary', plugins: [] }, '.claude-plugin/marketplace.json');
    const result = await discoverMarketplace(root);
    expect(result.ok && result.marketplace.name).toBe('primary');
  });

  it('supports the object form of local sources', async () => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, {
      name: 'obj',
      plugins: [{ name: 'solo', source: { source: 'local', path: 'p' } }],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok && result.marketplace.plugins).toHaveLength(1);
  });

  it('reports a missing manifest distinctly from a malformed one', async () => {
    const empty = makeRoot();
    expect(await discoverMarketplace(empty)).toEqual({ ok: false, code: 'MARKET_MANIFEST_MISSING' });

    const malformed = makeRoot();
    writeManifest(malformed, '{ not json');
    const result = await discoverMarketplace(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MARKET_SOURCE_INVALID');
  });

  it('skips unsupported remote plugin sources and invalid entries', async () => {
    const root = makeRoot();
    writePlugin(root, 'ok', 'good-one');
    writeManifest(root, {
      name: 'mixed',
      plugins: [
        { name: 'good', source: 'ok' },
        { name: 'remote', source: { source: 'url', url: 'https://x.test/r.git' } },
        { name: 'npm', source: { source: 'npm', package: '@x/y' } },
        { name: 'escapes', source: '../outside' },
        { name: 'absolute', source: '/etc/passwd' },
        { name: 'missing-ghost', source: 'nowhere' },
        'not-an-object',
      ],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
    expect(result.marketplace.skippedCount).toBe(6);
  });

  it('skips plugins whose directory symlinks escape the market root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writePlugin(outside, 'escaped', 'escaped');
    writePlugin(root, 'plugins/good', 'good-one');
    fs.symlinkSync(outside, path.join(root, 'plugins', 'linked-out'), directoryLinkType);
    writeManifest(root, {
      name: 'linked',
      plugins: [
        { name: 'good', source: 'plugins/good' },
        { name: 'escaped', source: 'plugins/linked-out/escaped' },
      ],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
    expect(result.marketplace.skippedCount).toBe(1);
  });

  it('skips duplicate ghostIds keeping the first occurrence', async () => {
    const root = makeRoot();
    writePlugin(root, 'a', 'dup-id', '1.0.0');
    writePlugin(root, 'b', 'dup-id', '9.9.9');
    writeManifest(root, {
      name: 'dup',
      plugins: [{ name: 'a', source: 'a' }, { name: 'b', source: 'b' }],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins).toHaveLength(1);
    expect(result.marketplace.plugins[0]?.version).toBe('1.0.0');
  });

  it('redacts host paths from the detail when the manifest cannot be resolved', async () => {
    const root = makeRoot();
    writeManifest(root, { name: 'lib', plugins: [] });
    // realpath 的 ENOENT/EACCES message 自带完整宿主路径;detail 会经 IPC 原样
    // 转发 Renderer,必须脱敏。用 mock 确定性地触发 catch 分支。
    const spy = vi.spyOn(fs.promises, 'realpath').mockRejectedValue(
      Object.assign(
        new Error("ENOENT: no such file or directory, realpath '/Users/alice/.config/secret'"),
        { code: 'ENOENT' },
      ),
    );
    try {
      const result = await discoverMarketplace(root);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail ?? '').not.toContain('alice');
      expect(result.detail ?? '').not.toContain('/Users/');
      // 仍保留可引导的原因文本。
      expect(result.detail ?? '').toContain('ENOENT');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects an oversized marketplace manifest instead of parsing it', async () => {
    const root = makeRoot();
    const file = path.join(root, '.agents', 'plugins', 'marketplace.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 市场仓库是不受信内容:超大清单必须在 readFile 之前按大小拒绝,不能靠解析。
    fs.writeFileSync(file, `{"name":"big","plugins":[],"pad":"${'x'.repeat(1024 * 1024)}"}`);

    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('regular file within');
  });

  it('skips a plugin whose ghost.json is oversized without reading it', async () => {
    const root = makeRoot();
    writePlugin(root, 'plugins/good', 'good-one');
    const bigDir = path.join(root, 'plugins', 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(
      path.join(bigDir, 'ghost.json'),
      `{"schemaVersion":2,"id":"big","pad":"${'x'.repeat(600 * 1024)}"}`,
    );
    writeManifest(root, {
      name: 'sized',
      plugins: [
        { name: 'good', source: 'plugins/good' },
        { name: 'big', source: 'plugins/big' },
      ],
    });

    // 关键断言是"没有去读":超大身份卡若被 readFile 进内存,拒绝就晚了(OOM 防护
    // 的意义就在读之前)。仅断言"被跳过"没有牙齿——解析/校验失败同样会跳过。
    const realReadFile = fs.promises.readFile;
    const readTargets: string[] = [];
    const spy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(((target: unknown, ...rest: unknown[]) => {
        readTargets.push(String(target));
        return (realReadFile as (...args: unknown[]) => unknown)(target, ...rest);
      }) as typeof fs.promises.readFile);
    try {
      const result = await discoverMarketplace(root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
      expect(result.marketplace.skippedCount).toBe(1);
      expect(readTargets.some((target) => target.includes(path.join('big', 'ghost.json')))).toBe(
        false,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a manifest that lists an absurd number of plugin entries', async () => {
    const root = makeRoot();
    // 每个条目都触发 realpath + 读身份卡:十万条目能把快照/列表/刷新拖死。
    writeManifest(root, {
      name: 'flood',
      plugins: Array.from({ length: 513 }, (_, index) => ({
        name: `p${index}`,
        source: `plugins/p${index}`,
      })),
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('more than');
  });

  it('rejects marketplace names that are oversized or carry control characters', async () => {
    for (const name of ['x'.repeat(129), 'evil‮name', 'line\nbreak']) {
      const root = makeRoot();
      writeManifest(root, { name, plugins: [] });
      const result = await discoverMarketplace(root);
      expect(result.ok).toBe(false);
    }
    // 合法边界值仍然接受。
    const root = makeRoot();
    writeManifest(root, { name: 'x'.repeat(128), plugins: [] });
    expect((await discoverMarketplace(root)).ok).toBe(true);
  });

  it('drops an invalid displayName instead of failing the market', async () => {
    const root = makeRoot();
    writeManifest(root, {
      name: 'lib',
      interface: { displayName: 'bad‮display' },
      plugins: [],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.displayName).toBeNull();
  });

  // 无宿主 symlink 权限时跳过集成夹具；Windows lstat 回退由 readBoundedFile.test.ts
  // 的注入用例继续覆盖，不会随这里的 capability skip 一起消失。
  it.skipIf(!canSymlink)('skips a plugin whose ghost.json is a symlink, even to a valid manifest outside', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    // 市场外放一份**内容完全合法**的身份卡:只断言"被跳过"才有区分度——
    // 若 lstat 闸退回 stat,这份外部身份卡会被解析并投影给 Renderer。
    // (/dev/zero 一类特殊文件是同一漏洞的 DoS 形态:stat.size 为 0 绕过大小闸
    // 后 readFile 无限读;lstat 拒掉 symlink 本身,两种形态一起堵死。)
    const target = path.join(outside, 'stolen-ghost.json');
    fs.writeFileSync(target, ghostJson('stolen'));
    writePlugin(root, 'plugins/good', 'good-one');
    const evilDir = path.join(root, 'plugins', 'evil');
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, 'main.js'), '// entry');
    fs.symlinkSync(target, path.join(evilDir, 'ghost.json'));
    writeManifest(root, {
      name: 'linked-card',
      plugins: [
        { name: 'good', source: 'plugins/good' },
        { name: 'evil', source: 'plugins/evil' },
      ],
    });

    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
    expect(result.marketplace.skippedCount).toBe(1);
  });

  it('validates and reads ghost.json through one file handle', async () => {
    const root = makeRoot();
    writePlugin(root, 'plugins/good', 'good-one');
    writeManifest(root, { name: 'lib', plugins: [{ name: 'good', source: 'plugins/good' }] });

    // 校验与读取必须共用同一句柄:路径式 lstat/readFile 是两次独立打开,并发方
    // 可以在两次之间把身份卡换成超大文件或设备链接。此断言防止退回两段式实现。
    const pathReads: string[] = [];
    const realRead = fs.promises.readFile;
    const readSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(((target: unknown, ...rest: unknown[]) => {
        pathReads.push(String(target));
        return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
      }) as typeof fs.promises.readFile);
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    try {
      const result = await discoverMarketplace(root);
      expect(result.ok).toBe(true);
      expect(pathReads.some((target) => path.basename(target) === 'ghost.json')).toBe(false);
      const lstatByPath = lstatSpy.mock.calls.some(
        (call) => path.basename(String(call[0])) === 'ghost.json',
      );
      // Windows 没有 O_NOFOLLOW，安全读取器必须用 lstat + inode 对账回退。
      expect(lstatByPath).toBe(fs.constants.O_NOFOLLOW == null);
    } finally {
      readSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it('rejects a manifest whose real path escapes the market root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    // 恶意市场把清单做成指向根目录外的 symlink,借宿主之手读任意路径。
    const outsideManifestDir = path.join(outside, 'manifest');
    fs.mkdirSync(outsideManifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideManifestDir, 'marketplace.json'),
      JSON.stringify({ name: 'stolen', plugins: [] }),
    );
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.symlinkSync(
      outsideManifestDir,
      path.join(root, '.agents', 'plugins'),
      directoryLinkType,
    );

    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MARKET_SOURCE_INVALID');
  });

  it('rejects manifests without a name or with a non-array plugins field', async () => {
    const root = makeRoot();
    writeManifest(root, { plugins: [] });
    expect((await discoverMarketplace(root)).ok).toBe(false);

    const root2 = makeRoot();
    writeManifest(root2, { name: 'x', plugins: {} });
    expect((await discoverMarketplace(root2)).ok).toBe(false);
  });

  it('logs why an entry was skipped when the plugin directory has no ghost.json', async () => {
    const root = makeRoot();
    writeManifest(root, { name: 'sub-market', plugins: [{ source: './plugins/dep' }] });
    // Git submodule 未递归检出的形态:目录在,ghost.json 不在。市场 clone 不带
    // --recurse-submodules,所以这是"市场发现出 0 个插件"最常见的成因。
    fs.mkdirSync(path.join(root, 'plugins', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "plugins/dep"]');

    const result = await discoverMarketplace(root);

    // 既有事实不变:清单本身合法,来源照旧可用,条目静默跳过——没有任何错误码。
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins).toHaveLength(0);
    expect(result.marketplace.skippedCount).toBe(1);
    expect(result.marketplace.unreadableCount).toBe(0);
    // 唯一的新增:排查者能定位到是第几条、哪个路径、为什么。path 是清单自报的
    // repo-relative 路径原样回显(逻辑路径,不跟随宿主分隔符)。
    const logged = lastSkipLog();
    expect(logged.market).toBe('sub-market');
    expect(logged.declared).toBe(1);
    expect(logged.accepted).toBe(0);
    expect(logged.skippedCount).toBe(1);
    expect(logged.entries).toEqual([
      { index: 0, path: './plugins/dep', reason: 'manifest-missing', errno: 'ENOENT' },
    ]);
  });

  it('does not claim a bounded-read rejection is a non-regular file', async () => {
    const root = makeRoot();
    const bigDir = path.join(root, 'plugins', 'big');
    fs.mkdirSync(bigDir, { recursive: true });
    // 超过 GHOST_MANIFEST_MAX_BYTES:限量读取闸返回 null,与"非普通文件""根内复核
    // 不过"共用同一个信号。reason 因此不得对文件类型下断言,否则排障者会去查
    // symlink / 文件类型,而真因是体积。
    fs.writeFileSync(
      path.join(bigDir, 'ghost.json'),
      `{"schemaVersion":2,"id":"big","pad":"${'x'.repeat(600 * 1024)}"}`,
    );
    writeManifest(root, { name: 'sized-log', plugins: [{ source: 'plugins/big' }] });

    const result = await discoverMarketplace(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.skippedCount).toBe(1);
    expect(lastSkipLog().entries[0]?.reason).toBe('manifest-bounded-read-rejected');
  });

  it('strips unicode line separators from logged paths and market names', async () => {
    const root = makeRoot();
    // U+2028 / U+2029 / NEL 不在 C0 与双向控制符集合里,JSON.stringify 也不转义它们,
    // 查看器却按换行渲染 —— 不剥离就能把一行 warn 劈成攻击者控制的多行。
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const nel = String.fromCharCode(0x85);
    const hostileRel = `plugins/a${ls}fake-log-line${ps}b${nel}c`;
    // 市场名同源同险:它那道准入闸(FORBIDDEN_NAME_CHARS)不含这三个码位,所以带
    // 换行的名字能通过校验,日志侧必须自己消毒。
    const hostileName = `mkt${ls}fake-log-line`;
    writeManifest(root, { name: hostileName, plugins: [{ source: hostileRel }] });

    const result = await discoverMarketplace(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.skippedCount).toBe(1);
    // 准入判据未改:名字照旧被接受,只是进日志前被剥离。
    expect(result.marketplace.name).toBe(hostileName);
    const logged = lastSkipLog();
    expect(logged.entries[0]?.path).toBe('plugins/afake-log-linebc');
    expect(logged.market).toBe('mktfake-log-line');
  });

  it('caps skip details and reports how many were dropped', async () => {
    const root = makeRoot();
    // 损坏或恶意清单可有数百条非法条目;发现会被列表/快照/详情反复调用,明细必须限量。
    writeManifest(root, {
      name: 'noisy',
      plugins: Array.from({ length: 25 }, () => 'not-an-object'),
    });

    const result = await discoverMarketplace(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.skippedCount).toBe(25);
    const logged = lastSkipLog();
    expect(logged.entries).toHaveLength(20);
    expect(logged.detailsTruncated).toBe(5);
  });
});
