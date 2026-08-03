/**
 * factory.ts tar-gz-dir(整目录分发,pi 形态)回归。
 *
 * 覆盖:
 *  - CDN 约定布局(归档根即完整 dist):解压后主执行文件 + 旁侧资产就位,
 *    写 .verified,归档中间文件被清理;
 *  - 上游 Unix 包嵌套布局(dist 包在与主执行文件同名的目录里):容错上移;
 *  - 归档缺主执行文件:prepare 失败,不写 .verified;
 *  - optionalAsset:manifest 缺字段时 peekNeedsDownload 返回 false(可选资产
 *    不计入 splash 下载步数),非 optional 保持保守 true。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';

import type { VendorAsset } from '../manifest.js';

const FAKE_SHA = 'b'.repeat(64);

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  fetchManifest: vi.fn(async () => ({ app: {} })),
  cachedManifest: { current: { app: {} } as { app: Record<string, never> } | null },
  // 每个用例把要打包进 tar.gz 的源目录塞进来,download mock 现打包成归档落盘。
  archiveState: { srcDir: '' },
  asset: {
    current: {
      version: '9.9.9-test',
      file: 'pi/9.9.9-test/darwin-arm64/pi.dist.tar.gz',
      sha256: 'b'.repeat(64),
      size: 128,
    } as VendorAsset | undefined,
  },
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

vi.mock('../../manifestService.js', () => ({
  fetchManifest: mocks.fetchManifest,
  getCachedManifest: vi.fn(() => mocks.cachedManifest.current),
  getBaseUrl: () => 'https://cdn.test',
  getPlatformKey: () => 'darwin-arm64',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => mocks.asset.current,
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

const BIN_NAME = 'pi-test-bin';

interface DownloadOpts { targetPath: string; signal?: AbortSignal }

/** download mock 成功实现:把 archiveState.srcDir 打成真实 tar.gz 落到 targetPath。 */
async function fulfillDownloadWithTarGz(opts: DownloadOpts) {
  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
  await createTar(
    { gzip: true, file: opts.targetPath, cwd: mocks.archiveState.srcDir },
    fs.readdirSync(mocks.archiveState.srcDir),
  );
  return {
    path: opts.targetPath,
    size: fs.statSync(opts.targetPath).size,
    sha256: FAKE_SHA,
    fromCache: false,
    durationMs: 1,
    resumedFromBytes: 0,
  };
}

function makeProvisioner(overrides?: { optionalAsset?: boolean }) {
  return createBinaryProvisioner({
    vendorKey: 'pi',
    manifestField: 'pi',
    installSubdir: `dir-dist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    artifact: { kind: 'tar-gz-dir', binaryName: BIN_NAME },
    ...overrides,
  });
}

/** 造一个临时源目录;layout 'flat' = dist 平铺在根, 'nested' = 包在同名子目录里。 */
function stageDist(layout: 'flat' | 'nested', withBinary = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dist-src-'));
  const distDir = layout === 'flat' ? root : path.join(root, BIN_NAME);
  fs.mkdirSync(path.join(distDir, 'theme'), { recursive: true });
  if (withBinary) {
    fs.writeFileSync(path.join(distDir, BIN_NAME), '#!/bin/sh\necho pi\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(distDir, 'theme', 'dark.json'), '{}');
  return root;
}

beforeEach(() => {
  mocks.download.mockReset();
  mocks.fetchManifest.mockReset();
  mocks.fetchManifest.mockResolvedValue({ app: {} });
  mocks.cachedManifest.current = { app: {} };
  mocks.asset.current = {
    version: '9.9.9-test',
    file: 'pi/9.9.9-test/darwin-arm64/pi.dist.tar.gz',
    sha256: FAKE_SHA,
    size: 128,
  };
});

describe('createBinaryProvisioner tar-gz-dir', () => {
  it('平铺归档:解压出完整目录、写 .verified、清理归档中间文件', async () => {
    mocks.archiveState.srcDir = stageDist('flat');
    mocks.download.mockImplementation(fulfillDownloadWithTarGz);

    const p = makeProvisioner();
    const result = await p.prepare();

    expect(result.ready).toBe(true);
    expect(path.basename(result.binaryPath)).toBe(BIN_NAME);
    const versionDir = path.dirname(result.binaryPath);
    expect(fs.existsSync(result.binaryPath)).toBe(true);
    expect(fs.existsSync(path.join(versionDir, 'theme', 'dark.json'))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, '.verified'))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, `${BIN_NAME}.dist.tar.gz`))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.binaryPath).mode & 0o111).not.toBe(0);
    }
  });

  it('嵌套归档(上游 Unix 布局):内容上移到版本目录根', async () => {
    mocks.archiveState.srcDir = stageDist('nested');
    mocks.download.mockImplementation(fulfillDownloadWithTarGz);

    const p = makeProvisioner();
    const result = await p.prepare();

    expect(result.ready).toBe(true);
    const versionDir = path.dirname(result.binaryPath);
    expect(fs.statSync(result.binaryPath).isFile()).toBe(true);
    expect(fs.existsSync(path.join(versionDir, 'theme', 'dark.json'))).toBe(true);
    // 嵌套壳目录不残留
    expect(fs.existsSync(path.join(versionDir, '.dist-extract-tmp'))).toBe(false);
  });

  it('归档缺主执行文件:失败且不写 .verified', async () => {
    mocks.archiveState.srcDir = stageDist('flat', false);
    mocks.download.mockImplementation(fulfillDownloadWithTarGz);

    const p = makeProvisioner();
    const result = await p.prepare();

    expect(result.ready).toBe(false);
    const state = await p.getState();
    expect(state.status).toBe('failed');
  });

  it('拒绝 win32-arm64 资产被错误地用于当前平台', async () => {
    mocks.asset.current = {
      version: '9.9.9-test',
      file: 'pi/9.9.9-test/win32-arm64/pi.dist.tar.gz',
      sha256: FAKE_SHA,
      size: 128,
    };

    const result = await makeProvisioner({ optionalAsset: true }).prepare();

    expect(result).toEqual({ ready: false, binaryPath: '', error: 'asset_platform_mismatch' });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('二次 prepare 命中已安装版本,不再下载', async () => {
    mocks.archiveState.srcDir = stageDist('flat');
    mocks.download.mockImplementation(fulfillDownloadWithTarGz);

    const p = makeProvisioner();
    const first = await p.prepare();
    expect(first.ready).toBe(true);
    expect(mocks.download).toHaveBeenCalledTimes(1);

    const second = await p.prepare();
    expect(second.ready).toBe(true);
    expect(second.binaryPath).toBe(first.binaryPath);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it('把宿主的启动取消信号传给统一下载器', async () => {
    mocks.archiveState.srcDir = stageDist('flat');
    mocks.download.mockImplementation(fulfillDownloadWithTarGz);
    const controller = new AbortController();

    mocks.cachedManifest.current = null;
    const result = await makeProvisioner({ optionalAsset: true }).prepare({
      signal: controller.signal,
    });

    expect(result.ready).toBe(true);
    expect(mocks.fetchManifest).toHaveBeenCalledWith(undefined, controller.signal);
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        retry: { maxAttempts: 1 },
      }),
    );
  });

  it('optionalAsset: manifest 缺字段 → peekNeedsDownload false;非 optional 保守 true', async () => {
    mocks.asset.current = undefined;
    expect(await makeProvisioner({ optionalAsset: true }).peekNeedsDownload()).toBe(false);
    expect(await makeProvisioner().peekNeedsDownload()).toBe(true);
  });
});
