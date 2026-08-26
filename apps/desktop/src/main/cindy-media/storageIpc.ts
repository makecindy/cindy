/**
 * storageIpc.ts — 存储空间卡片(关于页)的 IPC 业务体。
 * ---------------------------------------------------------------------------
 * 依赖全部注入(规则 14):Electron 接线在 bootstrap-electron.ts 只做
 * ipcMain.handle 适配,测试用内存 harness 直接调 handler body。
 *
 * 交互契约:
 *   - 两个固定缓存目录只允许打开或整目录清理;清理前由 main 原生对话框做破坏性确认,
 *     main 不接受路径,也不读取消息数据库或媒体账本;
 *   - stats:占用总览(账面统计 + 死目录；不在设置页挂载时遍历历史图片目录);
 *   - scan:清理预检——renderer 随参带草稿附件 URL(§4 暂存区 (1)),这里
 *     叠加内存队列 (2) 与崩溃快照 (3) 组成活引用集,产出各类可清理项报数;
 *   - cleanup:执行清理——只认 scan 返回并经用户确认的指纹/目录清单,执行
 *     时活引用集重新取证、每项条件复查(见 recycler.ts);
 *   - reconcile:对账体检,只报不删。
 *
 * stats / scan / reconcile 是查询型,失败返回 { success:false } + 空数据
 * (规则 13 例外:renderer 需要 fallback 才能渲染空态);cleanup 是动作型,
 * 意外失败 throwIpcError('INTERNAL')。
 */

import { createLogger } from '../logger';
import { throwIpcError } from '../utils/ipcValidate';
import * as blobStore from './blobStore';
import * as ledger from './ledger';
import * as recycler from './recycler';
import * as legacyDeadDirs from './legacyDeadDirs';
import type { LiveHashSources } from './recycler';

const log = createLogger('cindy-media-storage-ipc');

export interface StorageIpcDeps {
  /** main 内存排队/在途消息取证(register.ts 的 coordinator holder)。 */
  getQueueScanTexts: () => string[];
  /** 崩溃恢复快照表全量 payload。 */
  loadSnapshotPayloads: () => Promise<string[]>;
  /**
   * 全窗口草稿附件 URL 登记表(draftUrlRegistry;review P1:多窗口时发起
   * 清理的窗口只能带上自己的草稿,其它窗口的靠这份并集豁免)。
   */
  getRegisteredDraftUrls?: () => string[];
  /** 测试注入内存账本;生产缺省走 DbClient。 */
  db?: ledger.LedgerDb;
  /** 测试注入死目录根;生产缺省 userData/cc-agent。 */
  legacyRootDir?: string;
  /** Fixed-purpose directory opener. It returns false when the legacy directory is absent. */
  openLegacyImagesDir?: () => Promise<boolean>;
  /** Delete only the fixed legacy image cache directory; no ledger or message lookup. */
  clearLegacyImagesDir?: () => Promise<void>;
  /** Fixed-purpose directory opener for the active owner's staged chat attachments. */
  openChatAttachmentsDir?: () => Promise<boolean>;
  /** Delete only the active owner's staged attachment root; no ledger or message lookup. */
  clearChatAttachmentsDir?: () => Promise<void>;
}

export interface StorageStatsResult {
  success: boolean;
  error?: string;
  blobs: ledger.MediaStorageStats;
  legacy: { bytes: number; fileCount: number };
  deadDirs: legacyDeadDirs.DeadDirStatus[];
}

export interface StorageScanParams {
  /** renderer 收集的全部会话草稿附件 URL(活引用暂存区 (1))。 */
  draftUrls: string[];
}

export interface StorageScanResult {
  success: boolean;
  error?: string;
  zeroRef: recycler.ZeroRefScan;
  cache: recycler.CacheScan;
  tmpFileCount: number;
  deadDirs: legacyDeadDirs.DeadDirStatus[];
}

export interface StorageCleanupParams {
  draftUrls: string[];
  /** scan 给出、用户确认的零引用候选指纹。 */
  zeroRefHashes: string[];
  /** scan 给出、用户确认的 cache 逐出指纹。 */
  evictCacheHashes: string[];
  /** 用户确认清退的死目录名。 */
  deadDirNames: string[];
  cleanTmpFiles: boolean;
}

