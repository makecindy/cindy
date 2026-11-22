import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mainBundleBuildId,
  mainCompileCacheAllowed,
  startMainCompileCache,
  type MainCompileCacheInstall,
  type MainCompileCacheRuntime,
} from '../mainCompileCache.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：mainCompileCacheAllowed / startMainCompileCache；决定主进程是否执行
 *   用户可写目录里的 V8 字节码，以及 userData 里留下哪些缓存目录。
 * - Bug／规则依据：用户 2026-11-22 选定的安全边界（正式版只在 Windows 用户目录安装时开启，
 *   macOS、Linux 与受保护目录不开）；credentials-and-local-storage「跨重启数据要有生命周期」；
 *   PR #12070 review：启动环境的 NODE_COMPILE_CACHE 会先于应用代码开启缓存。
 * - 现有覆盖缺口：新模块，无相邻覆盖。
 * - 最小失败输入：macOS 正式版被放行；Windows 同前缀的兄弟目录（C:\Users\me2）被当成用户目录；
 *   清理误删当前构建或漏删未启用时的旧目录；不允许的安装上环境已开启缓存却不报告或被当作自己的缓存；
 *   只有 bootstrap 块重建时构建标识不变（旧条目在同一目录里累积）。
 * - tier：unit；纯函数加 mkdtemp 下的少量目录，Node 编译缓存经注入的假实现，不影响测试进程。
 * - 实测耗时：单文件约 1 秒（pnpm --dir apps/desktop exec vitest run src/main/__tests__/mainCompileCache.test.ts）。
 */

const ENABLED = constants.compileCacheStatus.ENABLED;
const ALREADY_ENABLED = constants.compileCacheStatus.ALREADY_ENABLED;
const DISABLED = constants.compileCacheStatus.DISABLED;

