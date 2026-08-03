/**
 * forge.test.ts — 意识锻造打包(packGhostDir)单测。
 * 纯 Node 直测(规则 14):tmpdir 造源码目录 → 打包 → 用 GhostManager
 * 的 inspect 反向验证产物能被装入侧认可(两侧同一契约不漂移)。
 * 规则 23:全部路径在 os.tmpdir 下,收尾清理。
 */

import fs from 'node:fs';
import JSZip from 'jszip';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FORGE_GUIDE,
  packGhostDir,
  packGhostDirToFile,
  scaffoldGhostDir,
  type ForgeScaffoldTemplate,
} from '../forge';
import { GhostManager } from '../GhostManager';

const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-symlink-probe-'));
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

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-test-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

const GOOD_MANIFEST = {
  schemaVersion: 2,
  id: 'demo',
  name: '演示意识',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['tool'],
  tools: [{ name: 'do_thing', description: '做点事' }],
};

/** 造一个源码目录;files 为相对路径 → 内容。 */
async function makeSrcDir(files: Record<string, string>): Promise<string> {
  const dir = path.join(workDir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  return dir;
}

describe('packGhostDir', () => {
  it('happy path:产物落源码目录(id-version.cindy),且能被装入侧 inspect 认可', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'assets/readme.txt': 'hi',
    });
    const r = await packGhostDir(dir);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.cindyPath).toBe(path.join(dir, 'demo-1.0.0.cindy'));
    expect(r.manifest.id).toBe('demo');

    // 装入侧同一契约验证:inspect 直接吃打包产物。
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(r.cindyPath);
    expect('manifest' in inspected, JSON.stringify(inspected)).toBe(true);

    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('打包进 zip 的 ghost.json 是校验时的快照,并发改写不生效(防 TOCTOU)', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    // 模拟"校验通过后、写入 zip 前"目录被并发改写:保 id/version,偷加权限声明。
    // 若打包时重读磁盘,包里的 manifest 会与返回值(安装侧审阅比对的依据)分叉。
    const tampered = JSON.stringify({ ...GOOD_MANIFEST, slots: ['tool', 'network'], network: { allow: ['x.test'] } });
    const realRead = fs.promises.readFile;
    let ghostReads = 0;
    const spy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(((target: unknown, ...rest: unknown[]) => {
        if (String(target).endsWith('ghost.json')) {
          ghostReads += 1;
          if (ghostReads > 1) return Promise.resolve(Buffer.from(tampered));
        }
        return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
      }) as typeof fs.promises.readFile);
    try {
      const r = await packGhostDir(dir);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      const zip = await JSZip.loadAsync(await realRead(r.cindyPath));
      const packedManifest = JSON.parse(await zip.file('ghost.json')!.async('string'));
      // 包里的 manifest 必须与返回值一致(校验时的快照),不能是改写后的版本。
      expect(packedManifest.slots).toEqual(GOOD_MANIFEST.slots);
      expect(packedManifest).not.toHaveProperty('network');
      await fs.promises.rm(r.cindyPath, { force: true });
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(!canSymlink)('ghost.json 为符号链接 → MANIFEST_INVALID(与市场发现/安装同一把闸)', async () => {
    // 符号链接:目标是合法清单也不放行——“符号链接一律不穿透”覆盖身份卡本身,
    // 否则打包输入目录里一根链接就能把目录外的文件读进打包管道。
    const outside = path.join(workDir, 'outside-ghost.json');
    await fs.promises.writeFile(outside, JSON.stringify(GOOD_MANIFEST));
    const linked = path.join(workDir, 'src-linked');
    await fs.promises.mkdir(linked, { recursive: true });
    await fs.promises.symlink(outside, path.join(linked, 'ghost.json'));
    await fs.promises.writeFile(path.join(linked, 'main.js'), '// brain');
    expect(await packGhostDir(linked)).toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });
  });

  it('ghost.json 超限 → MANIFEST_INVALID(与市场发现/安装同一把闸)', async () => {
    // 超限:JSON 本身合法(合法清单 + 尾随空白撑体积),必须在读取层按大小拒,
    // 不能等到 JSON.parse/validate——那时数 GB 的文件已经进内存了。
    const big = path.join(workDir, 'src-big');
    await fs.promises.mkdir(big, { recursive: true });
    await fs.promises.writeFile(
      path.join(big, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST) + ' '.repeat(600 * 1024),
    );
    await fs.promises.writeFile(path.join(big, 'main.js'), '// brain');
    const r = await packGhostDir(big);
    expect(r).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });
    if (!r.ok) expect(r.message).toContain('不是普通文件或超过');
  });

  it('zip 阶段逐文件走剩余预算限量闸:walk 之后被撑大的文件结构化拒绝', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    // 33MiB 零填充:超总预算(32MiB),但压缩后极小——旧实现无界 readFile 后
    // 整包压缩体积检查照样通过,超大字节已经进过内存。
    await fs.promises.writeFile(path.join(dir, 'blob.bin'), Buffer.alloc(33 * 1024 * 1024));
    // 模拟"walk 预算预估时文件还小,zip 读取时已被并发撑大":walk 的 stat 看
    // 到 10 字节。句柄侧 handle.stat 不受此 spy 影响,读到真实大小。
    const realStat = fs.promises.stat;
    const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      target: Parameters<typeof fs.promises.stat>[0],
      ...rest: unknown[]
    ) => {
      const st = await (realStat as (...a: unknown[]) => Promise<fs.Stats>)(target, ...rest);
      if (String(target).endsWith('blob.bin')) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 10 });
      }
      return st;
    }) as typeof fs.promises.stat);
    try {
      const r = await packGhostDir(dir);
      expect(r).toMatchObject({ ok: false, errorCode: 'TOO_LARGE' });
      if (!r.ok) expect(r.message).toContain('打包期间被并发改动或超出剩余体积预算');
    } finally {
      spy.mockRestore();
    }
  });

  it('打包器不自我参照:realpath 与调用方给定的规范根不一致 → 拒绝', async () => {
    // 只靠"自己 realpath 一次、再拿它当 containWithin 锚点"是自我参照:目录在
    // 调用方校验之后、这里解析之前被换成指向外部的链接时,锚点就是那个外部目录,
    // 包含性判定全部通过,外部 payload 会被打包。锚点必须由上游给。
    const outside = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// outside payload',
      'secret.txt': 'EXFILTRATED',
    });
    const staged = path.join(workDir, 'staged');
    await fs.promises.mkdir(staged, { recursive: true });
    const pluginDir = path.join(staged, 'alpha');
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST),
    );
    await fs.promises.writeFile(path.join(pluginDir, 'main.js'), '// brain');
    // 调用方(安装管道)校验时拿到的规范根。
    const expectedRealDir = await fs.promises.realpath(pluginDir);
    // 校验之后被换成指向外部目录的链接(外部目录留着同样的 ghost.json)。
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
    await fs.promises.symlink(
      await fs.promises.realpath(outside),
      pluginDir,
      directoryLinkType,
    );

    const dest = path.join(workDir, 'out.cindy');
    const r = await packGhostDirToFile(pluginDir, dest, expectedRealDir);
    expect(r).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });
    if (!r.ok) expect(r.message).toContain('打包前被替换');
    // 外部 payload 一个字节都没进包(产物根本没生成)。
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('规范根一致时正常打包(锚点校验不误伤)', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    const dest = path.join(workDir, 'ok.cindy');
    const realDir = await fs.promises.realpath(dir);
    const r = await packGhostDirToFile(realDir, dest, realDir);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('结构守卫:forge.ts 与 ghostLocaleFiles.ts 不允许出现按路径的 readFile', async () => {
    // 打包管道触及的都是用户可写目录,所有读取必须走 readBoundedFileNoFollow
    // 系列;任何一处退回按路径 readFile 都会重开"检查与读取两次打开"的窗口。
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../forge.ts', '../ghostLocaleFiles.ts']) {
      const source = await fs.promises.readFile(path.join(here, rel), 'utf8');
      expect(source, rel).not.toMatch(/fs\.promises\.readFile\(/);
      expect(source, rel).not.toMatch(/readFileSync\(/);
      expect(source, rel).toMatch(/readBoundedFileNoFollow/);
    }
  });

  it('打包跳过开发残留:.git / node_modules / 隐藏文件 / 旧 .cindy 不进包', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      '.git/HEAD': 'ref',
      '.DS_Store': 'junk',
      'node_modules/x/package.json': '{}',
      'old.cindy': 'stale zip',
    });
    const r = await packGhostDir(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(r.cindyPath));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.sort()).toEqual(['ghost.json', 'main.js']);
    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('Node 插件把预打包 worker 带进 .cindy，装入侧能核对入口在场', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      slots: ['node'],
      tools: undefined,
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// browser brain',
      'node/worker.cjs': '// bundled node worker',
    });
    const packed = await packGhostDir(dir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    expect(await manager.inspect(packed.cindyPath)).toMatchObject({
      manifest: { node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' } },
    });
  });

  it('打包期校验 locale 文件存在、合法且完整，产物可按宿主语言 inspect', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      description: 'Base description',
      locales: {
        en: 'locales/en.json',
        ja: 'locales/ja.json',
      },
    };
    const locale = (name: string, description: string, tool: string) => JSON.stringify({
      name,
      description,
      tools: { do_thing: { description: tool } },
    });
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
      'locales/en.json': locale('Demo', 'English description', 'English tool'),
      'locales/ja.json': locale('デモ', '日本語の説明', '日本語のツール'),
    });
    const packed = await packGhostDir(dir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const manager = new GhostManager({
      getRootDir: () => path.join(workDir, 'ghosts'),
      getLocale: () => 'ja',
    });
    expect(await manager.inspect(packed.cindyPath)).toMatchObject({
      manifest: {
        name: 'デモ',
        description: '日本語の説明',
        resolvedLocale: 'ja',
        tools: [{ name: 'do_thing', description: '日本語のツール' }],
      },
    });
  });

  it('Forge 在 locale 缺文件、坏 JSON 或翻译错位时直接拒绝;部分翻译可打包', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      locales: { en: 'locales/en.json' },
    };
    const missing = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
    });
    expect(await packGhostDir(missing)).toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });

    await fs.promises.mkdir(path.join(missing, 'locales'), { recursive: true });
    await fs.promises.writeFile(path.join(missing, 'locales', 'en.json'), '{ nope');
    expect(await packGhostDir(missing)).toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });

    await fs.promises.writeFile(
      path.join(missing, 'locales', 'en.json'),
      JSON.stringify({ name: 'Demo', tools: { nope: { description: 'x' } } }),
    );
    expect(await packGhostDir(missing)).toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });

    // 部分翻译(只给 name)不再挡打包:缺译回退原文。
    await fs.promises.writeFile(
      path.join(missing, 'locales', 'en.json'),
      JSON.stringify({ name: 'Demo' }),
    );
    const partialPacked = await packGhostDir(missing);
    expect(partialPacked.ok, JSON.stringify(partialPacked)).toBe(true);

    await fs.promises.rm(path.join(missing, 'locales'), { recursive: true, force: true });
    await fs.promises.mkdir(path.join(missing, 'Locales'), { recursive: true });
    await fs.promises.writeFile(
      path.join(missing, 'Locales', 'EN.json'),
      JSON.stringify({
        name: 'Demo',
        tools: { do_thing: { description: 'English tool' } },
      }),
    );
    expect(await packGhostDir(missing)).toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
      message: expect.stringContaining('大小写不一致'),
    });
  });

  it('目录不存在 / 清单坏 / 声明的入口文件缺失 → 结构化拒绝', async () => {
    expect((await packGhostDir(path.join(workDir, 'nope'))).ok).toBe(false);

    const badManifest = await makeSrcDir({ 'ghost.json': '{not json' });
    const r1 = await packGhostDir(badManifest);
    expect(r1).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });

    const missingEntry = path.join(workDir, 'src2');
    await fs.promises.mkdir(missingEntry, { recursive: true });
    await fs.promises.writeFile(
      path.join(missingEntry, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST),
    );
    const r2 = await packGhostDir(missingEntry); // entry: main.js 没写
    expect(r2).toMatchObject({ ok: false, errorCode: 'ENTRY_MISSING' });

    const missingNodeDir = path.join(workDir, 'src3');
    await fs.promises.mkdir(missingNodeDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(missingNodeDir, 'ghost.json'),
      JSON.stringify({
        ...GOOD_MANIFEST,
        slots: ['node'],
        tools: undefined,
        node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
      }),
    );
    await fs.promises.writeFile(path.join(missingNodeDir, 'main.js'), '// browser brain');
    expect(await packGhostDir(missingNodeDir)).toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
  });

  it('形态收敛:老声明型清单(v1 / kind: declaration)打包被拒', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify({
        schemaVersion: 1,
        id: 'legacy',
        name: '老声明型',
        version: '1.0.0',
        kind: 'declaration',
        panel: { title: '静态面板', body: '一段文字' },
      }),
    });
    const r = await packGhostDir(dir);
    expect(r).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });

    // kind 单独非法(schemaVersion 已是 2)同样被拒,错误话术点名 chip。
    const dir2 = await makeSrcDir({
      'ghost.json': JSON.stringify({ ...GOOD_MANIFEST, kind: 'declaration' }),
      'main.js': '// brain',
    });
    const r2 = await packGhostDir(dir2);
    expect(r2).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });
    if (r2.ok) return;
    expect(r2.message).toContain('chip');
  });
});

