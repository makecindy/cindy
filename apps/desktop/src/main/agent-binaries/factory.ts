/**
 * apps/desktop/src/main/vendor/binaryProvisioner.ts
 *
 * 通用 BinaryProvisioner 工厂实现。
 * 唯一 export：createBinaryProvisioner(config) → BinaryProvisioner
 *
 * 设计原则：
 * - 所有 vendor 特性（路径、字段名、artifact 类型）通过 BinaryProvisionerConfig 入参传入
 * - 本文件不出现任何 vendor 名称字面量（e.g. <vendor-key>、<vendor-field>）
 * - 通用层不接触 IPC：禁止 BrowserWindow / webContents.send / ipcMain.handle
 * - import { app } from 'electron' 仅用于 app.getPath('userData')
 *
 * 实现参考：apps/desktop/src/main/ccdManager.ts（只读，零修改）
 * decompressGz 内嵌自 ccdManager.ts:97-102（6 行复刻，无 export）
 */

import path from 'node:path';
import fs from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import { extract as extractTar } from 'tar';

import {
  type BinaryProvisioner,
  type BinaryProvisionerConfig,
  type VendorRuntimeState,
} from './types.js';
import { getVendorAsset, resolveVendorAssetUrl, type VendorAsset } from './manifest.js';
import { download, DownloadError, type ProgressEvent } from '../downloader/index.js';
import {
  fetchManifest,
  getCachedManifest,
  getBaseUrl,
  getPlatformKey,
} from '../manifestService.js';

// ── 私有路径 helpers（顶层 function，无 export）─────────────────────────────

function getInstallRoot(installSubdir: string): string {
  const dir = path.join(app.getPath('userData'), installSubdir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getVersionDir(installSubdir: string, version: string): string {
  return path.join(getInstallRoot(installSubdir), version);
}

function getFinalBinPath(installSubdir: string, version: string, binaryName: string): string {
  return path.join(getVersionDir(installSubdir, version), binaryName);
}

function getVerifiedMarker(installSubdir: string, version: string): string {
  return path.join(getVersionDir(installSubdir, version), '.verified');
}

/**
 * Find the latest locally installed and verified version.
 * Scans the install root for directories containing a .verified marker file,
 * then checks that the binary exists and is executable.
 * Returns the binary path if found, null otherwise.
 */
function findLatestVerifiedBinary(
  installSubdir: string,
  binaryName: string,
): { version: string; binaryPath: string } | null {
  try {
    const root = getInstallRoot(installSubdir);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const verified: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        fs.accessSync(getVerifiedMarker(installSubdir, entry.name));
        verified.push(entry.name);
      } catch { /* no .verified marker */ }
    }
    if (verified.length === 0) return null;
    // Sort descending by version string (semver-like: higher = later)
    verified.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of verified) {
      const binPath = getFinalBinPath(installSubdir, v, binaryName);
      try {
        fs.accessSync(binPath, fs.constants.X_OK);
        return { version: v, binaryPath: binPath };
      } catch { /* binary missing or not executable */ }
    }
  } catch { /* install root doesn't exist or unreadable */ }
  return null;
}

function isInstalled(installSubdir: string, version: string, binaryName: string): boolean {
  try {
    fs.accessSync(getFinalBinPath(installSubdir, version, binaryName), fs.constants.X_OK);
    fs.accessSync(getVerifiedMarker(installSubdir, version));
    return true;
  } catch {
    return false;
  }
}