export interface StorageCleanupResult {
  zeroRef: recycler.DeleteResult;
  cacheEvicted: recycler.DeleteResult;
  deadDirs: legacyDeadDirs.DeadDirCleanResult;
  tmpFilesRemoved: number;
  freedBytes: number;
}

export interface StorageReconcileResult {
  success: boolean;
  error?: string;
  orphanCount: number;
  orphanBytes: number;
  missingCount: number;
  strayCount: number;
  tmpFileCount: number;
  /** 前若干条样例路径/指纹,给人看的线索(全量进日志)。 */
  orphanSamples: string[];
  missingSamples: string[];
}

const EMPTY_STATS: ledger.MediaStorageStats = {
  totalCount: 0,
  totalBytes: 0,
  cacheCount: 0,
  cacheBytes: 0,
};

const EMPTY_ZERO_REF: recycler.ZeroRefScan = { count: 0, bytes: 0, hashes: [], protectedCount: 0 };

const EMPTY_CACHE: recycler.CacheScan = {
  totalBytes: 0,
  count: 0,
  limitBytes: recycler.CACHE_LIMIT_BYTES,
  excessBytes: 0,
  evictable: [],
};

/** 三个暂存区的活引用集(scan 与 cleanup 各取证一次,cleanup 不复用 scan 的旧集)。 */
async function collectLive(deps: StorageIpcDeps, draftUrls: string[]): Promise<Set<string>> {
  const sources: LiveHashSources = {
    // 发起窗口随参带的 + 全窗口登记表的并集(多窗口草稿全豁免)。
    draftUrls: [...draftUrls, ...(deps.getRegisteredDraftUrls?.() ?? [])],
    inMemoryQueueTexts: deps.getQueueScanTexts,
    snapshotPayloads: deps.loadSnapshotPayloads,
  };
  return recycler.collectLiveHashes(sources);
}

