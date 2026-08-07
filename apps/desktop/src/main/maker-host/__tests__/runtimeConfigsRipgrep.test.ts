/**
 * runtimeConfigsRipgrep.test.ts —— issue #1956 回归守卫:
 * runtime-configs 的 bundled ripgrep 探测必须**惰性化**。
 *
 * 固化三条契约:
 *   1. import 零探测:electron mock 故意不提供 getAppPath / isPackaged,
 *      import runtime-configs 不得炸(纯 node / vitest 收集期安全)。
 *   2. 惰性 fail-fast:pathPrepends / getRipgrepBinaryPath /
 *      ensureBundledRipgrepReady 在 rg 缺失时**访问才** throw,且失败不缓存
 *      (补装 rg 后同进程重试即可成功)。
 *   3. 成功结果 memoize:pathPrepends 每次 codex spawn 都读、
 *      getRipgrepBinaryPath 每次 file-browser 搜索都调,命中后不得重复 fs 探测。
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(() => false),
  chmodSync: vi.fn(),
  getAppPath: vi.fn(() => '/xdt-lazy-rg/app'),
}));

function mockElectronApp(app: Record<string, unknown>): void {
  vi.doMock('electron', () => ({ app }));
}

function mockFsProbe(): void {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...actual,
      existsSync: h.existsSync,
      chmodSync: h.chmodSync,
      default: { ...actual, existsSync: h.existsSync, chmodSync: h.chmodSync },
    };
  });
}

// 同 runtimeConfigs.test.ts:剪断 model-access 凭证链的文件 IO,本测试不断言 endpoint。
function mockEffectiveEndpoint(): void {
  vi.doMock('../../model-access/effectiveEndpoint.js', () => ({
    effectiveXdGatewayBaseUrl: () => 'http://127.0.0.1:0',
  }));
}

const platformKey = `${process.platform}-${process.arch}`;
const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
// dev 分支第一个候选:与 runtime-configs 内 path.join 同式构造(宿主路径断言走 path API)。
const expectedDevDir = path.join('/xdt-lazy-rg/app', '..', '..', 'apps', 'ripgrep-bin', platformKey);

beforeEach(() => {
  vi.resetModules();
  h.existsSync.mockClear().mockReturnValue(false);
  h.chmodSync.mockClear();
  h.getAppPath.mockClear();
});

describe('runtime-configs bundled ripgrep laziness (#1956)', () => {
  it('import 不探测 ripgrep:electron mock 无 getAppPath / isPackaged 也能加载', async () => {
    // 只有 getPath:desktopCodexRuntimeConfig.userDataPath 仍在模块期读 userData。
    // getAppPath / isPackaged 缺席 —— 若模块顶层恢复探测,这里收集期即 TypeError。
    mockElectronApp({ getPath: () => '/xdt-lazy-rg/user-data' });
    mockFsProbe();
    mockEffectiveEndpoint();

    const mod = await import('../runtime-configs.js');

    expect(mod.desktopCodexRuntimeConfig.userDataPath).toBe('/xdt-lazy-rg/user-data');
    expect(typeof mod.getRipgrepBinaryPath).toBe('function');
    expect(typeof mod.ensureBundledRipgrepReady).toBe('function');
    expect(h.existsSync).not.toHaveBeenCalled();
  });

  it('pathPrepends 访问期才探测:rg 缺失时 throw,且失败不缓存可重试', async () => {
    mockElectronApp({
      getPath: () => '/xdt-lazy-rg/user-data',
      getAppPath: h.getAppPath,
      isPackaged: false,
    });
    mockFsProbe();
    mockEffectiveEndpoint();

    const { desktopCodexRuntimeConfig, ensureBundledRipgrepReady } = await import(
      '../runtime-configs.js'
    );
    // import 期零探测:getAppPath 与 fs 都不该被碰过。
    expect(h.getAppPath).not.toHaveBeenCalled();
    expect(h.existsSync).not.toHaveBeenCalled();

    expect(() => desktopCodexRuntimeConfig.pathPrepends).toThrow(/Bundled ripgrep not found/u);
    expect(() => ensureBundledRipgrepReady()).toThrow(/Bundled ripgrep not found/u);

    // 失败不缓存:补装 rg(existsSync 转 true)后同进程重试即成功。
    h.existsSync.mockReturnValue(true);
    expect(desktopCodexRuntimeConfig.pathPrepends).toEqual([expectedDevDir]);
  });

  it('探测成功后 memoize:重复访问 pathPrepends / getRipgrepBinaryPath 不再打 fs', async () => {
    mockElectronApp({
      getPath: () => '/xdt-lazy-rg/user-data',
      getAppPath: h.getAppPath,
      isPackaged: false,
    });
    mockFsProbe();
    mockEffectiveEndpoint();
    h.existsSync.mockReturnValue(true);

    const { desktopCodexRuntimeConfig, getRipgrepBinaryPath, ensureBundledRipgrepReady } =
      await import('../runtime-configs.js');

    expect(desktopCodexRuntimeConfig.pathPrepends).toEqual([expectedDevDir]);
    const probeCallsAfterHit = h.existsSync.mock.calls.length;
    expect(probeCallsAfterHit).toBeGreaterThan(0);

    // 此后所有访问路径(spawn env、file-browser 搜索、启动期预热)都只吃缓存。
    desktopCodexRuntimeConfig.pathPrepends;
    ensureBundledRipgrepReady();
    expect(getRipgrepBinaryPath()).toBe(path.join(expectedDevDir, rgBinaryName));
    expect(h.existsSync.mock.calls.length).toBe(probeCallsAfterHit);
  });
});
