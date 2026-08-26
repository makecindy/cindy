/**
 * forge.test.ts — 意识锻造打包(packGhostDir)单测。
 * 纯 Node 直测(规则 14):tmpdir 造源码目录 → 打包 → 用 GhostManager
 * 的 inspect 反向验证产物能被装入侧认可(两侧同一契约不漂移)。
 * 规则 23:全部路径在 os.tmpdir 下,收尾清理。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import JSZip from 'jszip';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GHOST_MANIFEST_SUMMARY_MAX_CHARS,
  PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES,
} from '@cindy/plugin-protocol';

import {
  FORGE_GUIDE,
  // 本测试文件用同名本地包装器(注入 sessionWorkdir / writeScaffold 门参)遮蔽,
  // 故 raw 函数以别名导入;main 的 packGhostDirToFile 无包装器,直接导入。
  packGhostDir as packGhostDirRaw,
  packGhostDirToFile,
  scaffoldGhostDir as scaffoldGhostDirRaw,
  type ForgeScaffoldWriteRequest,
  type ForgeScaffoldTemplate,
} from '../forge';
import {
  GhostManager,
  MAX_NODE_CINDY_FILE_BYTES,
  MAX_NODE_UNCOMPRESSED_BYTES,
  MAX_NODE_ZIP_ENTRIES,
} from '../GhostManager';
import { sameForgeScaffoldParentIdentity } from '../forgeScaffoldIdentity';
import { GHOST_SIGNATURE_FILE, signGhostPackage } from '../ghostSignature';
import { GHOST_INSTALL_MANIFEST_MAX_BYTES } from '../../../shared/ghost';

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

async function testScaffoldWriter(request: ForgeScaffoldWriteRequest) {
  const parentStats = await fs.promises.lstat(request.parentDir, { bigint: true });
  if (!sameForgeScaffoldParentIdentity(parentStats, request.expectedParent)) {
    return { ok: false as const, errorCode: 'INTERNAL' as const, message: 'parent changed' };
  }
  const target = path.join(request.parentDir, request.targetName);
  try {
    await fs.promises.lstat(target);
    return { ok: false as const, errorCode: 'TARGET_EXISTS' as const, message: 'exists' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = await fs.promises.mkdtemp(
    path.join(request.parentDir, `.${request.targetName}-scaffold-`),
  );
  try {
    for (const file of request.files) {
      const abs = path.join(staging, file.path);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, Buffer.from(file.base64, 'base64'), { flag: 'wx' });
    }
    try {
      await fs.promises.rename(staging, target);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'EEXIST' ||
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
      ) {
        return { ok: false as const, errorCode: 'TARGET_EXISTS' as const, message: 'exists' };
      }
      throw error;
    }
    return { ok: true as const };
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function scaffoldGhostDir(
  input: Omit<Parameters<typeof scaffoldGhostDirRaw>[0], 'minCindyVersion'> & {
    minCindyVersion?: string;
  },
  options: Omit<NonNullable<Parameters<typeof scaffoldGhostDirRaw>[1]>, 'writeScaffold'> = {},
) {
  return scaffoldGhostDirRaw(
    { minCindyVersion: '1.2.3', ...input },
    { ...options, writeScaffold: testScaffoldWriter },
  );
}

function packGhostDir(
  dir: string,
  options: Omit<NonNullable<Parameters<typeof packGhostDirRaw>[1]>, 'sessionWorkdir'> = {},
) {
  return packGhostDirRaw(dir, { sessionWorkdir: workDir, ...options });
}

async function expectSameExistingRealPath(actual: string, expected: string): Promise<void> {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const [actualReal, expectedReal] = await Promise.all([
    fs.promises.realpath(actual),
    fs.promises.realpath(expected),
  ]);
  expect(normalize(actualReal)).toBe(normalize(expectedReal));
}

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
async function makeSrcDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = path.join(workDir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  return dir;
}

describe('packGhostDir', () => {
  it('rejects a new tokenBroker package without redirectPort but accepts the declared-port shape', async () => {
    const brokerManifest = {
      ...GOOD_MANIFEST,
      slots: ['network'],
      tools: undefined,
      settingsHtml: 'settings.html',
      network: {
        hosts: ['accounts.example.com'],
        secrets: [
          {
            key: 'account',
            label: 'Account',
            source: 'oauth',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            oauth: {
              authorizeUrl: 'https://accounts.example.com/authorize',
              tokenUrl: 'https://accounts.example.com/token',
              clientId: 'builtin-client-id',
              tokenBroker: 'jira',
            },
          },
        ],
      },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(brokerManifest),
      'main.js': '// broker plugin',
      'settings.html': '<main>settings</main>',
    });

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
      message: expect.stringContaining('同一项 oauth 中声明 redirectPort'),
    });
    expect(fs.existsSync(path.join(dir, 'demo-1.0.0.cindy'))).toBe(false);

    const secret = brokerManifest.network.secrets[0] as {
      oauth: Record<string, unknown>;
    };
    secret.oauth.redirectPort = 17872;
    await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(brokerManifest));
    await expect(packGhostDir(dir)).resolves.toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === 'win32')(
    'archives real Unix execute bits while stripping special bits',
    async () => {
      const dir = await makeSrcDir({
        'ghost.json': JSON.stringify(GOOD_MANIFEST),
        'main.js': 'export default {};',
        'bin/tool': '#!/bin/sh\necho ok\n',
      });
      await fs.promises.chmod(path.join(dir, 'bin', 'tool'), 0o4755);

      const packed = await packGhostDir(dir);
      expect(packed).toMatchObject({ ok: true });
      if (!packed.ok) return;
      const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
      expect(Number(zip.files['bin/tool'].unixPermissions) & 0o7777).toBe(0o755);
    },
  );

  it('writes an in-workdir alias output to the canonical source directory', async () => {
    const sourceTarget = path.join(workDir, 'source-target');
    const sourceAlias = path.join(workDir, 'source-alias');
    await fs.promises.mkdir(sourceTarget, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceTarget, 'ghost.json'),
      JSON.stringify({ ...GOOD_MANIFEST, id: 'inside' }),
    );
    await fs.promises.writeFile(path.join(sourceTarget, 'main.js'), 'export default {}');
    await fs.promises.symlink(
      sourceTarget,
      sourceAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const packed = await packGhostDir(sourceAlias);
    expect(packed).toMatchObject({ ok: true });
    if (!packed.ok) return;
    await expectSameExistingRealPath(
      packed.cindyPath,
      path.join(sourceTarget, 'inside-1.0.0.cindy'),
    );
    await expect(
      fs.promises.access(path.join(sourceTarget, 'inside-1.0.0.cindy')),
    ).resolves.toBeUndefined();
  });

  it('rejects a file replaced by a link after classification', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': 'export default {};',
    });
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-file-race-'));
    const outsideFile = path.join(outsideRoot, 'secret.js');
    await fs.promises.writeFile(outsideFile, 'outside-secret');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let swapped = false;
    const lstatSpy = vi
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (file: fs.PathLike, options?: fs.StatOptions) => {
        // 忠实转发 options:readBoundedFileNoFollow 在 Windows 走 lstat(path,{bigint:true}),
        // 丢掉 options 会返回非 bigint stat、令 sameInode 误判,破坏无关的 ghost.json 读取。
        const result = await (
          originalLstat as (
            p: fs.PathLike,
            o?: fs.StatOptions,
          ) => Promise<fs.Stats & fs.BigIntStats>
        )(file, options);
        if (!swapped && path.basename(String(file)) === 'main.js') {
          swapped = true;
          await fs.promises.rm(String(file), { force: true });
          await fs.promises.symlink(
            outsideFile,
            String(file),
            process.platform === 'win32' ? 'file' : undefined,
          );
        }
        return result;
      });
    try {
      const packed = await packGhostDir(dir);
      expect(packed).toMatchObject({ ok: false, errorCode: 'ENTRY_MISSING' });
      await expect(fs.promises.access(path.join(dir, 'demo-1.0.0.cindy'))).rejects.toThrow();
    } finally {
      lstatSpy.mockRestore();
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a child directory replaced by a junction before recursion', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': 'export default {};',
      'assets/readme.txt': 'inside',
    });
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-dir-race-'));
    const outsideDir = path.join(outsideRoot, 'assets');
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.writeFile(path.join(outsideDir, 'secret.txt'), 'outside-secret');
    const assetsDir = path.join(dir, 'assets');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let swapped = false;
    const lstatSpy = vi
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (file: fs.PathLike, options?: fs.StatOptions) => {
        // 忠实转发 options:readBoundedFileNoFollow 在 Windows 走 lstat(path,{bigint:true}),
        // 丢掉 options 会返回非 bigint stat、令 sameInode 误判,破坏无关的 ghost.json 读取。
        const result = await (
          originalLstat as (
            p: fs.PathLike,
            o?: fs.StatOptions,
          ) => Promise<fs.Stats & fs.BigIntStats>
        )(file, options);
        if (!swapped && path.resolve(String(file)) === path.resolve(assetsDir)) {
          swapped = true;
          await fs.promises.rm(assetsDir, { recursive: true, force: true });
          await fs.promises.symlink(
            outsideDir,
            assetsDir,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        return result;
      });
    try {
      const packed = await packGhostDir(dir);
      expect(packed).toMatchObject({ ok: false, errorCode: 'SOURCE_OUTSIDE_WORKDIR' });
      await expect(fs.promises.access(path.join(dir, 'demo-1.0.0.cindy'))).rejects.toThrow();
    } finally {
      lstatSpy.mockRestore();
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('requires the source to stay inside the current session workdir', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': 'export default {}',
    });
    await expect(packGhostDirRaw(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_OUTSIDE_WORKDIR',
    });
    await expect(
      packGhostDirRaw(dir, { sessionWorkdir: path.join(workDir, 'missing-workdir') }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_OUTSIDE_WORKDIR',
    });

    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-outside-'));
    try {
      const outsideDir = path.join(outsideRoot, 'src');
      await fs.promises.cp(dir, outsideDir, { recursive: true });
      await expect(packGhostDirRaw(outsideDir, { sessionWorkdir: workDir })).resolves.toMatchObject(
        {
          ok: false,
          errorCode: 'SOURCE_OUTSIDE_WORKDIR',
        },
      );

      const alias = path.join(workDir, 'outside-alias');
      await fs.promises.symlink(outsideDir, alias, 'junction');
      await expect(packGhostDirRaw(alias, { sessionWorkdir: workDir })).resolves.toMatchObject({
        ok: false,
        errorCode: 'SOURCE_OUTSIDE_WORKDIR',
      });
    } finally {
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects Host-managed roots, descendants, case aliases, and junction aliases', async () => {
    const managedRoot = path.join(workDir, 'managed');
    const installedDir = path.join(managedRoot, 'demo');
    await fs.promises.mkdir(installedDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(installedDir, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST),
    );
    await fs.promises.writeFile(path.join(installedDir, 'main.js'), '// installed');

    await expect(
      packGhostDir(managedRoot, { forbiddenRootDirs: [managedRoot] }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
    });
    await expect(
      packGhostDir(installedDir, { forbiddenRootDirs: [managedRoot] }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
    });

    if (process.platform === 'win32') {
      await expect(
        packGhostDir(installedDir.toUpperCase(), {
          forbiddenRootDirs: [managedRoot.toLowerCase()],
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
      });
    }

    const alias = path.join(workDir, 'installed-alias');
    try {
      await fs.promises.symlink(
        installedDir,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    await expect(packGhostDir(alias, { forbiddenRootDirs: [managedRoot] })).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
    });
  });

  it('rejects a source directory that contains a Host-managed root', async () => {
    // 源目录是受管根的**祖先**:单向判定放行时,递归打包会走进 cindy-brain /
    // ghost-install-state,把已安装插件字节、批准 receipt 与技能快照一并打进 .cindy。
    // 只要在 owner 数据目录里放一个 ghost.json 就能触发,所以判定必须双向。
    const ownerData = path.join(workDir, 'owner-data');
    const managedRoot = path.join(ownerData, 'cindy-brain');
    await fs.promises.mkdir(managedRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(managedRoot, 'receipt.json'),
      JSON.stringify({ secret: 'approved state' }),
    );
    await fs.promises.writeFile(path.join(ownerData, 'ghost.json'), JSON.stringify(GOOD_MANIFEST));
    await fs.promises.writeFile(path.join(ownerData, 'main.js'), '// authoring source');

    await expect(
      packGhostDir(ownerData, { forbiddenRootDirs: [managedRoot] }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
    });
  });

  it('does not follow a link inside the source dir into a Host-managed root', async () => {
    // **契约用例,不是回归用例**:改动前 Dirent 的类型位也把 junction 报成 link,
    // 所以这条在旧实现下同样是绿的。钉住的是契约本身 —— 双向包含判定挡的是"源目录是
    // 受管根的祖先",这条挡的是另一半(源目录里放一条指向受管根的链接);判类型一律
    // lstat、不信 Dirent 类型位之后,这一半不再依赖 libuv 的实现细节。
    const managedRoot = path.join(workDir, 'managed');
    await fs.promises.mkdir(managedRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(managedRoot, 'receipt.json'),
      JSON.stringify({ secret: 'approved state' }),
    );
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// authoring source',
    });
    try {
      await fs.promises.symlink(
        managedRoot,
        path.join(dir, 'state'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    const result = await packGhostDir(dir, { forbiddenRootDirs: [managedRoot] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.cindyPath));
    expect(Object.keys(zip.files).sort()).toEqual(['ghost.json', 'main.js']);
  });

  it('rejects a declared file that is a link instead of packing a package without it', async () => {
    // `stat` 会穿透链接让声明检查过关,而收集步按类型跳过链接 —— 包里就少了 main.js,
    // 错误延迟到用户装入时才现形。打包期直接拒,报清楚。
    const dir = await makeSrcDir({ 'ghost.json': JSON.stringify(GOOD_MANIFEST) });
    const realEntry = path.join(workDir, 'real-main.js');
    await fs.promises.writeFile(realEntry, '// outside');
    try {
      await fs.promises.symlink(realEntry, path.join(dir, 'main.js'), 'file');
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
  });

  it('requires and packs the declared main-view HTML entry', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      minCindyVersion: '1.2.3',
      slots: ['tool', 'main-view'],
      mainView: { title: 'Workspace', html: 'ui/main-view.html' },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// authoring source',
    });

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });

    await fs.promises.mkdir(path.join(dir, 'ui'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'ui', 'main-view.html'), '<main>workspace</main>');
    const packed = await packGhostDir(dir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
    expect(Object.keys(zip.files)).toContain('ui/main-view.html');
  });

  it('rejects a declared file below a linked ancestor instead of omitting it from the package', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      slots: ['tool', 'panel'],
      panel: { title: 'Linked panel', html: 'linked/panel.html', minWidth: 240 },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// authoring source',
    });
    const realPanelDir = path.join(workDir, 'real-panel');
    await fs.promises.mkdir(realPanelDir);
    await fs.promises.writeFile(path.join(realPanelDir, 'panel.html'), '<main>linked</main>');
    try {
      await fs.promises.symlink(realPanelDir, path.join(dir, 'linked'), directoryLinkType);
    } catch {
      return;
    }

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
  });

  it('rejects a required path whose casing differs from the collected ZIP entry', async () => {
    const manifest = { ...GOOD_MANIFEST, entry: 'Main.js' };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// actual lower-case path',
    });
    const declaredEntry = path.join(dir, 'Main.js');
    const actualEntry = path.join(dir, 'main.js');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    const lstatSpy = vi
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (file: fs.PathLike, options?: fs.StatOptions) => {
        const target =
          path.resolve(String(file)) === path.resolve(declaredEntry) ? actualEntry : file;
        return (
          originalLstat as (
            p: fs.PathLike,
            o?: fs.StatOptions,
          ) => Promise<fs.Stats & fs.BigIntStats>
        )(target, options);
      });
    try {
      await expect(packGhostDir(dir)).resolves.toMatchObject({
        ok: false,
        errorCode: 'ENTRY_MISSING',
      });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('rejects a missing extra node entry instead of producing a partially runnable package', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      slots: ['node'],
      tools: undefined,
      node: {
        entry: 'node/worker.cjs',
        entries: ['node/secondary.cjs'],
        protocol: 'json-rpc-stdio',
      },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// browser brain',
      'node/worker.cjs': '// primary worker',
    });

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
  });

  it('rejects a missing declared icon when no icon overlay is supplied', async () => {
    const manifest = { ...GOOD_MANIFEST, icon: 'assets/icon.png' };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// browser brain',
    });

    await expect(packGhostDir(dir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
  });

  it('allows an independent authoring directory outside managed roots', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// authoring source',
    });
    const result = await packGhostDir(dir, {
      forbiddenRootDirs: [path.join(workDir, 'managed')],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('happy path:产物落源码目录(id-version.cindy),且能被装入侧 inspect 认可', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'assets/readme.txt': 'hi',
    });
    const r = await packGhostDir(dir);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    await expectSameExistingRealPath(r.cindyPath, path.join(dir, 'demo-1.0.0.cindy'));
    expect(r.manifest.id).toBe('demo');

    // 装入侧同一契约验证:inspect 直接吃打包产物。
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(r.cindyPath);
    expect('manifest' in inspected, JSON.stringify(inspected)).toBe(true);

    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('把已校验的 manifest 快照直接用于产物，避免校验 A、打包 B', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': 'export default {};',
    });
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    let mutated = false;
    const readdirSpy = vi
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(async (directory, options) => {
        const entries = await originalReaddir(directory, options as never);
        if (!mutated && path.resolve(String(directory)) === path.resolve(dir)) {
          mutated = true;
          await fs.promises.writeFile(
            path.join(dir, 'ghost.json'),
            JSON.stringify({ ...GOOD_MANIFEST, id: 'bravo', version: '9.0.0' }),
          );
        }
        return entries as never;
      });
    try {
      const packed = await packGhostDir(dir);
      expect(packed).toMatchObject({
        ok: true,
        manifest: {
          schemaVersion: 2,
          id: GOOD_MANIFEST.id,
          version: GOOD_MANIFEST.version,
          tools: GOOD_MANIFEST.tools,
        },
      });
      if (!packed.ok) return;
      expect('slots' in packed.manifest).toBe(false);
      const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
      const manifest = await zip.file('ghost.json')?.async('string');
      expect(manifest).toContain('"id":"demo"');
      expect(manifest).not.toContain('"id":"bravo"');
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('iconPng 仅覆盖包内图标与清单快照，不改写插件源码', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    const iconPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const packed = await packGhostDir(dir, { iconPng });
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
    expect(JSON.parse(await zip.file('ghost.json')!.async('string'))).toMatchObject({
      icon: 'assets/icon.png',
    });
    expect(await zip.file('assets/icon.png')!.async('nodebuffer')).toEqual(iconPng);

    expect(
      JSON.parse(await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8')),
    ).not.toHaveProperty('icon');
    await expect(fs.promises.stat(path.join(dir, 'assets/icon.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(packed.cindyPath);
    expect('manifest' in inspected, JSON.stringify(inspected)).toBe(true);
  });

  it('iconPng 超过安装器 512 KiB 上限时在打包期拒绝', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });

    await expect(
      packGhostDir(dir, { iconPng: Buffer.alloc(512 * 1024 + 1) }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'TOO_LARGE',
    });
  });

  it('已签名源码使用 iconPng 时拒绝 overlay，避免生成验签必失败的包', async () => {
    const originalIcon = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const manifest = { ...GOOD_MANIFEST, icon: 'assets/icon.png' };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
    });
    await fs.promises.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'assets/icon.png'), originalIcon);

    const sourceZip = new JSZip();
    sourceZip.file('ghost.json', JSON.stringify(manifest));
    sourceZip.file('main.js', '// brain');
    sourceZip.file('assets/icon.png', originalIcon);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await sourceZip.generateAsync({ type: 'nodebuffer' }), {
      publisherName: 'Forge Test Publisher',
      privateKey,
    });
    const signedZip = await JSZip.loadAsync(signed);
    const signatureBytes = await signedZip.file(GHOST_SIGNATURE_FILE)!.async('nodebuffer');
    await fs.promises.writeFile(path.join(dir, GHOST_SIGNATURE_FILE), signatureBytes);

    await expect(packGhostDir(dir, { iconPng: Buffer.from('replacement') })).resolves.toMatchObject(
      {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: expect.stringContaining('已签名插件不能使用 AI 图标覆盖'),
      },
    );

    const fallback = await packGhostDir(dir);
    expect(fallback.ok, JSON.stringify(fallback)).toBe(true);
    if (!fallback.ok) return;
    const fallbackZip = await JSZip.loadAsync(await fs.promises.readFile(fallback.cindyPath));
    expect(await fallbackZip.file('assets/icon.png')!.async('nodebuffer')).toEqual(originalIcon);
    expect(await fallbackZip.file(GHOST_SIGNATURE_FILE)!.async('nodebuffer')).toEqual(
      signatureBytes,
    );

    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    expect(await manager.inspect(fallback.cindyPath)).toMatchObject({
      trust: { publisherSigned: true },
    });
  });

  it('无效清单传 iconPng 仍返回 MANIFEST_INVALID，不被 overlay 改造成其它形状', async () => {
    const dir = await makeSrcDir({
      'ghost.json': 'null',
      'main.js': '// brain',
    });

    await expect(packGhostDir(dir, { iconPng: Buffer.from('png') })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
    });
  });

  it('icon overlay 后清单超过安装器上限时在打包期拒绝', async () => {
    // 用未知字段填充到上限附近:validator 会忽略它,但安装器仍必须按实际
    // ghost.json 字节数限流。overlay 只能写紧凑 JSON,并且写入 zip 前再复核。
    const emptyExtraBytes = Buffer.byteLength(
      `${JSON.stringify({ ...GOOD_MANIFEST, extra: '' })}\n`,
      'utf8',
    );
    const manifest = {
      ...GOOD_MANIFEST,
      extra: 'x'.repeat(GHOST_INSTALL_MANIFEST_MAX_BYTES - emptyExtraBytes - 4),
    };
    const originalBytes = Buffer.byteLength(`${JSON.stringify(manifest)}\n`, 'utf8');
    expect(originalBytes).toBeLessThanOrEqual(GHOST_INSTALL_MANIFEST_MAX_BYTES);
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
    });

    await expect(packGhostDir(dir, { iconPng: Buffer.from('png') })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
      message: expect.stringContaining('合成后超过安装器'),
    });
  });

  it('assets/icon.png 已被目录占用时拒绝 icon overlay', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    await fs.promises.mkdir(path.join(dir, 'assets/icon.png'), { recursive: true });

    await expect(packGhostDir(dir, { iconPng: Buffer.from('png') })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
      message: expect.stringContaining('目标路径已被源码目录占用'),
    });
  });

  it('assets/icon.png 子路径已被目录占用时拒绝 icon overlay', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'assets/icon.png/child.txt': 'occupied',
    });

    await expect(packGhostDir(dir, { iconPng: Buffer.from('png') })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MANIFEST_INVALID',
      message: expect.stringContaining('目标路径已被源码目录占用'),
    });
  });

  it('打包进 zip 的 ghost.json 是校验时的快照,并发改写不生效(防 TOCTOU)', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
    });
    // 模拟"校验通过后、写入 zip 前"目录被并发改写:保 id/version,偷加权限声明。
    // 若打包时重读磁盘,包里的 manifest 会与返回值(安装侧审阅比对的依据)分叉。
    const tampered = JSON.stringify({
      ...GOOD_MANIFEST,
      slots: ['tool', 'network'],
      network: { allow: ['x.test'] },
    });
    const realRead = fs.promises.readFile;
    let ghostReads = 0;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ) => {
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

  it.skipIf(!canSymlink)(
    'ghost.json 为符号链接 → MANIFEST_INVALID(与市场发现/安装同一把闸)',
    async () => {
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
    },
  );

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
    await fs.promises.writeFile(path.join(pluginDir, 'ghost.json'), JSON.stringify(GOOD_MANIFEST));
    await fs.promises.writeFile(path.join(pluginDir, 'main.js'), '// brain');
    // 调用方(安装管道)校验时拿到的规范根。
    const expectedRealDir = await fs.promises.realpath(pluginDir);
    // 校验之后被换成指向外部目录的链接(外部目录留着同样的 ghost.json)。
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
    await fs.promises.symlink(await fs.promises.realpath(outside), pluginDir, directoryLinkType);

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
    const locale = (name: string, description: string, tool: string) =>
      JSON.stringify({
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

  // plugin-server 数的是**所有 ZIP entry**,Forge 数的是**文件**。JSZip 默认
  // createFolders:true 会为每层目录补一个 entry,于是「Forge 放行的 2048 文件包」
  // 在服务端可能是 4000+ entry 而被拒——打包侧完全看不出问题。这两条钉住
  // 「包里不含目录 entry」,让两侧口径按构造相等。
  it('嵌套路径不产生目录 entry:ZIP 条目数与文件数一致', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'a/b/c.txt': 'deep one',
      'a/b/d.txt': 'deep two',
    });
    const r = await packGhostDir(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(r.cindyPath));
    const allEntries = Object.keys(zip.files).sort();
    // 修复前这里会多出 'a/' 与 'a/b/' 两个目录 entry(2 文件 → 4 entry)。
    expect(allEntries).toEqual(['a/b/c.txt', 'a/b/d.txt', 'ghost.json', 'main.js']);
    expect(allEntries.filter((name) => zip.files[name].dir)).toEqual([]);
    await fs.promises.rm(r.cindyPath, { force: true });
  });

  it('装入侧目录仍然建得出来:去掉目录 entry 不影响解包', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(GOOD_MANIFEST),
      'main.js': '// brain',
      'nested/deep/file.txt': 'payload',
    });
    const r = await packGhostDir(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // inspect 是装入侧的同一条契约:产物没有目录 entry 也必须能被认可。
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });
    const inspected = await manager.inspect(r.cindyPath);
    expect('manifest' in inspected, JSON.stringify(inspected)).toBe(true);
    await fs.promises.rm(r.cindyPath, { force: true });
  });
});

describe('打包上限与协议常量', () => {
  // D18:同一份 `.cindy` 之后要过 plugin-server 成员发布链路的权威校验。
  // Forge 的 node 档已直接引用协议常量;装入侧(GhostManager)有自己的策略语义
  // ——协议文件明说它「只治理成员上传通道」——所以不改成读它,而是在这里钉住相等。
  // 一旦任一侧被单独调整,这条会红:发布上限高于装入上限会造出「服务端收了、
  // 客户端装不上」的包,反过来则是能装但发不出去。
  it('装入侧 node 档三个上限与成员上传协议常量一致', () => {
    expect(MAX_NODE_CINDY_FILE_BYTES).toBe(PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES);
    expect(MAX_NODE_UNCOMPRESSED_BYTES).toBe(PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES);
    expect(MAX_NODE_ZIP_ENTRIES).toBe(PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES);
  });
});

describe('scaffoldGhostDir', () => {
  it('fails closed when the scaffold parent has no trustworthy filesystem identity', async () => {
    const parentStat = await fs.promises.lstat(workDir, { bigint: true });
    const realPath = await fs.promises.realpath(workDir);
    expect(sameForgeScaffoldParentIdentity(parentStat, { realPath, dev: 0n, ino: 0n })).toBe(false);

    const zeroIdentityStat = new Proxy(parentStat, {
      get(target, key) {
        if (key === 'dev' || key === 'ino') return 0n;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(
      sameForgeScaffoldParentIdentity(zeroIdentityStat, {
        realPath,
        dev: parentStat.dev,
        ino: parentStat.ino,
      }),
    ).toBe(false);
  });

  it('passes the stable parent identity as lossless bigint values', async () => {
    const parentStat = await fs.promises.lstat(workDir, { bigint: true });
    let captured: ForgeScaffoldWriteRequest | undefined;
    const result = await scaffoldGhostDirRaw(
      {
        dir: path.join(workDir, 'bigint-parent'),
        template: 'plain',
        id: 'bigint-parent',
        name: 'BigInt parent',
        minCindyVersion: '1.2.3',
      },
      {
        sessionWorkdir: workDir,
        writeScaffold: async (request) => {
          captured = request;
          return { ok: true };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(captured?.expectedParent).toEqual({
      realPath: await fs.promises.realpath(workDir),
      dev: parentStat.dev,
      ino: parentStat.ino,
    });
    expect(typeof captured?.expectedParent.dev).toBe('bigint');
    expect(typeof captured?.expectedParent.ino).toBe('bigint');
  });

  it.each<ForgeScaffoldTemplate>(['plain', 'agent-action', 'node-json-rpc', 'node-mcp'])(
    '生成 %s 模板，随后可以直接打包并通过装入检查',
    async (template) => {
      const dir = path.join(workDir, template);
      const result = await scaffoldGhostDir(
        {
          dir,
          template,
          id: `demo-${template}`,
          name: `演示 ${template}`,
          description: `${template} 起步插件`,
        },
        { sessionWorkdir: workDir },
      );
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, dir, template });
      if (!result.ok) return;
      expect(result.files).toContain('ghost.json');
      expect(result.files).toContain('main.js');
      expect(result.files).toContain('assets/icon.png');
      expect(result.files.includes('node/worker.cjs')).toBe(template.startsWith('node-'));

      // 骨架默认带占位图标(#809):清单声明 + 文件真实存在且是 PNG。
      const manifestJson = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(manifestJson.icon).toBe('assets/icon.png');
      expect(manifestJson.schemaVersion).toBe(3);
      expect(manifestJson.minCindyVersion).toBe('1.2.3');
      expect(manifestJson).not.toHaveProperty('slots');
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
      await scaffoldGhostDir(
        {
          dir: existing,
          template: 'plain',
          id: 'existing',
          name: 'Existing',
        },
        { sessionWorkdir: workDir },
      ),
    ).toMatchObject({ ok: false, errorCode: 'TARGET_EXISTS' });
    expect(await fs.promises.readFile(path.join(existing, 'keep.txt'), 'utf8')).toBe('keep me');

    const invalid = path.join(workDir, 'invalid');
    expect(
      await scaffoldGhostDir(
        {
          dir: invalid,
          template: 'plain',
          id: 'INVALID_ID',
          name: 'Invalid',
        },
        { sessionWorkdir: workDir },
      ),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    await expect(fs.promises.stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('拒绝把骨架落进 Host 受管根:根内、后代、大小写别名与 junction 别名都不行', async () => {
    // 受管根恰好落在会话工作目录里(用户把 userData 当工作目录打开的情形):
    // 工作目录检查放行,受管根检查必须接着挡住。
    const managedRoot = path.join(workDir, 'cindy-brain');
    const installedDir = path.join(managedRoot, 'demo');
    await fs.promises.mkdir(installedDir, { recursive: true });
    const scaffold = (dir: string, forbidden: readonly string[]) =>
      scaffoldGhostDir(
        { dir, template: 'plain', id: 'managed-demo', name: 'Managed demo' },
        { sessionWorkdir: workDir, forbiddenRootDirs: forbidden },
      );

    expect(await scaffold(path.join(managedRoot, 'fresh'), [managedRoot])).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
    expect(await scaffold(path.join(installedDir, 'src'), [managedRoot])).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
    expect(fs.existsSync(path.join(installedDir, 'src'))).toBe(false);

    // 状态根还没建出来也要挡住(首次装入前就该拒)。
    const stateRoot = path.join(workDir, 'ghost-install-state');
    expect(await scaffold(path.join(stateRoot, 'nested'), [stateRoot])).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });

    if (process.platform === 'win32') {
      expect(
        await scaffold(path.join(managedRoot.toUpperCase(), 'fresh'), [managedRoot.toLowerCase()]),
      ).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    }

    // junction/软链别名:字面在别处,realpath 落在受管根内。
    const alias = path.join(workDir, 'managed-alias');
    try {
      fs.symlinkSync(installedDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Windows 无特权时建不出夹具,守卫仍在
    }
    expect(await scaffold(path.join(alias, 'src'), [managedRoot])).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
    expect(fs.existsSync(path.join(installedDir, 'src'))).toBe(false);
  });

  it('工作目录里的独立作者目录不受受管根禁区影响', async () => {
    const dir = path.join(workDir, 'my-plugin');
    expect(
      await scaffoldGhostDir(
        { dir, template: 'plain', id: 'my-plugin', name: 'My plugin' },
        {
          sessionWorkdir: workDir,
          forbiddenRootDirs: [
            path.join(workDir, 'cindy-brain'),
            path.join(workDir, 'ghost-install-state'),
          ],
        },
      ),
    ).toMatchObject({ ok: true, dir });
  });

  it('拒绝仍指向工作目录内部的链接祖先，不把 8.3 路径兼容变成链接放行', async () => {
    const realRoot = path.join(workDir, 'real-author-root');
    const aliasRoot = path.join(workDir, 'author-alias');
    await fs.promises.mkdir(path.join(realRoot, 'nested'), { recursive: true });
    try {
      await fs.promises.symlink(realRoot, aliasRoot, directoryLinkType);
    } catch {
      return;
    }

    const dir = path.join(aliasRoot, 'nested', 'plugin');
    expect(
      await scaffoldGhostDir(
        { dir, template: 'plain', id: 'linked-parent', name: 'Linked parent' },
        { sessionWorkdir: workDir },
      ),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(fs.existsSync(path.join(realRoot, 'nested', 'plugin'))).toBe(false);
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
        await scaffoldGhostDir(
          {
            dir: path.join(workDir, 'out', 'plugin'),
            template: 'plain',
            id: 'escape',
            name: 'Escape',
          },
          { sessionWorkdir: workDir },
        ),
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
  it('documents the org-only token publish flow without exposing a file path handoff', () => {
    expect(FORGE_GUIDE).toContain("intent: 'publish'");
    expect(FORGE_GUIDE).toContain('一次性 `publishToken`');
    expect(FORGE_GUIDE).toContain("ghost_forge_publish({ token: '<publishToken>' })");
    expect(FORGE_GUIDE).toContain('仅企业组织成员可用，个人账号不可用');
  });

  it('documents explicit Forge install without changing pack into an install action', () => {
    expect(FORGE_GUIDE).toContain("ghost_forge_install({ dir: '<绝对路径>' })");
    expect(FORGE_GUIDE).toContain('不要因为 scaffold 或 pack 成功就自动调用本工具');
    expect(FORGE_GUIDE).toContain('同版本也可覆盖');
    expect(FORGE_GUIDE).toContain('个人身份下的 Forge 安装和手动导入都不会取得这项资格');
  });

  it('开场白要求读完沙箱红线与打包测试两章', () => {
    // 聊天里直接说"帮我做个插件"的路径只看到手册,看不到 createPrompt;
    // 两处必读口径分叉会让不同入口的 agent 走出不同的阅读深度。
    expect(FORGE_GUIDE).toContain('至少读完"沙箱红线"与"打包与测试"两章');
    expect(FORGE_GUIDE).not.toContain('卡槽总览');
  });

  it('documents installed-directory isolation and the structured refusal', () => {
    expect(FORGE_GUIDE).toContain('已安装插件目录');
    expect(FORGE_GUIDE).toContain('SOURCE_IS_INSTALLED_PLUGIN');
    // 脚手架侧的同一禁区也要写进手册,否则 agent 会先把骨架建进安装目录再撞墙。
    expect(FORGE_GUIDE).toContain('也不能落在已安装插件目录或 Host 状态目录内');
    expect(FORGE_GUIDE).toContain('复制/迁出');
    expect(FORGE_GUIDE).toContain('junction');
  });

  it('manual 作者契约按职责分流并支持与工具目录交叉导航', () => {
    for (const marker of [
      '## 3.6 manual:按需披露复杂工作流与分层资料',
      '"manual": {',
      'MANUAL.md',
      '目录树可以任意深',
      'Markdown 不写 frontmatter',
      'Manual 的归属不按篇幅长短判断',
      '多工具组合编排',
      '复杂工具深入用法',
      '前置检查、顺序与分支、失败恢复、交付标准',
      '短但决定多个工具如何协作的',
      '很长但只是在枚举某一个工具的参数',
      '用途、输入输出与调用前限制',
      '紧贴实时工具集合的动态规则与参数',
      '同一规则只选一个权威落点',
      '两者并行且可以反复交叉,不是固定读取顺序',
      'ghost_call({ ghost_id: "my-ghost", tool: "list_tools", args: { category: "deploy" } })',
      'ghost_manual({ ghost_id: "my-ghost", path: "getting-started/references/deploy.md" })',
      '不要让多个索引文件互相指回形成循环',
      '只作为 tool-result 按需进入上下文',
      '不进入\n生产 system/developer prompt',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
    expect(FORGE_GUIDE).not.toContain('需要提供较长的工作流、参考表或排障说明时');
    expect(FORGE_GUIDE).not.toContain('只有大手册才拆深层文件');
  });

  it('skill 迁移精确映射召回元数据、正文与容器目录', () => {
    const skillSection = FORGE_GUIDE.slice(
      FORGE_GUIDE.indexOf('## 4.16 捆绑 Agent Skills(skill 能力)'),
      FORGE_GUIDE.indexOf('## 4.17'),
    );
    for (const marker of [
      '迁移时按职责映射,不是按篇幅搬运',
      'Skill frontmatter 的 `name + description` 所承担的身份/召回作用',
      '对标系统提示词区\n  插件花名册的身份与 `recall`',
      '`manual.items` 只是插件容器级一级目录,不对标 Skill frontmatter',
      '`MANUAL.md` 与深层 Markdown 承接 Skill 正文、references',
      '只经 `ghost_manual` tool-result 按需进入上下文',
      '当前已停止新增,未来计划全部废弃',
    ]) {
      expect(skillSection).toContain(marker);
    }
  });

  it('manual 发布契约按顺序锁定 Cindy 版本门槛与旧客户端回退', () => {
    expect(FORGE_GUIDE).toContain(
      'Desktop 信任来源已经完成的版本选择，不再按 `minCindyVersion` 追加筛选或确认弹窗',
    );

    const manualSection = FORGE_GUIDE.slice(
      FORGE_GUIDE.indexOf('## 3.6 manual:按需披露复杂工作流与分层资料'),
      FORGE_GUIDE.indexOf('## 4. main.js 电子脑'),
    );
    const orderedRequirements = [
      'Cindy 先发布',
      '确认首个支持它的**正式版本号**',
      '`minCindyVersion` 设为不低于\n该正式版本',
      '移除\n`skill.items` 的迁移版本也必须设置上述 `minCindyVersion`',
      '服务端还要保留上一份带 Skill 的历史 release',
      '旧客户端能通过历史版本回退',
    ];
    let previousIndex = -1;
    for (const requirement of orderedRequirements) {
      const index = manualSection.indexOf(requirement);
      expect(index, requirement).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it('写死 whenToUse 发现面与二级分派 RULES 契约', () => {
    expect(FORGE_GUIDE).toContain('给模型做插件发现与判断的唯一字段');
    expect(FORGE_GUIDE).toContain(`最多 ${GHOST_MANIFEST_SUMMARY_MAX_CHARS} 字符`);
    expect(FORGE_GUIDE).toContain('花名册命中已知 `ghost_id` 时用');
    expect(FORGE_GUIDE).toContain('未命中或需要全量实时回查时用 `ghost_list`');
    expect(FORGE_GUIDE).toContain('两者都返回完整\n`CindyGhostInfo`');
    expect(FORGE_GUIDE).toContain(
      '禁止塞入"必须/不得"式行为规则、工具调用顺序、参数协议、错误码与重试策略',
    );
    expect(FORGE_GUIDE).toContain(
      '"whenToUse": "管理项目时找我;必须先调用 list_tools(category=project),再调用 call_tool;遇到 INVALID_ARGS 不得改用其它工具"',
    );
    expect(FORGE_GUIDE).toContain(
      '"whenToUse": "需要查询、创建或更新项目、任务、成员、迭代与发布状态时找我"',
    );
    expect(FORGE_GUIDE).toContain(
      '`list_tools(category)` 返回工具明细时,必须在同一份结果里一并下发该类目的',
    );
    expect(FORGE_GUIDE).toContain('传 category 返回该类目下所有操作的名称、说明与该类目 RULES');
    expect(FORGE_GUIDE).toContain('`rules: [规则键]`');
    expect(FORGE_GUIDE).toContain('参数 schema **和本次自纠必需的规则**');
    expect(FORGE_GUIDE).toContain('`list_tools` 是插件声明的顶层工具,不是 Host 固定工具');
    expect(FORGE_GUIDE).toContain('两条路径可以反复交叉,没有固定先后顺序');
    expect(FORGE_GUIDE).not.toContain('这是你影响 AI 行为的**唯一合法通道**');
    expect(FORGE_GUIDE).not.toContain('description(花名册自述)');
    expect(FORGE_GUIDE).not.toContain('选错会拖累所有会话');
    expect(FORGE_GUIDE).not.toContain('所有意识的工具清单会一起被你一家撑爆');
  });

  it('向量检索示例按请求维度回放,不把回执 dim 当作请求判据', () => {
    expect(FORGE_GUIDE).toContain('const requestedDim = undefined');
    expect(FORGE_GUIDE).toContain('requestedDim 来自这次请求而不是回执');
    expect(FORGE_GUIDE).toContain(
      '...(storedRequestedDim !== undefined ? { dimensions: storedRequestedDim } : {}),',
    );
    expect(FORGE_GUIDE).not.toContain(
      '...(storedDim !== undefined ? { dimensions: storedDim } : {}),',
    );
  });

  it('app-context 保持插件协议旧四语并说明新增宿主语言的兼容回退', () => {
    expect(FORGE_GUIDE).toContain("locale: 'zh-CN' | 'en' | 'ja' | 'ko'");
    expect(FORGE_GUIDE).not.toContain("locale: 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'");
    expect(FORGE_GUIDE).toContain('会在插件边界固定映射为 `en`');
  });

  it('settingsHtml / panel 普通 HTTPS 外链契约与宿主安全闸一致', () => {
    const settingsSection = FORGE_GUIDE.slice(
      FORGE_GUIDE.indexOf('## 4.8 设置自绘(settingsHtml)+ 自定义参数存取(/kv)'),
      FORGE_GUIDE.indexOf('## 4.9'),
    );
    for (const marker of [
      '<a href="https://…">',
      'network.secrets[].url',
      'node.secretBindings[].url',
      '逐字一致',
      'xd.com',
      'xd.cn',
      'workers.xd.team',
      '二次确认',
      '非 HTTPS',
      '用户名/密码',
      'target="_blank"',
      'window.open()',
      '不支持',
    ]) {
      expect(settingsSection).toContain(marker);
    }
    expect(settingsSection).not.toContain('声明之外的任何外链点了没反应');
  });

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
      expect(bytes, `${header} 超出分章安全体量,请拆小节`).toBeLessThanOrEqual(CHAPTER_BYTE_LIMIT);
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
      'notify 能力',
      'will-user-message',
      'will-assistant-message',
      '同轮插话(steer)时是当前运行中 turn 的模型 id',
      'event-verdict',
      'data-ghost-action',
      'data-ghost-prompt',
      'card-action',
      'agent 能力',
      'cindy.agent.run',
      '{{user_message}}',
      'userActionToken',
      "mode:'continue'",
      "trigger: 'background'",
      // 2026-07-31 快问快答(cindy.text.oneshot)与派活取件(agent.errand)。
      'oneshot_text',
      'NO_CANDIDATE',
      // 2026-08-05 快问快答偏好模型声明(目录模型 id;用户钉档 > 插件声明 > 默认链)。
      'oneshotModel',
      'expectJson',
      // 2026-08-04 文本转向量(cindy.embed.text):作者最容易踩的是"换模型 =
      // 换向量空间",手册必须讲到 model + dim 要跟向量一起存。
      'embed_text',
      '"embed": ["text"]',
      'inputType',
      'dimensions',
      // 上下文化(voyage-context-*):二维 documents 与三层 documentEmbeddings 是
      // 作者最容易写错的两处,手册必须给出可照抄的形态。
      'documents',
      'documentEmbeddings',
      'voyage/voyage-context-4',
      '4.11.1',
      'cindy.agent.errand',
      'queryErrand',
      '"errand": true',
      'node 能力',
      'userActionToken',
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
      'network 能力',
      '媒体上传',
      '凭证明文永不进沙箱',
      '/secrets',
      // 收单契约(2026-07-13 宿主凭证渲染退役):user 凭证一律 settingsHtml 收单。
      '一次性交给主机保险库',
      '尾 4 位',
      'exchange',
      'tokenPath',
      'login-email',
      'gh-cli',
      'gh auth token',
      'hostAvailable',
      // 多连接(connections,2026-07-14):声明形态 / 设置页协议 / 主机受信确认。
      'connections',
      '/connections',
      'maxConnections',
      '受信确认',
      'CONFIRM_DENIED',
      'uploadDir',
      'dir_deposit',
      // 目录/保存交接的权限档契约:本地 Full Access 自动，其余/远程确认。
      '本地 Full Access 会话则自动过户、不弹卡',
      '远程会话仍由用户确认',
      // fs 槽(2026-07-14):三档代写(私有目录/工作目录/save 票据)。
      'fs-request',
      "root: 'data'",
      "root: 'workdir'",
      "root: 'save'",
      'save_deposit.token',
      '沙箱红线',
      'ghost_forge_scaffold',
      'ghost_forge_pack',
      'ghost_forge_install',
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
      '会话上下文(sessionContext 能力)',
      'workdir_is_local',
      'workdir_is_read_only',
      'node.entries',
      'node.secretBindings',
      'request.cindy.secrets',
      '目录选择(pick 能力)',
      'cindy.pick',
      '面板预览(preview 能力)',
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
      '最小化面板',
      // Manifest v3:直接字段声明能力；未知字段保留但不授权。
      'v3 直接用顶层字段声明插件贡献项与自主 Host 能力',
      'v2 的 `slots` 只用于存量包兼容',
      'v3 未识别的顶层字段会原样保留',
      '捆绑 Agent Skills(skill 能力)',
      'skill.items',
      'SKILL.md',
      '~/.agents/skills',
      '逐字一致',
      '不受插件沙箱约束',
      // 工作区会话(workspace):目录亲选/确认卡授权,判重复用。
      '创建工作区会话(workspace 能力)',
      'cindy.workspace',
      "kind: 'ensure-session'",
      // 2026-08-06 iOS Simulator 插件能力:只读脱敏状态与 Host 面板入口。
      '内置 iOS 模拟器(iosSimulator 能力)',
      'cindy.iosSimulator.request',
      'caps.capabilities.pluginVideo === false',
      'caps.capabilities.pluginInput === false',
      '如果插件整体离开 `iosSimulator` 就无法完成任何工作',
      // 一级插件主视图:v3 直接字段、locale 与沙箱边界。
      '一级主视图(mainView 能力)',
      '"mainView": { "title": "工作台", "icon": "puzzle", "html": "main-view.html" }',
      '`mainView.title`',
      '`mainView.icon`',
      '`puzzle`、`globe`、`code`、`folder`、`database`、`chart-column`',
      '只控制主视图的侧边栏入口',
      // 2026-07-28 图标与官方仓门禁(#809):§1/§2 的 icon 字段说明、
      // §8.1 官方插件仓的四语言 locale 与 assets/icon.png 惯例。
      '"icon": "assets/icon.png"',
      '不收 svg',
      '发布到官方插件仓的额外门禁',
      'makecindy/cindy-official-plugins',
      '四语言 locale 缺一不可',
      // 2026-08-19 范例与源码指引:§1 补官方插件仓 URL(真实完整范例)与
      // 主仓地址(插件基座,apps/desktop/src/main/cindy-brain/),并写死边界
      // ——API 契约一律以手册为准,main 分支可能与用户安装版本不一致。
      'github.com/makecindy/cindy-official-plugins',
      // 范例判据是"含 ghost.json 的一级目录",不是"每个一级目录"——
      // 仓库根还有 .tests/docs 等基础设施目录(PR #3023 review)。
      '每个**含 ghost.json 的',
      '不是插件',
      'apps/desktop/src/main/cindy-brain/',
      'API 契约一律以本手册为准',
      'github.com/makecindy/cindy',
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
      // 2026-07-31 确认弹窗(confirm 能力):主机同款确认框 + 真实点击回执;
      // §2 能力清单、§4.9 的"不是确认框"指向、§4.18 章节三处同步。
      '确认弹窗(confirm 能力)',
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
    expect(FORGE_GUIDE).not.toContain('十八个卡槽');
    expect(FORGE_GUIDE).not.toContain('十九个卡槽');
  });

  it('打包前仅轻提醒一次图标选择，AI 生成有固定提示词且失败不阻塞', () => {
    for (const marker of [
      '没有明确替换它生成的占位图',
      '轻提醒一次',
      '使用用户当前对话语言',
      '使用 AI 生成（推荐）',
      '上传图片',
      '同步把',
      'ghost.json',
      'icon',
      '使用默认图标（跳过）',
      '聊天模型解耦',
      '不要因为用户正在使用 GLM',
      'Create a polished square app icon for a Cindy plugin named "{{name}}"',
      'Purpose: {{one-sentence purpose}}',
      'No text, letters, numbers',
      'Output a 1024×1024 PNG',
      '只尝试一次',
      '超时或失败时不要重试',
      'xdt_image_url',
      'xdt_image_urls',
      'selectedImageUrl',
      'icon_source: selectedImageUrl',
      '两种工具都会回退默认图标',
      'pack 会保留原图标和原签名',
      '跳过与使用默认是同一个选择',
      '不要用 AI 仿制商标',
      '使用官方品牌图标',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});

describe('packGhostDir · skill 能力', () => {
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

describe('packGhostDir · manual 渐进披露手册', () => {
  const manualManifest = {
    ...GOOD_MANIFEST,
    id: 'manual-demo',
    manual: {
      items: [
        { dir: 'manual', name: 'overview', description: '总览' },
        { dir: 'manual/advanced', name: 'advanced', description: '进阶' },
      ],
    },
  };

  it('任意深度与嵌套单元可打包，同一产物通过装入侧 inspect', async () => {
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manualManifest),
      'main.js': '// brain',
      'manual/MANUAL.md': '# 总览',
      'manual/references/deep/flow.md': '# 深层流程',
      'manual/advanced/MANUAL.md': '# 进阶',
      'manual/advanced/references/tuning.MD': '# 调优',
    });
    const packed = await packGhostDir(dir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const inspected = await new GhostManager({
      getRootDir: () => path.join(workDir, 'ghosts'),
    }).inspect(packed.cindyPath);
    expect(inspected).toMatchObject({
      manifest: { manual: { items: [{ name: 'overview' }, { name: 'advanced' }] } },
    });
  });

  it('64KB 正文放行，64KB+1、非法 UTF-8、二进制控制字节与非 Markdown 拒绝', async () => {
    const cases: Array<[string, Buffer | string, string]> = [
      ['manual/too-large.md', Buffer.alloc(64 * 1024 + 1, 0x61), '过大'],
      ['manual/invalid.md', Buffer.from([0xff, 0xfe]), '非法 UTF-8'],
      ['manual/binary.md', Buffer.from('ok\u0000bad'), '控制字节'],
      ['manual/data.json', '{}', '非 Markdown'],
    ];
    const good = await makeSrcDir({
      'ghost.json': JSON.stringify({
        ...GOOD_MANIFEST,
        manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
      }),
      'main.js': '// brain',
      'manual/MANUAL.md': Buffer.alloc(64 * 1024, 0x61),
    });
    expect((await packGhostDir(good)).ok).toBe(true);

    for (const [relativePath, content] of cases) {
      const dir = path.join(workDir, relativePath.replaceAll('/', '-'));
      await fs.promises.mkdir(path.join(dir, 'manual'), { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'ghost.json'),
        JSON.stringify({
          ...GOOD_MANIFEST,
          manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
        }),
      );
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      await fs.promises.writeFile(path.join(dir, 'manual/MANUAL.md'), '# 总览');
      await fs.promises.writeFile(path.join(dir, relativePath), content);
      expect(await packGhostDir(dir), relativePath).toMatchObject({
        ok: false,
        errorCode: 'MANIFEST_INVALID',
      });
    }
  });

  it('缺 MANUAL.md 与手册目录内符号链接会在打包期拒绝', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
    };
    const missing = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
      'manual/other.md': '# 其它',
    });
    expect(await packGhostDir(missing)).toMatchObject({ ok: false, errorCode: 'ENTRY_MISSING' });

    if (canSymlink) {
      const dir = path.join(workDir, 'manual-link');
      await fs.promises.mkdir(path.join(dir, 'manual'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      await fs.promises.writeFile(path.join(dir, 'manual/MANUAL.md'), '# 总览');
      const target = path.join(workDir, 'outside.md');
      await fs.promises.writeFile(target, '# 外部');
      await fs.promises.symlink(target, path.join(dir, 'manual/link.md'));
      expect(await packGhostDir(dir)).toMatchObject({
        ok: false,
        errorCode: 'MANIFEST_INVALID',
      });
    }
  });

  it('隐藏 Markdown 与隐藏目录沿用打包过滤规则，不入包也不触发变化误报', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
      'manual/MANUAL.md': '# 总览',
      'manual/visible.md': '# 可见正文',
      'manual/.draft.md': '# 草稿',
      'manual/.draft/hidden.md': '# 隐藏目录正文',
    });
    const packed = await packGhostDir(dir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(packed.cindyPath));
    expect(zip.file('manual/MANUAL.md')).not.toBeNull();
    expect(zip.file('manual/visible.md')).not.toBeNull();
    expect(zip.file('manual/.draft.md')).toBeNull();
    expect(zip.file('manual/.draft/hidden.md')).toBeNull();
  });

  it('MANUAL.md 入口必须逐字匹配，大小写不敏感文件系统也不能用 manual.md 冒充', async () => {
    const manifest = {
      ...GOOD_MANIFEST,
      manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
    };
    const dir = await makeSrcDir({
      'ghost.json': JSON.stringify(manifest),
      'main.js': '// brain',
      'manual/manual.md': '# 错误大小写入口',
    });
    const lowercaseEntry = path.join(dir, 'manual/manual.md');
    const uppercaseEntry = path.join(dir, 'manual/MANUAL.md');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation(((
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (String(target) === uppercaseEntry) {
        return originalLstat(lowercaseEntry, options as never);
      }
      return originalLstat(target, options as never);
    }) as typeof fs.promises.lstat);

    expect(await packGhostDir(dir)).toMatchObject({
      ok: false,
      errorCode: 'ENTRY_MISSING',
    });
    expect(lstatSpy.mock.calls.some(([target]) => String(target) === uppercaseEntry)).toBe(false);
  });

  it('制品中的 C0、DEL、反斜杠文件名和非法目录名在 Forge 侧直接拒绝', async () => {
    if (process.platform === 'win32') return;
    const manifest = {
      ...GOOD_MANIFEST,
      manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
    };
    const cases = [
      { relativePath: `bad${String.fromCharCode(1)}name.md`, directory: false },
      { relativePath: `bad${String.fromCharCode(0x7f)}dir`, directory: true },
      { relativePath: 'bad\\windows.md', directory: false },
    ];
    for (const [index, testCase] of cases.entries()) {
      const dir = path.join(workDir, `manual-invalid-path-${index}`);
      await fs.promises.mkdir(path.join(dir, 'manual'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      await fs.promises.writeFile(path.join(dir, 'manual/MANUAL.md'), '# 总览');
      const invalidPath = path.join(dir, 'manual', testCase.relativePath);
      if (testCase.directory) {
        await fs.promises.mkdir(invalidPath);
        await fs.promises.writeFile(path.join(invalidPath, 'nested.md'), '# invalid');
      } else {
        await fs.promises.writeFile(invalidPath, '# invalid');
      }
      expect(await packGhostDir(dir), testCase.relativePath).toMatchObject({
        ok: false,
        errorCode: 'MANIFEST_INVALID',
      });
    }
  });
});
