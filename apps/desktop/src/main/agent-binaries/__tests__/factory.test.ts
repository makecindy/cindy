/**
 * factory.ts(createBinaryProvisioner)emit 时序回归。
 *
 * 背景(2026-07):统一下载器是单槽 FIFO 串行,agent 二进制下载可能在队列里
 * 排在热更 zip 之后。factory 若在 `await download()` 之前就 emit 'downloading',
 * splash 会在排队期间显示一根冻结在 0% 的假进度条;fromCache 命中时还会闪
 * 0→100 假进度。约定:'downloading' 状态只能由传输层真实 onProgress 事件驱动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { VendorRuntimeState } from '../types.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const FAKE_SHA = 'a'.repeat(64);

vi.mock('../../manifestService.js', () => ({
  fetchManifest: vi.fn(async () => null),
  getCachedManifest: vi.fn(() => ({ app: {} })),
  getBaseUrl: () => 'https://cdn.test',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => ({
    version: '9.9.9-test',
    file: 'claude/claude-9.9.9.gz',
    sha256: FAKE_SHA,
    size: 3,
  }),
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

interface DownloadOpts {
  targetPath: string;
  onProgress?: (e: { loaded: number; total: number | null; percent: number | null; speedBps: number }) => void;
}

/** download mock 的成功实现:落一个真实 gzip 让后续解压走通。 */
function fulfillDownload(opts: DownloadOpts, fromCache: boolean): {
  path: string; size: number; sha256: string; fromCache: boolean; durationMs: number; resumedFromBytes: number;
} {
  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
  fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('bin')));
  return {
    path: opts.targetPath,
    size: 3,
    sha256: FAKE_SHA,
    fromCache,
    durationMs: 1,
    resumedFromBytes: 0,
  };
}

