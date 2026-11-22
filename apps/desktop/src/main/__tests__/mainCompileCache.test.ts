import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
 *   清理误删当前构建或漏删未启用时的旧目录；不允许的安装上环境已开启缓存却不报告或被当作自己的缓存。
 * - tier：unit；纯函数加 mkdtemp 下的少量目录，Node 编译缓存经注入的假实现，不影响测试进程。
 * - 实测耗时：单文件约 1 秒（pnpm --dir apps/desktop exec vitest run src/main/__tests__/mainCompileCache.test.ts）。
 */

const ENABLED = constants.compileCacheStatus.ENABLED;
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

describe('startMainCompileCache', () => {
  let userDataDir: string | null = null;

  afterEach(async () => {
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  });

  async function profileWithBuilds(...builds: string[]): Promise<string> {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-main-compile-cache-'));
    for (const build of builds) await mkdir(path.join(userDataDir, 'main-compile-cache', build), { recursive: true });
    return userDataDir;
  }

  function fakeRuntime(status: number, launchEnvironmentDir?: string) {
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
    };
    return { calls, runtime };
  }

  const devInstall = { isPackaged: false, platform: process.platform, resourcesPath: os.tmpdir(), homeDir: os.homedir() };
  const macInstall = { isPackaged: true, platform: 'darwin' as const, resourcesPath: '/Applications/Cindy.app/Contents/Resources', homeDir: '/Users/me' };

  // The last case is PR #12070 review: NODE_COMPILE_CACHE turns the cache on before app code runs.
  // It cannot be undone from here, so on a disallowed install it must be reported, never adopted.
  it.each([
    ['enabled: keeps only the current build', devInstall, ENABLED, undefined, 'enabled', 1, 1, ['0.2.0-index-new']],
    ['Node reports disabled: removes every build', devInstall, DISABLED, undefined, 'disabled', 1, 0, []],
    ['install not allowed: never enables and removes leftovers', macInstall, ENABLED, undefined, 'not-allowed', 0, 0, []],
    ['install not allowed, launch environment enabled it: reported, not adopted', macInstall, ENABLED, '/tmp/env-cache', 'enabled-by-environment', 0, 0, []],
  ] as const)('%s', async (_name, install, nodeStatus, launchDir, status, enableCalls, flushes, remaining) => {
    const dir = await profileWithBuilds('0.1.0-index-old', '0.2.0-index-new');
    const { calls, runtime } = fakeRuntime(nodeStatus, launchDir);

    const cache = startMainCompileCache({ ...install, userDataDir: dir, buildId: '0.2.0-index-new' }, runtime);
    cache.flush();
    await cache.pruneUnused();

    expect(cache.status).toBe(status);
    expect(calls.enabled).toEqual(
      enableCalls ? [path.join(dir, 'main-compile-cache', '0.2.0-index-new')] : [],
    );
    expect(calls.flushes).toBe(flushes);
    expect((await readdir(path.join(dir, 'main-compile-cache'))).sort()).toEqual(remaining);
  });

  it('pruning tolerates a profile that never had a cache', async () => {
    const dir = await profileWithBuilds();
    const { runtime } = fakeRuntime(ENABLED);
    const cache = startMainCompileCache({ ...devInstall, userDataDir: dir, buildId: 'b' }, runtime);
    await expect(cache.pruneUnused()).resolves.toBeUndefined();
  });
});