describe('scaffoldGhostDir', () => {
  it.each<ForgeScaffoldTemplate>(['plain', 'agent-action', 'node-json-rpc', 'node-mcp'])(
    '生成 %s 模板，随后可以直接打包并通过装入检查',
    async (template) => {
      const dir = path.join(workDir, template);
      const result = await scaffoldGhostDir({
        dir,
        template,
        id: `demo-${template}`,
        name: `演示 ${template}`,
        description: `${template} 起步插件`,
      }, { sessionWorkdir: workDir });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, dir, template });
      if (!result.ok) return;
      expect(result.files).toContain('ghost.json');
      expect(result.files).toContain('main.js');
      expect(result.files).toContain('assets/icon.png');
      expect(result.files.includes('node/worker.cjs')).toBe(template.startsWith('node-'));

      // 骨架默认带占位图标(#809):清单声明 + 文件真实存在且是 PNG。
      const manifestJson = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8'),
      ) as { icon?: string };
      expect(manifestJson.icon).toBe('assets/icon.png');
      const iconBytes = await fs.promises.readFile(path.join(dir, 'assets/icon.png'));
      expect(iconBytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const packed = await packGhostDir(dir);
      expect(packed.ok, JSON.stringify(packed)).toBe(true);
      if (!packed.ok) return;
      const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
      expect(await manager.inspect(packed.cindyPath)).toHaveProperty('manifest');

      const mainSource = await fs.promises.readFile(path.join(dir, 'main.js'), 'utf8');
      if (template === 'agent-action') {
        expect(mainSource).toContain('cindy.agent.run');
        expect(mainSource).toContain('{{user_message}}');
        expect(mainSource).toContain('userActionToken');
      }
      if (template === 'node-json-rpc') expect(mainSource).toContain("method: 'echo'");
      if (template === 'node-mcp') {
        const worker = await fs.promises.readFile(path.join(dir, 'node/worker.cjs'), 'utf8');
        expect(worker).toContain("request.method === 'initialize'");
        expect(worker).toContain("request.method === 'tools/list'");
        expect(worker).toContain("request.method === 'tools/call'");
      }
    },
  );

  it('目标已存在时拒绝且不覆盖；插件信息不合法时不创建目录', async () => {
    const existing = path.join(workDir, 'existing');
    await fs.promises.mkdir(existing);
    await fs.promises.writeFile(path.join(existing, 'keep.txt'), 'keep me');
    expect(
      await scaffoldGhostDir({
        dir: existing,
        template: 'plain',
        id: 'existing',
        name: 'Existing',
      }, { sessionWorkdir: workDir }),
    ).toMatchObject({ ok: false, errorCode: 'TARGET_EXISTS' });
    expect(await fs.promises.readFile(path.join(existing, 'keep.txt'), 'utf8')).toBe('keep me');

    const invalid = path.join(workDir, 'invalid');
    expect(
      await scaffoldGhostDir({
        dir: invalid,
        template: 'plain',
        id: 'INVALID_ID',
        name: 'Invalid',
      }, { sessionWorkdir: workDir }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    await expect(fs.promises.stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('软链祖先把字面在工作目录内的路径引到外面 → 拒绝且外面不落盘', async () => {
    // Windows 无特权时目录软链可能 EPERM,建不出夹具就跳过(守卫仍在)。
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-outside-'));
    try {
      try {
        fs.symlinkSync(outside, path.join(workDir, 'out'), 'dir');
      } catch {
        return;
      }
      expect(
        await scaffoldGhostDir({
          dir: path.join(workDir, 'out', 'plugin'),
          template: 'plain',
          id: 'escape',
          name: 'Escape',
        }, { sessionWorkdir: workDir }),
      ).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
      await expect(fs.promises.stat(path.join(outside, 'plugin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('FORGE_GUIDE', () => {
  it('分章体量守卫:每个 ## 章节须留在单次工具结果安全体量内(#890 分章投递的不变量)', () => {
    // 手册"随主机版本演进"持续增长;任一章越过单次 MCP 结果上限会静默复现 #890 于该章。
    // 上限取 32KB:当前最大章 ~22KB,余量 ~45%,越线即该拆小节。
    const CHAPTER_BYTE_LIMIT = 32 * 1024;
    const sections = new Map<string, number>();
    let current = '(开场白)';
    let size = 0;
    for (const line of FORGE_GUIDE.split('\n')) {
      if (line.startsWith('## ')) {
        sections.set(current, size);
        current = line;
        size = 0;
      }
      size += Buffer.byteLength(line, 'utf8') + 1;
    }
    sections.set(current, size);
    for (const [header, bytes] of sections) {
      expect(bytes, `${header} 超出分章安全体量,请拆小节`).toBeLessThanOrEqual(
        CHAPTER_BYTE_LIMIT,
      );
    }
  });

  it('手册覆盖关键章节(身份卡/工具面/管子/聊天卡片/订阅拦截/网络代发/系统提示/沙箱红线/打包)', () => {
    for (const marker of [
      'ghost.json',
      '两段式',
      'call_tool',
      'tool-result',
      'errorCode',
      'CONFIRM_REQUIRED',
      'JSON.stringify',
      'cindy-request',
      'card-update',
      "type: 'notify'",
      'notify 槽',
      'will-user-message',
      'will-assistant-message',
      'event-verdict',
      'data-ghost-action',
      'data-ghost-prompt',
      'card-action',
      'agent 槽',
      'cindy.agent.run',
      '{{user_message}}',
      'userActionToken',
      "mode:'continue'",
      "trigger: 'background'",
      // 2026-07-31 快问快答(cindy.text.oneshot)与派活取件(agent.errand)。
      'oneshot_text',
      'NO_CANDIDATE',
      'expectJson',
      '4.11.1',
      'cindy.agent.errand',
      'queryErrand',
      '"errand": true',
      'node 槽',
      'cindy.node.request',
      'json-rpc-stdio',
      'mcp-stdio',
      'Electron IPC',
      'npm install',
      'spawnCallId',
      // 媒体回锚(2026-07-14):常驻过程卡模式下轮询结果把媒体挂回提交卡下方。
      'xdt_anchor_card_id',
      // 音频播放器卡(2026-07-14):交卷字段 xdt_audio_tracks 渲染音频卡。
      'xdt_audio_tracks',
      // 卡内音频播放器(2026-07-14):data-ghost-audio 插槽 + 防重令牌。
      'data-ghost-audio',
      'xdt_audio_in_card',
      // 卡内外链(2026-07-23,外链 v3):声明式属性 + 宿主确认框才 openExternal。
      'data-ghost-link',
      'cindy.request',
      'app-context',
      'navigator.language',
      'host-context-changed',
      'locales/en.json',
      '固定使用英文',
      // 2026-07-25 locale 可选化:缺译回退原文,翻译错位仍拒;§2.1 同步。
      '翻译是可选项',
      '翻译错位仍是硬错误',
      'clientIdAlternatives',
      'cindy.fetch',
      'network 槽',
      '媒体上传',
      '凭证明文永不进沙箱',
      '/secrets',
      // 收单契约(2026-07-13 宿主凭证渲染退役):user 凭证一律 settingsHtml 收单。
      '一次性交给主机保险库',
      '尾 4 位',
      'exchange',
      'tokenPath',
      'login-email',
      // 多连接(connections,2026-07-14):声明形态 / 设置页协议 / 主机受信确认。
      'connections',
      '/connections',
      'maxConnections',
      '受信确认',
      'CONFIRM_DENIED',
      'uploadDir',
      'dir_deposit',
      // fs 槽(2026-07-14):三档代写(私有目录/工作目录/save 票据)。
      'fs-request',
      "root: 'data'",
      "root: 'workdir'",
      "root: 'save'",
      'save_deposit.token',
      '沙箱红线',
      'ghost_forge_scaffold',
      'ghost_forge_pack',
      'cindy-signatures.json',
      '发布者签名',
      'Cindy 审核签名',
      '不要让 Agent 读取、生成或回显正式私钥',
      '/preview/',
      'settingsHtml',
      'settingsHeight',
      'box-sizing:border-box',
      'min-width:0',
      'max-width:100%',
      "fetch('/kv')",
      // setup 就绪声明(2026-07-21):使用前置检查——作者声明需求,主机统一检查。
      'setup 就绪声明',
      'anyOf',
      'secret:brave_api_key',
      'Node 凭证同样可参与 setup.requires',
      // 2026-07-23 通用能力四件套:会话上下文 / node 多入口 / 目录选择 / 面板预览。
      '会话上下文(session-context 槽)',
      'workdir_is_local',
      'workdir_is_read_only',
      'node.entries',
      'node.secretBindings',
      'request.cindy.secrets',
      '目录选择(pick 槽)',
      'cindy.pick',
      '面板预览(preview 槽)',
      'cindy.preview',
      'preview.hosts',
      // 2026-07-23 长任务续命:maxTotalMs 沉默窗口语义。
      'maxTotalMs',
      '有动静就续期',
      // 2026-07-23 宿主代启子进程(缺口 1):childSpawn + spawnEntry 窄接口。
      '宿主代启子进程(childSpawn)',
      '__CINDY_NODE__',
      'spawnEntry',
      // 2026-07-24 面板页签形态:position 'tab' 进右侧栏,每会话单例,
      // 停靠专属字段(minWidth/defaultFraction)拒装;§5 面板章节同步。
      '面板(panel.html/css/js)',
      'panel.position',
      '右侧栏页签',
      // 2026-07-25 标准头系统按钮:主机画标题条,systemButtons 逐个关
      // (maximize 撑满 / detach 独立窗口 / minimize 气泡);§2 样例与 §5
      // 面板章节同步。
      'systemButtons',
      '撑满内容区',
      '在独立窗口中打开',
      'minimize',
      '最小化为浮动气泡',
      // 2026-07-25 skill 槽:随包捆绑 Agent Skills,声明一致性 + 全局作用域披露。
      // 卡槽总数标记随 workspace 槽合入更新为十五个。
      '十五个卡槽',
      '捆绑 Agent Skills(skill 槽)',
      'skill.items',
      'SKILL.md',
      '~/.agents/skills',
      '逐字一致',
      '不受插件沙箱约束',
      // 2026-07-25 工作区会话(workspace 槽):目录亲选/确认卡授权,判重复用,
      // 空会话入口落侧边栏;§2 卡槽清单与 §4.17 章节同步。
      '创建工作区会话(workspace 槽)',
      'cindy.workspace',
      "kind: 'ensure-session'",
      // 2026-07-28 图标与官方仓门禁(#809):§1/§2 的 icon 字段说明、
      // §8.1 官方插件仓的四语言 locale 与 assets/icon.png 惯例。
      '"icon": "assets/icon.png"',
      '不收 svg',
      '发布到官方插件仓的额外门禁',
      'makecindy/cindy-official-plugins',
      '四语言 locale 缺一不可',
      // 2026-07-29 寄存通道(#784):§2 的 media 类目 + §4.0.1 章节,
      // 以及 §6 沙箱红线里"改图只认名下媒体"的口径更新。
      "kind: 'deposit_media'",
      "kind: 'release_media'",
      '"cindy": { "media": ["deposit"] }',
      '每意识配额 1GB',
      '寄存物不是产物',
      // 2026-07-29 媒体代办画面参数:edit_image 放开 aspectRatio,视频四参数
      // (ratio/resolution/duration/fps)+ 实际生效参数回执 videoParams。
      '图像可选画幅 aspectRatio',
      '视频画面参数(四项全可选',
      'videoParams',
      '各型号支持集不同',
      // 2026-07-31 设计对齐章(§0):动手前用带选项的提问卡片摆出"隐藏"设计
      // 选项(界面形态/点名词/启动模式/联网等),用户确认设计小结后才动手;
      // 小结须告知源码目录位置(知情即可,不需要用户选)。
      '设计对齐',
      '提问卡片',
      '推荐项',
      '"隐藏"设计选项',
      '设计小结',
      '源码会放在工作目录的哪个文件夹',
      '让用户知情即可',
      // 2026-07-31 确认弹窗(confirm 槽):主机同款确认框 + 真实点击回执;
      // §2 卡槽清单、§4.9 的"不是确认框"指向、§4.18 章节三处同步。
      '确认弹窗(confirm 槽)',
      'cindy.confirm',
      '只代表问到了,答案看',
      '全局同时只有一个确认框',
      '"turn", "session", "activity"',
      'did-thinking-{start,end}',
      'did-approval-{start,end}',
      'did-user-input-{start,end}',
      '不会给 reasoning、工具',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});

describe('packGhostDir · skill 槽', () => {
  const SKILL_MANIFEST = {
    ...GOOD_MANIFEST,
    id: 'skilled',
    slots: ['tool', 'skill'],
    skill: { items: [{ dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' }] },
  };
  const skillMd = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

  it('happy path:SKILL.md 一致 → 打包,产物能被装入侧 inspect 认可', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(SKILL_MANIFEST),
      'main.js': '// brain',
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo'),
    });
    const r = await packGhostDir(dir);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(r.cindyPath);
    expect(inspected).toMatchObject({
      manifest: { skill: { items: [{ dir: 'skills/foo', name: 'foo' }] } },
    });
  });

  it('声明的技能目录缺 SKILL.md → ENTRY_MISSING', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(SKILL_MANIFEST),
      'main.js': '// brain',
      'skills/foo/notes.md': '不是 SKILL.md',
    });
    const r = await packGhostDir(dir);
    expect(r).toMatchObject({ ok: false, errorCode: 'ENTRY_MISSING' });
  });

  it('frontmatter 与清单声明漂移 → MANIFEST_INVALID(与装入侧同一契约)', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(SKILL_MANIFEST),
      'main.js': '// brain',
      'skills/foo/SKILL.md': skillMd('foo', '偷偷换一份说明'),
    });
    const r = await packGhostDir(dir);
    expect(r).toMatchObject({ ok: false, errorCode: 'MANIFEST_INVALID' });
  });
});
