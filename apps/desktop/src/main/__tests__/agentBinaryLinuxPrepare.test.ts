import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// getBase() 按 kind 缓存 provisioner 实例:全部测试共享同一个 cdndProvisioner,
// 每测试重配它的行为(而不是 mockReturnValueOnce 换实例——缓存会让新实例永远不被使用)。
const {
  appMock,
  cdndProvisioner,
  createBinaryProvisioner,
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
} = vi.hoisted(() => {
  const cdndProvisioner = {
    prepare: vi.fn(),
    peekNeedsDownload: vi.fn(),
    getState: vi.fn(async () => ({ status: 'not_installed' })),
    cleanup: vi.fn(),
  };
  return {
    appMock: { isPackaged: true, getPath: vi.fn(() => '/tmp/xdt-userdata') },
    cdndProvisioner,
    createBinaryProvisioner: vi.fn(() => cdndProvisioner),
    findCachedLinuxRuntimeFallbackBinary: vi.fn((): string | null => null),
    prepareLinuxRuntimeFallback: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../agent-binaries/factory.js', () => ({ createBinaryProvisioner }));
vi.mock('../agent-binaries/dev-fallback.js', () => ({ findDevBinary: vi.fn(() => null) }));
vi.mock('../agent-binaries/linux-runtime-fallback.js', () => ({
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
}));
// CDN manifest 缺省不可用(无缓存、拉取也拿不到)。CDN 命中用例单独 stub。
vi.mock('../manifestService.js', () => ({
  getPlatformKey: () => 'linux-x64',
  getCachedManifest: vi.fn((): unknown => null),
  fetchManifest: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../updateProgressNormalizer.js', () => ({
  ProgressNormalizer: class {
    handle(): void {}
    flush(): void {}
    getCurrent(): number { return 0; }
  },
}));

const originalPlatform = process.platform;
let binaries: typeof import('../agent-binaries/index');
let manifestService: { getCachedManifest: ReturnType<typeof vi.fn>; fetchManifest: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

// peek 的 manifest 探测是模块级 single-flight + 负缓存:每测试 resetModules +
// 重新 import,否则前一个用例的探测结果(memo)会泄漏进下一个用例。
async function reloadBinaries(): Promise<void> {
  vi.resetModules();
  manifestService = (await import('../manifestService.js')) as never;
  binaries = await import('../agent-binaries/index');
}

beforeEach(async () => {
  await reloadBinaries();
  vi.clearAllMocks();
  appMock.isPackaged = true;
  // 默认:CDN 链失败(asset_missing)→ 回落 fallback;fallback 命中私有安装。
  cdndProvisioner.prepare.mockReset().mockResolvedValue({ ready: false, binaryPath: '', error: 'asset_missing' });
  cdndProvisioner.peekNeedsDownload.mockReset().mockResolvedValue(true);
  // manifestService 是 reloadBinaries 刚重建的 mock(工厂默认实现仍在):
  // getCachedManifest → null / fetchManifest → Promise<null>。用例里覆盖时用
  // mockReturnValue/mockResolvedValue,别 mockReset(会连默认实现一起清掉)。
  manifestService.getCachedManifest.mockReturnValue(null);
  manifestService.fetchManifest.mockResolvedValue(null);
  findCachedLinuxRuntimeFallbackBinary.mockReturnValue(null);
  prepareLinuxRuntimeFallback.mockResolvedValue({
    ready: true,
    binaryPath: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
    installed: true,
    source: 'installed',
  });
});

describe('packaged Linux agent binary prepare', () => {
  it('keeps cached status fs-only and does not run runtime verification', () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(
      '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    );

    expect(binaries.getCachedBinaryStatus('codex')).toEqual({
      binaryReady: true,
      binaryPath: '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    });
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
  });

  it('falls back to the runtime chain when the CDN chain reports asset_missing', async () => {
    prepareLinuxRuntimeFallback.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/usr/local/bin/claude',
      installed: false,
      source: 'system',
    });

    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/usr/local/bin/claude',
      downloaded: false,
    });
    // CDN 链先试(manifest 无段 → asset_missing),失败后静默落到 fallback。
    expect(cdndProvisioner.prepare).toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith('claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
  });

  it('propagates signal and returns fallback install result when CDN misses', async () => {
    const controller = new AbortController();
    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
      downloaded: true,
    });
    await binaries.prepare('codex', { signal: controller.signal });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(1, 'claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(2, 'codex', {
      signal: controller.signal,
      onProgress: expect.any(Function),
    });
  });

  it('prefers the CDN chain when the manifest publishes a linux asset, without touching the fallback', async () => {
    manifestService.getCachedManifest.mockReturnValue({
      app: { version: '0.1.59' },
      claudeCode: {
        version: '2.1.219',
        file: 'claude-code/2.1.219/linux-x64/claude.gz',
        sha256: 'a'.repeat(64),
        size: 1234,
      },
    });
    cdndProvisioner.prepare.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/tmp/xdt-userdata/claude-code/2.1.219/claude',
    });

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/claude-code/2.1.219/claude');
    expect(prepareLinuxRuntimeFallback).not.toHaveBeenCalled();
  });

  it('survives a throwing CDN chain and still resolves via the fallback', async () => {
    cdndProvisioner.prepare.mockReset().mockRejectedValue(new Error('disk exploded'));

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude');
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalled();
  });

  it('peek pulls a manifest when none is cached and falls back to the fs check on a miss', async () => {
    // 无缓存 → peek 拉一次 manifest(与 prepare 同判据);拉取失败/null → fs 快查。
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(manifestService.fetchManifest).toHaveBeenCalled();
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
    expect(cdndProvisioner.peekNeedsDownload).not.toHaveBeenCalled();
  });

  it('peek probes the manifest once per splash round across vendors (single flight)', async () => {
    // 同轮内:两个 vendor 的 peek 共享一次探测(第二个 peek 命中 memo)。
    manifestService.fetchManifest.mockRejectedValue(new Error('offline'));
    await expect(binaries.peekNeedsDownload('claude-code')).resolves.toBe(true);
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(manifestService.fetchManifest).toHaveBeenCalledTimes(1);
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledTimes(2);
  });

  it('prepare clears the probe memo so the next retry round re-probes the manifest', async () => {
    // 模拟真实 retry 流程:peek(Phase 0)→ prepare(Phase 1)清 memo →
    // 下一轮 peek 重新探测(网络恢复后进度标签与 prepare 行为对齐)。
    manifestService.fetchManifest.mockRejectedValue(new Error('offline'));
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    await expect(binaries.peekNeedsDownload('claude-code')).resolves.toBe(true);
    expect(manifestService.fetchManifest).toHaveBeenCalledTimes(1);
    // 本轮 prepare(默认 mock:CDN 失败 → fallback 成功)。
    await expect(binaries.prepare('claude-code')).resolves.toMatchObject({ ready: true });
    // 下一轮 peek:重新探测。
    await expect(binaries.peekNeedsDownload('claude-code')).resolves.toBe(true);
    expect(manifestService.fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('skips the CDN leg when the round peek probe failed and goes straight to fallback', async () => {
    // peek 失败 → 本轮 prepare 跳过 CDN 腿,直接 fallback(离线 + 本地已有
    // runtime 的首启不再为两个 vendor 白等 2×30s manifest 拉取)。
    manifestService.fetchManifest.mockRejectedValue(new Error('offline'));
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    const result = await binaries.prepare('claude-code');
    expect(result.ready).toBe(true);
    expect(cdndProvisioner.prepare).not.toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalled();
  });

  it('peek delegates to the CDN check when the manifest publishes a linux asset', async () => {
    manifestService.getCachedManifest.mockReturnValue({
      app: { version: '0.1.59' },
      codex: {
        version: '0.144.6',
        file: 'codex/0.144.6/linux-x64/codex.gz',
        sha256: 'b'.repeat(64),
        size: 5678,
      },
    });

    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(cdndProvisioner.peekNeedsDownload).toHaveBeenCalled();
    expect(findCachedLinuxRuntimeFallbackBinary).not.toHaveBeenCalled();
  });

  it('gives the CDN leg its own signal and preserves the original one for the fallback', async () => {
    const controller = new AbortController();
    // CDN 腿失败(模拟拖满自身预算),fallback 必须收到原始未中止的 signal,
    // 否则官方源兜底会在共享 deadline 被耗尽时名存实亡。
    cdndProvisioner.prepare.mockReset().mockRejectedValue(new Error('cdn leg timed out'));

    const result = await binaries.prepare('claude-code', { signal: controller.signal });

    expect(result.ready).toBe(true);
    // CDN 腿收到的是包装后的独立 signal,不是调用方原始 signal。
    const cdnArgs = cdndProvisioner.prepare.mock.calls[0][0];
    expect(cdnArgs.signal).toBeInstanceOf(AbortSignal);
    expect(cdnArgs.signal).not.toBe(controller.signal);
    // fallback 收到的是原始 signal(未被 CDN 腿污染)。
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
