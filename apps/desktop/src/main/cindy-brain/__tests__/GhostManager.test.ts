import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostManager } from '../GhostManager';

/** 每个用例独立的临时仓库根 + 源文件目录(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let rootDir: string;
let onChanged: ReturnType<typeof vi.fn>;
let manager: GhostManager;
let hostLocale: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-test-'));
  rootDir = path.join(workDir, 'ghosts');
  onChanged = vi.fn();
  hostLocale = 'zh-CN';
  manager = new GhostManager({
    getRootDir: () => rootDir,
    getLocale: () => hostLocale,
    onChanged,
  });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

/** 一份全绿的清单基底(芯片,意识唯一形态)。普通 main.js 仍由 forge 提前核对。 */
function goodManifest(id = 'hello'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
  };
}

/** 带显式指令的芯片型清单(command 查重用例)。 */
function chipManifestWithCommand(id: string, command: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: `Chip ${id}`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
    command,
  };
}

/** 生成 .cindy 测试文件;entries 为额外文件(路径 → 内容),manifest=null 表示不放 ghost.json。 */
async function makeCindy(
  fileName: string,
  manifest: Record<string, unknown> | null,
  entries: Record<string, string> = {},
): Promise<string> {
  const zip = new JSZip();
  if (manifest) zip.file('ghost.json', JSON.stringify(manifest));
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = path.join(workDir, fileName);
  await fs.promises.writeFile(out, buf);
  return out;
}

async function expectRejection(
  result: Awaited<ReturnType<GhostManager['install']>>,
  code: string,
): Promise<void> {
  expect('rejection' in result, JSON.stringify(result)).toBe(true);
  expect((result as { rejection: { code: string } }).rejection.code).toBe(code);
}