export function createStorageIpcHandlers(deps: StorageIpcDeps) {
  return {
    async openLegacyImagesDir(): Promise<{ opened: boolean }> {
      if (!deps.openLegacyImagesDir) {
        throwIpcError('INTERNAL', 'legacy image directory opener is unavailable');
      }
      try {
        return { opened: await deps.openLegacyImagesDir() };
      } catch (err) {
        log.warn('open legacy image directory failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to open legacy image directory');
      }
    },

    async clearLegacyImagesDir(): Promise<void> {
      if (!deps.clearLegacyImagesDir) {
        throwIpcError('INTERNAL', 'legacy image directory cleaner is unavailable');
      }
      try {
        await deps.clearLegacyImagesDir();
      } catch (err) {
        log.warn('clear legacy image directory failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to clear legacy image directory');
      }
    },

    async openChatAttachmentsDir(): Promise<{ opened: boolean }> {
      if (!deps.openChatAttachmentsDir) {
        throwIpcError('INTERNAL', 'chat attachment directory opener is unavailable');
      }
      try {
        return { opened: await deps.openChatAttachmentsDir() };
      } catch (err) {
        log.warn('open chat attachment directory failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to open chat attachment directory');
      }
    },

    async clearChatAttachmentsDir(): Promise<void> {
      if (!deps.clearChatAttachmentsDir) {
        throwIpcError('INTERNAL', 'chat attachment directory cleaner is unavailable');
      }
      try {
        await deps.clearChatAttachmentsDir();
      } catch (err) {
        log.warn('clear chat attachment directory failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to clear chat attachment directory');
      }
    },

    async stats(): Promise<StorageStatsResult> {
      try {
        const [blobs, deadDirs] = await Promise.all([
          ledger.getStorageStats(deps.db),
          legacyDeadDirs.scanDeadDirs(deps.legacyRootDir),
        ]);
        // The legacy root can contain many image sidecars. Do not walk it when the
        // settings page mounts; users manage that fixed directory outside Cindy.
        return { success: true, blobs, legacy: { bytes: 0, fileCount: 0 }, deadDirs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('storage stats failed', { error: message });
        return {
          success: false,
          error: message,
          blobs: EMPTY_STATS,
          legacy: { bytes: 0, fileCount: 0 },
          deadDirs: [],
        };
      }
    },

    async scan(params: StorageScanParams): Promise<StorageScanResult> {
      try {
        const live = await collectLive(deps, params?.draftUrls ?? []);
        const [zeroRef, cache, staleTmp, deadDirs] = await Promise.all([
          recycler.scanZeroRef({ live }, deps.db),
          recycler.scanCache({ live }, deps.db),
          // 报数与清理同口径:只算超龄残留,不吓唬用户也不出现"清理 0 项"。
          blobStore.listStaleTmpFiles(recycler.TMP_FILE_MAX_AGE_MS),
          legacyDeadDirs.scanDeadDirs(deps.legacyRootDir),
        ]);
        // 零引用的 cache blob 会同时进两条候选线(正常情况下 integration-cache
        // 索引行保证 cache blob 非零引用,几乎不发生)——从逐出线去重,避免
        // 确认按钮上字节双算、执行时第二遍白跑。
        const zeroRefSet = new Set(zeroRef.hashes);
        const cacheDeduped: recycler.CacheScan = {
          ...cache,
          evictable: cache.evictable.filter((e) => !zeroRefSet.has(e.hash)),
        };
        return {
          success: true,
          zeroRef,
          cache: cacheDeduped,
          tmpFileCount: staleTmp.length,
          deadDirs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('storage scan failed', { error: message });
        return {
          success: false,
          error: message,
          zeroRef: EMPTY_ZERO_REF,
          cache: EMPTY_CACHE,
          tmpFileCount: 0,
          deadDirs: [],
        };
      }
    },

    async cleanup(params: StorageCleanupParams): Promise<StorageCleanupResult> {
      if (!params || typeof params !== 'object') {
        throwIpcError('INVALID_PARAMS', 'cindy-media storage cleanup: params required');
      }
      try {
        // 执行时重新取证:扫描→确认之间用户可能又粘了图/发了排队消息。
        const live = await collectLive(deps, params.draftUrls ?? []);
        const zeroRef = await recycler.deleteZeroRefBlobs(
          { hashes: params.zeroRefHashes ?? [], live },
          deps.db,
        );
        const cacheEvicted = await recycler.evictCacheBlobs(
          { hashes: params.evictCacheHashes ?? [], live },
          deps.db,
        );
        const deadDirs = await legacyDeadDirs.cleanDeadDirs(
          params.deadDirNames ?? [],
          deps.legacyRootDir,
        );
        const tmpFilesRemoved = params.cleanTmpFiles
          ? await blobStore.cleanupTmpFiles(recycler.TMP_FILE_MAX_AGE_MS)
          : 0;
        const result: StorageCleanupResult = {
          zeroRef,
          cacheEvicted,
          deadDirs,
          tmpFilesRemoved,
          freedBytes: zeroRef.freedBytes + cacheEvicted.freedBytes + deadDirs.freedBytes,
        };
        log.info('storage cleanup done', {
          zeroRefDeleted: zeroRef.deleted,
          zeroRefSkipped: zeroRef.skipped,
          cacheEvicted: cacheEvicted.deleted,
          deadDirsRemoved: deadDirs.removed,
          tmpFilesRemoved,
          freedBytes: result.freedBytes,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('storage cleanup failed', { error: message });
        throwIpcError('INTERNAL', `storage cleanup failed: ${message}`);
      }
    },

    async reconcile(): Promise<StorageReconcileResult> {
      try {
        const report = await recycler.reconcile(deps.db);
        // 全量清单进日志(人工处置的依据);IPC 只回样例与计数,避免大 payload。
        if (report.orphanFiles.length || report.missingFiles.length || report.strayPaths.length) {
          log.warn('reconcile found inconsistencies', {
            orphans: report.orphanFiles.map((o) => o.absPath),
            missing: report.missingFiles.map((m) => `${m.hash}${m.ext}`),
            stray: report.strayPaths,
          });
        }
        return {
          success: true,
          orphanCount: report.orphanFiles.length,
          orphanBytes: report.orphanFiles.reduce((sum, o) => sum + o.bytes, 0),
          missingCount: report.missingFiles.length,
          strayCount: report.strayPaths.length,
          tmpFileCount: report.tmpFileCount,
          orphanSamples: report.orphanFiles.slice(0, 5).map((o) => o.absPath),
          missingSamples: report.missingFiles.slice(0, 5).map((m) => `${m.hash}${m.ext}`),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('reconcile failed', { error: message });
        return {
          success: false,
          error: message,
          orphanCount: 0,
          orphanBytes: 0,
          missingCount: 0,
          strayCount: 0,
          tmpFileCount: 0,
          orphanSamples: [],
          missingSamples: [],
        };
      }
    },
  };
}