function cleanupOldVersions(installSubdir: string, keepVersion: string): void {
  try {
    const root = getInstallRoot(installSubdir);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keepVersion) {
        try {
          fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ── decompressGz 内嵌实现（复刻 ccdManager.ts:97-102，无 export）────────────

async function decompressGz(srcGz: string, destBin: string): Promise<void> {
  const src = fs.createReadStream(srcGz);
  const dest = fs.createWriteStream(destBin);
  const gunzip = createGunzip();
  await pipeline(src, gunzip, dest);
}

/**
 * 整目录分发解压:tar.gz → destDir。CDN 约定归档根即完整运行时目录(与
 * apps/<vendor>-bin/<platform>/ 同布局,主执行文件在根)。上游 Unix 包习惯把
 * dist 嵌在与主执行文件同名的目录里,这里做与 tools 侧 flattenExtractedDir
 * 一致的容错上移(嵌套目录与主执行文件同名会撞名,先改临时名再逐个上移),
 * 避免发布侧忘记平铺时装出坏目录。解压/上移后主执行文件必须在根,否则抛错。
 */
async function extractTarGzDir(srcTarGz: string, destDir: string, binaryName: string): Promise<void> {
  await extractTar({ file: srcTarGz, cwd: destDir });
  const finalBin = path.join(destDir, binaryName);
  // 注意用 isFile 判定:嵌套壳目录与主执行文件同名(Unix 包习惯),existsSync
  // 会把"同名目录"误判成已就位。
  const isFileAt = (p: string): boolean => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  if (!isFileAt(finalBin)) {
    const nestedName = binaryName.replace(/\.exe$/i, '');
    const nested = path.join(destDir, nestedName);
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      const tmp = path.join(destDir, '.dist-extract-tmp');
      fs.renameSync(nested, tmp);
      for (const name of fs.readdirSync(tmp)) {
        fs.renameSync(path.join(tmp, name), path.join(destDir, name));
      }
      fs.rmdirSync(tmp);
    }
  }
  if (!isFileAt(finalBin)) {
    throw new Error(`dir-dist archive missing main executable: ${binaryName}`);
  }
}

// ── 唯一 export ────────────────────────────────────────────────────────────

export function createBinaryProvisioner(config: BinaryProvisionerConfig): BinaryProvisioner {
  let state: VendorRuntimeState = { status: 'not_installed' };

  function emit(patch: Partial<VendorRuntimeState>, onProgress?: (p: VendorRuntimeState) => void): void {
    state = { ...state, ...patch };
    onProgress?.({ ...state });
  }

  // 取 binary 文件名（gz / raw 直接取 binaryName）
  function deriveBinaryName(): string {
    return config.artifact.binaryName;
  }

  return {
    async getState(): Promise<VendorRuntimeState> {
      return { ...state };
    },

    async prepare(opts) {
      const onProgress = opts?.onProgress;
      try {
        const binaryName = deriveBinaryName();
        // 1. 拉 manifest（不带 dev fallback —— dev mode 归属在 Boss 2 包壳层）
        let manifest = getCachedManifest();
        if (!manifest) manifest = await fetchManifest(undefined, opts?.signal);
        
        // 2. manifest 获取失败时，检查本地已验证版本（离线 fallback）
        if (!manifest) {
          // Optional assets (currently Pi) must remain disabled when the
          // manifest is unavailable; a stale local install may have been
          // withdrawn for this platform/channel and must not be resurrected.
          const local = config.optionalAsset
            ? null
            : findLatestVerifiedBinary(config.installSubdir, binaryName);
          if (local) {
            emit({ status: 'ready', installedVersion: local.version, binaryPath: local.binaryPath }, onProgress);
            return { ready: true, binaryPath: local.binaryPath };
          }
          emit({
            status: 'failed',
            error: { code: 'manifest_failed', message: 'Failed to fetch manifest from CDN' },
          }, onProgress);
          return { ready: false, binaryPath: '', error: 'manifest_failed' };
        }

        // 3. 取 vendor asset
        const asset: VendorAsset | undefined = getVendorAsset(manifest, config.manifestField);
        if (!asset) {
          emit({
            status: 'failed',
            error: {
              code: 'asset_missing',
              message: `manifest field "${config.manifestField}" missing or malformed`,
            },
          }, onProgress);
          return { ready: false, binaryPath: '', error: 'asset_missing' };
        }
        // Reject a manifest asset explicitly scoped to another platform, while
        // keeping compatibility with older manifests whose file path had no
        // platform segment at all.
        const assetPlatform = asset.file.match(/\/(linux-x64|linux-arm64|darwin-arm64|darwin-x64|win32-x64|win32-arm64)\//)?.[1];
        if (assetPlatform && assetPlatform !== getPlatformKey()) {
          emit({
            status: 'failed',
            error: {
              code: 'asset_platform_mismatch',
              message: `manifest field "${config.manifestField}" points to non-${getPlatformKey()} asset`,
            },
          }, onProgress);
          return { ready: false, binaryPath: '', error: 'asset_platform_mismatch' };
        }
        emit({ availableVersion: asset.version }, onProgress);

        // 3. 已安装命中
        const finalBinPath = getFinalBinPath(config.installSubdir, asset.version, binaryName);
        if (isInstalled(config.installSubdir, asset.version, binaryName)) {
          emit({
            status: 'ready',
            installedVersion: asset.version,
            binaryPath: finalBinPath,
          }, onProgress);
          return { ready: true, binaryPath: finalBinPath };
        }

        // 4. 准备目录
        const versionDir = getVersionDir(config.installSubdir, asset.version);
        fs.mkdirSync(versionDir, { recursive: true });

        // 5. 计算下载目标路径（gz 中间文件加 .gz 后缀，tar-gz-dir 落整包归档，
        //    raw 直接落到 binaryName）
        const url = resolveVendorAssetUrl(getBaseUrl(), asset);
        const useGzMid = config.artifact.kind === 'gz' && asset.file.endsWith('.gz');
        const downloadDest = config.artifact.kind === 'tar-gz-dir'
          ? path.join(versionDir, `${binaryName}.dist.tar.gz`)
          : path.join(versionDir, useGzMid ? `${binaryName}.gz` : binaryName);

        // 6. 下载（含 SHA256 校验，由 downloader 内部完成）
        //
        // 注意：这里刻意【不】在 download() 之前 emit 'downloading' 状态——
        // 统一下载器是单槽 (maxConcurrent=1) FIFO 串行的，本任务可能要在队列里
        // 等其它下载（典型：启动时热更 zip 先入队）。提前 emit 会让 splash 在
        // 排队期间显示一根冻结在 0% 的假进度条（2026-07 实测回归），且 fromCache
        // 命中时会闪一次 0→100 的假进度。'downloading' 状态与进度广播完全由
        // 传输层真实的 onProgress 事件驱动（transport 在收到 HTTP response 后
        // 才发首个事件 = 下载真正开始）。
        await download({
          url,
          targetPath: downloadDest,
          sha256: asset.sha256.toLowerCase(),
          expectedSize: asset.size,
          signal: opts?.signal,
          // 可选 Pi 不该在 CDN 故障时做六轮重试拖住启动；一次连接失败就降级，
          // 持续有进度的正常下载仍可在宿主总 deadline 内完成。
          retry: config.optionalAsset ? { maxAttempts: 1 } : undefined,
          onProgress: (e: ProgressEvent) => {
            emit({
              status: 'downloading',
              downloadProgress: {
                received: e.loaded,
                total: e.total ?? asset.size,
                speedBps: e.speedBps,
              },
            }, onProgress);
          },
        });

        // 7. 解压分发
        emit({ status: 'extracting' }, onProgress);
        switch (config.artifact.kind) {
          case 'gz': {
            await decompressGz(downloadDest, finalBinPath);
            try { fs.unlinkSync(downloadDest); } catch { /* ignore */ }
            break;
          }
          case 'tar-gz-dir': {
            await extractTarGzDir(downloadDest, versionDir, binaryName);
            try { fs.unlinkSync(downloadDest); } catch { /* ignore */ }
            break;
          }
          case 'raw':
            throw new Error('NOT_IMPLEMENTED');
        }

        // 8. chmod (unix) + marker
        if (process.platform !== 'win32') {
          try { fs.chmodSync(finalBinPath, 0o755); } catch { /* ignore */ }
        }
        fs.writeFileSync(getVerifiedMarker(config.installSubdir, asset.version), '', 'utf-8');

        // 9. cleanup 旧版本
        cleanupOldVersions(config.installSubdir, asset.version);

        emit({
          status: 'ready',
          installedVersion: asset.version,
          binaryPath: finalBinPath,
          downloadProgress: undefined,
        }, onProgress);
        return { ready: true, binaryPath: finalBinPath };

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // NOT_IMPLEMENTED_* 必须 rethrow（让 Boss 4 / 未来消费者立即感知）
        if (message === 'NOT_IMPLEMENTED_BOSS_4' || message === 'NOT_IMPLEMENTED') {
          emit({
            status: 'failed',
            error: { code: message, message },
          }, opts?.onProgress);
          throw err;
        }
        const code = err instanceof DownloadError ? err.code : 'unknown';
        // P1 fix: download/extract failures should also try local fallback.
        // A proxy that permits manifest URLs but blocks CDN binaries would
        // otherwise leave the user stuck even when a verified local version
        // exists.
        const localFallback = config.optionalAsset
          ? null
          : findLatestVerifiedBinary(config.installSubdir, config.artifact.binaryName);
        if (localFallback) {
          emit({
            status: 'ready',
            installedVersion: localFallback.version,
            binaryPath: localFallback.binaryPath,
          }, opts?.onProgress);
          return { ready: true, binaryPath: localFallback.binaryPath };
        }
        emit({
          status: 'failed',
          error: { code, message },
        }, opts?.onProgress);
        return { ready: false, binaryPath: '', error: code };
      }
    },

    async peekNeedsDownload(): Promise<boolean> {
      // 不发起任何下载——只读 manifest（cache 优先）+ 本地 isInstalled 检查。
      // 任何异常 / manifest 缺失 → 返回 true（保守地走 prepare()，让其内部的完整错误处理接管）。
      // optionalAsset vendor 例外:manifest 有但缺该字段 = 平台没发这个可选资产,
      // 不存在可下载的东西,返回 false(不计入 splash 下载步数;prepare 会以
      // asset_missing 快速失败交调用方降级)。
      try {
        let manifest = getCachedManifest();
        // 可选资产的 peek 只用于 splash 步数提示，不能为了“猜要不要下载”额外
        // 发一次可能卡住启动的网络请求；真正 prepare 会带宿主 deadline 拉清单。
        if (!manifest && config.optionalAsset) return true;
        if (!manifest) manifest = await fetchManifest();
        if (!manifest) return true;
        const asset = getVendorAsset(manifest, config.manifestField);
        if (!asset) return config.optionalAsset !== true;
        return !isInstalled(config.installSubdir, asset.version, deriveBinaryName());
      } catch {
        return true;
      }
    },

    async cleanup(keepVersion: string): Promise<void> {
      cleanupOldVersions(config.installSubdir, keepVersion);
    },
  };
}