describe('GhostManager · install', () => {
  it('按宿主语言返回本地化清单，切换语言后 list 立即更新，不支持语言固定回退英文', async () => {
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      description: 'Base description',
      locales: {
        en: 'locales/en.json',
        'zh-CN': 'locales/zh-CN.json',
      },
    };
    const locale = (name: string, description: string, toolDescription: string) => JSON.stringify({
      name,
      description,
      tools: { do_thing: { description: toolDescription } },
    });
    const cindy = await makeCindy('localized.cindy', manifest, {
      'locales/en.json': locale('English name', 'English description', 'English tool'),
      'locales/zh-CN.json': locale('中文名称', '中文说明', '中文工具'),
    });
    const result = await manager.install(cindy);
    expect(result).toMatchObject({
      ghost: {
        manifest: {
          name: '中文名称',
          description: '中文说明',
          resolvedLocale: 'zh-CN',
          tools: [{ name: 'do_thing', description: '中文工具' }],
        },
      },
    });

    hostLocale = 'ja';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      description: 'English description',
      resolvedLocale: 'ja',
      tools: [{ name: 'do_thing', description: 'English tool' }],
    });
    hostLocale = 'fr-FR';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      resolvedLocale: 'en',
    });
  });

  it('已安装 locale 或其父目录被替换为目录外软链时拒绝读取并回退基础清单', async () => {
    hostLocale = 'en';
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      locales: { en: 'locales/en.json' },
    };
    const locale = (name: string) => JSON.stringify({
      name,
      tools: { do_thing: { description: 'Localized tool' } },
    });
    const cindy = await makeCindy('localized-symlink.cindy', manifest, {
      'locales/en.json': locale('Packaged name'),
    });
    await manager.install(cindy);
    const localePath = path.join(rootDir, 'hello', 'locales', 'en.json');
    const outsidePath = path.join(workDir, 'outside-locale.json');
    await fs.promises.writeFile(outsidePath, locale('Outside name'));
    await fs.promises.rm(localePath);
    try {
      await fs.promises.symlink(outsidePath, localePath, 'file');
    } catch {
      return; // Windows 无 symlink 权限时跳过；生产守卫仍由 lstatSync 钉死。
    }

    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Base name',
      resolvedLocale: 'en',
      tools: [{ name: 'do_thing', description: '做点事' }],
    });

    const localesDir = path.dirname(localePath);
    const outsideLocalesDir = path.join(workDir, 'outside-locales');
    await fs.promises.rm(localesDir, { recursive: true, force: true });
    await fs.promises.mkdir(outsideLocalesDir);
    await fs.promises.writeFile(path.join(outsideLocalesDir, 'en.json'), locale('Outside parent name'));
    await fs.promises.symlink(
      outsideLocalesDir,
      localesDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Base name',
      resolvedLocale: 'en',
    });
  });

  it('locale 文件缺失、非法 JSON 或缺少工具翻译时 inspect/install 都拒绝', async () => {
    const manifest = {
      ...goodManifest(),
      locales: { en: 'locales/en.json' },
    };
    const missing = await makeCindy('locale-missing.cindy', manifest);
    await expectRejection(await manager.install(missing), 'file-invalid');

    const invalid = await makeCindy('locale-invalid.cindy', manifest, {
      'locales/en.json': '{ nope',
    });
    await expectRejection(await manager.install(invalid), 'file-invalid');

    const incomplete = await makeCindy('locale-incomplete.cindy', manifest, {
      'locales/en.json': JSON.stringify({ name: 'English', tools: {} }),
    });
    await expectRejection(await manager.install(incomplete), 'file-invalid');

    const aliasedManifest = await makeCindy('locale-manifest-alias.cindy', goodManifest(), {
      'GHOST.JSON': JSON.stringify({ name: 'Alias locale' }),
    });
    await expectRejection(await manager.install(aliasedManifest), 'file-invalid');
  });

  it('装入合法 .cindy:目录落地、ghost.json 在位、list 可见、onChanged 收到全量清单', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest(), { 'assets/readme.txt': 'hi' });
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.id).toBe('hello');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'readme.txt'))).toBe(true);

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0].map((c: InstalledGhost) => c.manifest.id)).toEqual(['hello']);
  });

  it('initiallyEnabled=false:装入即沉睡(.disabled 与目录同帧就位,首个广播就是沉睡态)', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest());
    const result = await manager.install(cindy, { initiallyEnabled: false });
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    // 首个 onChanged 广播里就是沉睡态(不存在"先启用一帧再熄灯"的跳变)。
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0][0].enabled).toBe(false);
    // 重新启用即撕掉标记。
    await manager.setEnabled('hello', true);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('容忍"多包一层文件夹"的压缩形态(ghost.json 在唯一顶层目录下)', async () => {
    const zip = new JSZip();
    zip.file('hello-pack/ghost.json', JSON.stringify(goodManifest()));
    zip.file('hello-pack/assets/a.txt', 'a');
    const out = path.join(workDir, 'wrapped.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await manager.install(out);
    expect('ghost' in result).toBe(true);
    // 包裹层被剥掉:内容直接落在 <root>/hello/ 下
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'a.txt'))).toBe(true);
  });

  it('源文件不存在 → source-not-found', async () => {
    await expectRejection(await manager.install(path.join(workDir, 'nope.cindy')), 'source-not-found');
  });

  it('不是 zip 的文件 → file-invalid', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'this is not a zip');
    await expectRejection(await manager.install(bad), 'file-invalid');
  });

  it('缺 ghost.json → file-invalid', async () => {
    const cindy = await makeCindy('no-manifest.cindy', null, { 'readme.txt': 'x' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('ghost.json 不是合法 JSON → file-invalid', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', '{ not json');
    const out = path.join(workDir, 'badjson.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
    await expectRejection(await manager.install(out), 'file-invalid');
  });

  it('清单不合格(老声明型格式,已移除)→ file-invalid', async () => {
    const cindy = await makeCindy('decl.cindy', {
      schemaVersion: 1,
      id: 'legacy',
      name: '老声明型',
      version: '1.0.0',
      kind: 'declaration',
      panel: { title: '静态面板', body: '一段文字' },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('Node 清单声明的 worker 不在包内 → inspect/install 都拒绝', async () => {
    const manifest = {
      ...goodManifest(),
      slots: ['node'],
      tools: undefined,
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
    };
    const cindy = await makeCindy('missing-node.cindy', manifest);
    expect(await manager.inspect(cindy)).toMatchObject({
      rejection: { code: 'file-invalid', reason: expect.stringContaining('node/worker.cjs') },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it.each(['.disabled', '.cindy-trust.json', '.CINDY-TRUST.JSON'])(
    '包不能自带主机保留文件 %s',
    async (reservedFile) => {
      const cindy = await makeCindy('reserved.cindy', goodManifest(), {
        [reservedFile]: '{}',
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: {
          code: 'file-invalid',
          reason: expect.stringContaining('主机保留文件'),
        },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
    },
  );

  it('zip-slip(条目路径带 ../)→ file-invalid,且仓库外不落任何文件', async () => {
    const cindy = await makeCindy('slip.cindy', goodManifest(), { '../evil.txt': 'pwned' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
    expect(fs.existsSync(path.join(workDir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false); // staging 已清理,无半截安装
    expect(onChanged).not.toHaveBeenCalled();
  });

  // `a//b` 空段变体 JSZip 写入时会自行归一,构造不出夹具;守卫仍覆盖它。
  it.each(['x/../ghost.json', './ghost.json', '/ghost.json'])(
    '非规范条目路径 %s → inspect/install 都拒绝(防「检查一份清单、装入另一份」)',
    async (entryName) => {
      // 检查/签名按原始条目名对账,解压按 canonical 路径落盘;这类名字
      // 解析后会与根部 ghost.json 撞同一落盘位置,必须在读清单前整包拒。
      const evilManifest = JSON.stringify({ ...goodManifest(), name: '偷换的' });
      const cindy = await makeCindy('noncanonical.cindy', goodManifest(), {
        [entryName]: evilManifest,
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: { code: 'file-invalid', reason: expect.stringContaining('非法路径') },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
      expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it('重复装入同 id → already-installed,原安装不受影响', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();
    await expectRejection(await manager.install(await makeCindy('b.cindy', goodManifest())), 'already-installed');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('显式指令撞名(含大小写折叠)→ command-conflict;不撞则各装各的', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await expectRejection(
      await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'draw'))),
      'command-conflict',
    );
    expect(fs.existsSync(path.join(rootDir, 'beta'))).toBe(false); // 半点不落盘
    const ok = await manager.install(await makeCindy('c.cindy', chipManifestWithCommand('gamma', '画图')));
    expect('ghost' in ok).toBe(true);
    expect(manager.list().map((g) => g.manifest.id)).toEqual(['alpha', 'gamma']);
  });
});

describe('GhostManager · uninstall', () => {
  it('卸下已装意识:目录消失、list 变空、onChanged 广播', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello');
    expect('ok' in result).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0]).toEqual([]);
  });

  it('host 可延后卸载广播，先完成 tombstone 等事务后再发一致快照', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello', { notify: false });

    expect('ok' in result).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('卸未装的 id → not-installed', async () => {
    const result = await manager.uninstall('ghost');
    expect((result as { rejection: { code: string } }).rejection.code).toBe('not-installed');
  });

  it('非法 id(路径穿越企图)→ invalid-id,不触碰文件系统', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    const sibling = path.join(workDir, 'victim');
    await fs.promises.mkdir(sibling);
    for (const id of ['../victim', '..\\victim', 'a/b', 'A', '']) {
      const result = await manager.uninstall(id);
      expect((result as { rejection: { code: string } }).rejection.code, id).toBe('invalid-id');
    }
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('卸下再重装同一个 .cindy → 复活(装/卸/装全链路)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });
});

describe('GhostManager · list', () => {
  it('根目录不存在 → 空清单(不报错)', () => {
    expect(manager.list()).toEqual([]);
  });

  it('坏目录只影响自己:无 ghost.json / 清单非法 / 目录名与 id 不符的都被跳过', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 手工捏三个坏目录
    await fs.promises.mkdir(path.join(rootDir, 'no-manifest'));
    await fs.promises.mkdir(path.join(rootDir, 'bad-manifest'));
    await fs.promises.writeFile(path.join(rootDir, 'bad-manifest', 'ghost.json'), '{ nope');
    await fs.promises.mkdir(path.join(rootDir, 'wrong-name'));
    await fs.promises.writeFile(
      path.join(rootDir, 'wrong-name', 'ghost.json'),
      JSON.stringify(goodManifest('other-id')),
    );
    // 隐藏目录(staging 残留形态)也不进清单
    await fs.promises.mkdir(path.join(rootDir, '.cindy-installing-x-deadbeef'));

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });

  it('多意识按 id 排序', async () => {
    await manager.install(await makeCindy('b.cindy', { ...goodManifest('zulu'), name: 'Z' }));
    await manager.install(await makeCindy('a.cindy', { ...goodManifest('alpha'), name: 'A' }));
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['alpha', 'zulu']);
  });
});

describe('GhostManager · setEnabled(启用/停用)', () => {
  it('停用:目录里出现 .disabled 标记、list 报 enabled=false、onChanged 广播;启用即恢复', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const off = await manager.setEnabled('hello', false);
    expect('ok' in off).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);

    const on = await manager.setEnabled('hello', true);
    expect('ok' in on).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('幂等:重复停用/重复启用不报错', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
  });

  it('未装的 id → not-installed;非法 id → invalid-id', async () => {
    const ghost = await manager.setEnabled('ghost', false);
    expect((ghost as { rejection: { code: string } }).rejection.code).toBe('not-installed');
    const evil = await manager.setEnabled('../evil', false);
    expect((evil as { rejection: { code: string } }).rejection.code).toBe('invalid-id');
  });

  it('新装/重装的意识默认启用', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.setEnabled('hello', false);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(manager.list()[0].enabled).toBe(true);
  });
});

describe('GhostManager · inspect(只验不装)', () => {
  it('合法 .cindy → 返回清单,且零副作用(仓库目录不被创建)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    const result = await manager.inspect(cindy);
    expect('manifest' in result).toBe(true);
    expect((result as { manifest: { id: string } }).manifest.id).toBe('hello');
    expect((result as { packageSha256: string }).packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(rootDir)).toBe(false); // 未装入,仓库根都不该出现
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('确认后源文件被替换时，整包指纹不一致会拒绝安装', async () => {
    const cindy = await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'before' });
    const inspected = await manager.inspect(cindy);
    expect('packageSha256' in inspected).toBe(true);
    const expectedPackageSha256 = (inspected as { packageSha256: string }).packageSha256;

    await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'after' });
    await expectRejection(
      await manager.install(cindy, { expectedPackageSha256 }),
      'file-invalid',
    );
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it('坏文件 → 与 install 同分类拒绝', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    const result = await manager.inspect(bad);
    expect((result as { rejection: { code: string } }).rejection.code).toBe('file-invalid');
  });
});

describe('GhostManager · author / icon(身份卡展示字段)', () => {
  const iconManifest = (): Record<string, unknown> => ({
    ...goodManifest(),
    author: 'Lizi',
    icon: 'assets/icon.png',
  });

  it('inspect / install / list 全链路带出 iconDataUrl 与 author', async () => {
    const cindy = await makeCindy('icon.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });

    const inspected = await manager.inspect(cindy);
    expect('manifest' in inspected).toBe(true);
    const ok = inspected as { manifest: { author?: string }; iconDataUrl?: string };
    expect(ok.manifest.author).toBe('Lizi');
    expect(ok.iconDataUrl).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);

    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.iconDataUrl).toBe(ok.iconDataUrl);
    // list 从安装目录读盘重建,与装入时一致
    expect(manager.list()[0].iconDataUrl).toBe(ok.iconDataUrl);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'icon.png'))).toBe(true);
  });

  it('清单声明了 icon 但包内缺文件 → file-invalid', async () => {
    const cindy = await makeCindy('no-icon.cindy', iconManifest());
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('icon 超过 512KB 上限 → file-invalid', async () => {
    const cindy = await makeCindy('fat-icon.cindy', iconManifest(), {
      'assets/icon.png': 'x'.repeat(512 * 1024 + 1),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('已装意识的 icon 文件事后丢失 → list 降级为无图标,不影响意识本体', async () => {
    const cindy = await makeCindy('icon2.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });
    await manager.install(cindy);
    await fs.promises.rm(path.join(rootDir, 'hello', 'assets', 'icon.png'));
    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].iconDataUrl).toBeUndefined();
    expect(listed[0].manifest.author).toBe('Lizi');
  });

  it('不带 icon/author 的旧清单不受影响(无 iconDataUrl 字段)', async () => {
    await manager.install(await makeCindy('plain.cindy', goodManifest()));
    const listed = manager.list();
    expect(listed[0].iconDataUrl).toBeUndefined();
    expect(listed[0].manifest.author).toBeUndefined();
  });
});

describe('GhostManager · update(原位换版)', () => {
  it('happy path:版本替换、旧文件清干净、目录不变、onChanged 广播', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    onChanged.mockClear();

    const v2 = await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }, { 'new.txt': 'v2' });
    const result = await manager.update(v2);
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.version).toBe('2.0.0');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(false); // 换版不留旧文件
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 备份/staging 临时目录不残留。
    const leftovers = fs.readdirSync(rootDir).filter((n) => n.startsWith('.cindy-'));
    expect(leftovers).toEqual([]);
  });

  it('唤醒状态延续:沉睡中更新仍沉睡,唤醒中更新仍唤醒', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()), { initiallyEnabled: false });
    const r1 = await manager.update(await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }));
    expect((r1 as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);

    await manager.setEnabled('hello', true);
    const r2 = await manager.update(await makeCindy('v3.cindy', { ...goodManifest(), version: '3.0.0' }));
    expect((r2 as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
  });

  it('未装入 → not-installed 拒绝', async () => {
    await expectRejection(await manager.update(await makeCindy('a.cindy', goodManifest())), 'not-installed');
  });

  it('指令查重豁免自己,但仍拦别人的指令', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'Paint')));

    // 自己沿用自己的指令 → 放行。
    const keep = await manager.update(
      await makeCindy('a2.cindy', { ...chipManifestWithCommand('alpha', 'draw'), version: '2.0.0' }),
    );
    expect('ghost' in keep, JSON.stringify(keep)).toBe(true);

    // 新版本改用别人占用的指令 → 拒,且旧版原样在位。
    await expectRejection(
      await manager.update(
        await makeCindy('a3.cindy', { ...chipManifestWithCommand('alpha', 'paint'), version: '3.0.0' }),
      ),
      'command-conflict',
    );
    const alpha = manager.list().find((g) => g.manifest.id === 'alpha');
    expect(alpha?.manifest.version).toBe('2.0.0');
  });

  it('坏文件 → file-invalid,已装版本不受影响', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    await expectRejection(await manager.update(bad), 'file-invalid');
    expect(manager.list().find((g) => g.manifest.id === 'hello')?.manifest.version).toBe('1.0.0');
  });
});

describe('GhostManager · skill 槽装入校验(确认框看到的 = Agent 读到的)', () => {
  const skillManifest = (
    items: Array<Record<string, string>> = [
      { dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' },
    ],
  ): Record<string, unknown> => ({
    ...goodManifest('skilled'),
    slots: ['tool', 'skill'],
    skill: { items },
  });
  const skillMd = (name: string, description: string, body = '正文'): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  it('SKILL.md 在场且 frontmatter 与声明一致 → 装入,落盘为普通文件', async () => {
    const cindy = await makeCindy('skill-good.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo'),
      'skills/foo/reference.md': '附带资料',
    });
    const result = await manager.install(cindy);
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const landed = path.join(rootDir, 'skilled', 'skills', 'foo', 'SKILL.md');
    const st = await fs.promises.lstat(landed);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('声明的技能目录缺 SKILL.md → 拒装', async () => {
    const cindy = await makeCindy('skill-missing.cindy', skillManifest(), {
      'skills/foo/notes.md': '没有 SKILL.md',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter name 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-name-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('bar', '教 Agent 用 foo'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter description 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-desc-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '偷偷换一份说明'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter 缺 description → 拒装', async () => {
    const cindy = await makeCindy('skill-no-desc.cindy', skillManifest(), {
      'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文\n',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('SKILL.md 超过字节上限 → 拒装', async () => {
    const cindy = await makeCindy('skill-huge.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo', 'x'.repeat(64 * 1024 + 1)),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });
});