function makeProvisioner() {
  // installSubdir 每个用例唯一,落在 electron-stub 的 tmp userData 下,互不污染。
  return createBinaryProvisioner({
    vendorKey: 'claude',
    manifestField: 'claudeCode',
    installSubdir: `factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    artifact: { kind: 'gz', binaryName: 'claude-test-bin' },
  });
}

beforeEach(() => {
  mocks.download.mockReset();
});

describe('createBinaryProvisioner emit 时序', () => {
  it('fromCache 命中(download 不产生 onProgress):全程不得 emit downloading', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, true));

    const statuses: Array<VendorRuntimeState['status']> = [];
    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    // 旧实现会在 download() 之前 emit 一次 downloading/0%,造成 splash 假进度条。
    expect(statuses).not.toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });

  it('真实下载:downloading 只能出现在 download() 的 onProgress 之后(排队期间无事件)', async () => {
    let statusesWhenDownloadInvoked: Array<VendorRuntimeState['status']> = [];
    const statuses: Array<VendorRuntimeState['status']> = [];

    mocks.download.mockImplementation(async (opts: DownloadOpts) => {
      // download() 被调用瞬间 = 任务刚入队(可能在队列里等热更 zip)。
      // 此刻不允许已有任何 downloading emit。
      statusesWhenDownloadInvoked = [...statuses];
      // 模拟排一拍队后传输真正开始,首个进度事件到达。
      await new Promise((r) => setTimeout(r, 10));
      opts.onProgress?.({ loaded: 1, total: 3, percent: 33.3, speedBps: 1024 });
      opts.onProgress?.({ loaded: 3, total: 3, percent: 100, speedBps: 1024 });
      return fulfillDownload(opts, false);
    });

    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    expect(statusesWhenDownloadInvoked).not.toContain('downloading');
    expect(statuses).toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });
});


describe('离线启动 fallback', () => {
  async function mountVerifiedBinary(
    installSubdir: string,
    version: string,
    binaryName: string,
  ): Promise<{ binPath: string; cleanup: () => void }> {
    const { app } = await import('electron');
    const installRoot = path.join(app.getPath('userData'), installSubdir);
    const versionDir = path.join(installRoot, version);
    fs.mkdirSync(versionDir, { recursive: true });
    const binPath = path.join(versionDir, binaryName);
    fs.writeFileSync(binPath, 'fake binary');
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(path.join(versionDir, '.verified'), '');
    return {
      binPath,
      cleanup: () => fs.rmSync(installRoot, { recursive: true, force: true }),
    };
  }

  it('本地有已验证版本时:manifest fetch 失败仍返回 ready', async () => {
    const installSubdir = `offline-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '1.2.3-verified';
    const binaryName = 'test-binary';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      // 让 manifest 和 cache 都返回 null（模拟 CDN 不可达）
      const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
      vi.mocked(getCachedManifest).mockReturnValue(null as any);
      vi.mocked(fetchManifest).mockResolvedValue(null as any);

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'testField',
        installSubdir,
        artifact: { kind: 'raw', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('download 失败时:本地有已验证版本仍返回 ready', async () => {
    const installSubdir = `download-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '2.0.0-verified';
    const binaryName = 'test-binary';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      // manifest 返回成功，但 download 会抛错（模拟 CDN 拦截）
      const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
      vi.mocked(getCachedManifest).mockReturnValue(null as any);
      vi.mocked(fetchManifest).mockResolvedValue({
        version: '2.0.0',
        claude: { file: '/linux-x64/claude.bin', sha256: 'abc', size: 100 },
      } as any);

      // Mock download to throw
      const downloader = await import('../../downloader/index.js');
      vi.mocked(downloader.download).mockRejectedValue(new Error('CDN blocked'));

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'claude',
        installSubdir,
        artifact: { kind: 'raw', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('解压失败时:本地有已验证版本仍返回 ready', async () => {
    const installSubdir = `extract-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '3.0.0-verified';
    const binaryName = 'claude-test-bin';
    const local = await mountVerifiedBinary(installSubdir, version, binaryName);

    try {
      const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
      vi.mocked(getCachedManifest).mockReturnValue(null as any);
      vi.mocked(fetchManifest).mockResolvedValue({
        version: '3.0.0',
        claudeCode: { file: 'claude/claude-3.0.0.gz', sha256: FAKE_SHA, size: 3 },
      } as any);
      // A successful download followed by invalid gzip exercises the catch path
      // for extraction/verification failures, not just network failures.
      mocks.download.mockImplementation(async (opts: DownloadOpts) => {
        fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
        fs.writeFileSync(opts.targetPath, 'not gzip');
        return {
          path: opts.targetPath,
          size: 8,
          sha256: FAKE_SHA,
          fromCache: false,
          durationMs: 1,
          resumedFromBytes: 0,
        };
      });

      const provisioner = createBinaryProvisioner({
        vendorKey: 'claude',
        manifestField: 'claudeCode',
        installSubdir,
        artifact: { kind: 'gz', binaryName },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(true);
      expect(result.binaryPath).toBe(local.binPath);
    } finally {
      local.cleanup();
    }
  });

  it('可选 runtime 在 manifest 失败时不复用旧版本', async () => {
    const installSubdir = `optional-manifest-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const local = await mountVerifiedBinary(installSubdir, '4.0.0-verified', 'pi');

    try {
      const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
      vi.mocked(getCachedManifest).mockReturnValue(null as any);
      vi.mocked(fetchManifest).mockResolvedValue(null as any);

      const provisioner = createBinaryProvisioner({
        vendorKey: 'pi',
        manifestField: 'pi',
        installSubdir,
        optionalAsset: true,
        artifact: { kind: 'raw', binaryName: 'pi' },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(false);
      expect(result.error).toBe('manifest_failed');
    } finally {
      local.cleanup();
    }
  });

  it('可选 runtime 在下载失败时不复用旧版本', async () => {
    const installSubdir = `optional-download-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const local = await mountVerifiedBinary(installSubdir, '5.0.0-verified', 'pi');

    try {
      const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
      vi.mocked(getCachedManifest).mockReturnValue(null as any);
      vi.mocked(fetchManifest).mockResolvedValue({
        version: '5.0.0',
        pi: { file: 'pi/pi-5.0.0.gz', sha256: FAKE_SHA, size: 3 },
      } as any);
      mocks.download.mockRejectedValue(new Error('CDN blocked'));

      const provisioner = createBinaryProvisioner({
        vendorKey: 'pi',
        manifestField: 'pi',
        installSubdir,
        optionalAsset: true,
        artifact: { kind: 'gz', binaryName: 'pi' },
      });

      const result = await provisioner.prepare();

      expect(result.ready).toBe(false);
      expect(result.error).toBe('unknown');
    } finally {
      local.cleanup();
    }
  });
});