describe('mainCompileCacheAllowed', () => {
  const windowsHome = 'C:\\Users\\me';
  it.each<[string, MainCompileCacheInstall, boolean]>([
    ['source run, even on macOS', { isPackaged: false, platform: 'darwin', resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources', homeDir: '/Users/me' }, true],
    ['Windows default per-user install', { isPackaged: true, platform: 'win32', resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Cindy\\resources', homeDir: windowsHome }, true],
    ['Windows per-user install, path case differs', { isPackaged: true, platform: 'win32', resourcesPath: 'c:\\users\\ME\\AppData\\Local\\Programs\\Cindy\\resources', homeDir: windowsHome }, true],
    ['Windows install in Program Files', { isPackaged: true, platform: 'win32', resourcesPath: 'C:\\Program Files\\Cindy\\resources', homeDir: windowsHome }, false],
    ['Windows sibling profile sharing the home prefix', { isPackaged: true, platform: 'win32', resourcesPath: 'C:\\Users\\me2\\AppData\\Local\\Programs\\Cindy\\resources', homeDir: windowsHome }, false],
    ['Windows install on another drive', { isPackaged: true, platform: 'win32', resourcesPath: 'D:\\Apps\\Cindy\\resources', homeDir: windowsHome }, false],
    ['packaged macOS, even under the home folder', { isPackaged: true, platform: 'darwin', resourcesPath: '/Users/me/Applications/Cindy.app/Contents/Resources', homeDir: '/Users/me' }, false],
    ['packaged Linux user install', { isPackaged: true, platform: 'linux', resourcesPath: '/home/me/.local/share/cindy/resources', homeDir: '/home/me' }, false],
  ])('%s', (_name, install, allowed) => {
    expect(mainCompileCacheAllowed(install)).toBe(allowed);
  });
});

// PR #12070 review: a build id that misses a chunk change lets stale entries pile up in one
// directory, because Node keys entries by module file name and pruning keeps the current id.
describe('mainBundleBuildId', () => {
  const bundle = ['index.js', 'index-CAagRGb6.js', 'bootstrap-electron-BTXpvRje.js', 'dbWorker.js'];
  const idOf = (names: string[], version = '0.0.0') => mainBundleBuildId(version, 'bundle', () => names);

  it.each<[string, string[], string, boolean]>([
    ['only the bootstrap chunk is rebuilt (fixed entry and caller names)', ['index.js', 'index-CAagRGb6.js', 'bootstrap-electron-NEWHASH1.js', 'dbWorker.js'], '0.0.0', false],
    ['a new release with identical chunk names', bundle, '0.2.0', false],
    ['the same files listed in another order', [...bundle].reverse(), '0.0.0', true],
    ['a non-JS file appears (source map)', [...bundle, 'index-CAagRGb6.js.map'], '0.0.0', true],
  ])('%s', (_name, names, version, same) => {
    expect(idOf(names, version) === idOf(bundle)).toBe(same);
  });

  it('falls back to a stable version-only id when the directory cannot be read', () => {
    const unreadable = () => mainBundleBuildId('0.0.0', 'bundle', () => { throw new Error('EACCES'); });
    expect(unreadable()).toBe(unreadable());
    expect(unreadable()).toMatch(/^0\.0\.0-[0-9a-f]{12}$/);
  });
});

describe('startMainCompileCache', () => {
  let userDataDir: string | null = null;

  afterEach(async () => {
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  });

  /** Creates `main-compile-cache/<entry>` directories; entries may name a flavor namespace. */
  async function profileWithEntries(...entries: string[][]): Promise<string> {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-main-compile-cache-'));
    for (const entry of entries) await mkdir(path.join(userDataDir, 'main-compile-cache', ...entry), { recursive: true });
    return userDataDir;
  }
  const listing = async (dir: string, ...namespace: string[]) =>
    (await readdir(path.join(dir, 'main-compile-cache', ...namespace)).catch(() => [] as string[])).sort();

  function fakeRuntime(status: number, launchEnvironmentDir?: string, realpath: (target: string) => string = (target) => target) {
    const calls = { enabled: [] as string[], flushes: 0 };
    const runtime: MainCompileCacheRuntime = {
      enableCompileCache: (directory) => {
        calls.enabled.push(directory);
        return { status };
      },
      flushCompileCache: () => {
        calls.flushes += 1;
      },
      getCompileCacheDir: () => launchEnvironmentDir,
      realpath,
    };
    return { calls, runtime };
  }

  // PR #12070 review: a protected install launched through a junction under the profile only
  // looks per-user by its lexical path. The decision uses canonical paths and fails closed.
  it.each<[string, (target: string) => string, string]>([
    ['real per-user install', (target) => target, 'enabled'],
    ['protected install reached through a junction under the profile', (target) => target.replace('C:\\Users\\me\\Apps\\Cindy', 'C:\\Program Files\\Cindy'), 'not-allowed'],
    ['install paths that cannot be resolved', () => { throw new Error('ENOENT'); }, 'not-allowed'],
  ])('packaged Windows: %s', async (_name, realpath, status) => {
    const dir = await profileWithEntries();
    const { calls, runtime } = fakeRuntime(ENABLED, undefined, realpath);
    const install = { isPackaged: true, platform: 'win32' as const, resourcesPath: 'C:\\Users\\me\\Apps\\Cindy\\resources', homeDir: 'C:\\Users\\me' };

    const cache = startMainCompileCache({ ...install, userDataDir: dir, buildId: '1.0.0-abc' }, runtime);

    expect(cache.status).toBe(status);
    expect(calls.enabled).toHaveLength(status === 'enabled' ? 1 : 0);
  });

  const devInstall = { isPackaged: false, platform: process.platform, resourcesPath: os.tmpdir(), homeDir: os.homedir() };
  const macInstall = { isPackaged: true, platform: 'darwin' as const, resourcesPath: '/Applications/Cindy.app/Contents/Resources', homeDir: '/Users/me' };

  // PR #12070 review cases:
  // - NODE_COMPILE_CACHE turns the cache on before app code runs; on a disallowed install it is
  //   reported, never adopted. Its directory is unknown and may sit inside a namespace, so a
  //   pre-enabled cache prunes nothing; on an allowed install it is the cache in use and is flushed.
  // - A source run and the installed app may share one userData at the same time; each prunes only
  //   its own flavor namespace, so neither deletes the cache the other is using.
  const all = ['0.0.0-legacy', 'packaged', 'source'];
  const namespaces = ['packaged', 'source'];
  it.each([
    ['enabled: keeps only the current build of its own flavor', devInstall, ENABLED, undefined, 'enabled', 1, 1, ['0.2.0-new'], ['0.9.0-pkg'], namespaces],
    ['Node reports disabled: empties only its own flavor', devInstall, DISABLED, undefined, 'disabled', 1, 0, [], ['0.9.0-pkg'], namespaces],
    ['allowed install, launch environment enabled it: flushed, nothing pruned', devInstall, ALREADY_ENABLED, '/tmp/env-cache', 'already-enabled', 1, 1, ['0.1.0-old', '0.2.0-new'], ['0.9.0-pkg'], all],
    ['install not allowed: never enables and empties only its own flavor', macInstall, ENABLED, undefined, 'not-allowed', 0, 0, ['0.1.0-old', '0.2.0-new'], [], namespaces],
    ['install not allowed, launch environment enabled it: reported, not adopted, nothing pruned', macInstall, ENABLED, '/tmp/env-cache', 'enabled-by-environment', 0, 0, ['0.1.0-old', '0.2.0-new'], ['0.9.0-pkg'], all],
  ] as const)('%s', async (_name, install, nodeStatus, launchDir, status, enableCalls, flushes, sourceLeft, packagedLeft, rootLeft) => {
    // A layout from earlier builds of this feature sits directly under the root.
    const dir = await profileWithEntries(['source', '0.1.0-old'], ['source', '0.2.0-new'], ['packaged', '0.9.0-pkg'], ['0.0.0-legacy']);
    const { calls, runtime } = fakeRuntime(nodeStatus, launchDir);
    const buildId = install.isPackaged ? '0.9.0-pkg' : '0.2.0-new';

    const cache = startMainCompileCache({ ...install, userDataDir: dir, buildId }, runtime);
    cache.flush();
    await cache.pruneUnused();

    expect(cache.status).toBe(status);
    expect(calls.enabled).toEqual(
      enableCalls ? [path.join(dir, 'main-compile-cache', install.isPackaged ? 'packaged' : 'source', buildId)] : [],
    );
    expect(calls.flushes).toBe(flushes);
    expect(await listing(dir, 'source')).toEqual(sourceLeft);
    expect(await listing(dir, 'packaged')).toEqual(packagedLeft);
    expect(await listing(dir)).toEqual(rootLeft);
  });

  it('pruning tolerates a profile that never had a cache', async () => {
    const dir = await profileWithEntries();
    const { runtime } = fakeRuntime(ENABLED);
    const cache = startMainCompileCache({ ...devInstall, userDataDir: dir, buildId: 'b' }, runtime);
    await expect(cache.pruneUnused()).resolves.toBeUndefined();
  });
});
