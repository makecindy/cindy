/**
 * StorageManagementCard — 关于页「存储空间」卡片。
 * ---------------------------------------------------------------------------
 * 组成:
 *   1. 占用总览(挂载时异步拉一次;数据在本地,拿到前不渲染 loading 骨架,
 *      规则 7:先拿数据再刷新显示);
 *   2. 两个固定缓存目录:打开目录或经破坏性确认后整目录清理;
 *   3. 媒体总仓清理:扫描(报数)→ 明细确认 → 执行 → 结果。发起扫描/清理时把
 *      composerDraftStore 全部草稿附件 URL 随参带给 main——草稿图是合法的
 *      零引用 blob,main 读不到 renderer 内存,不带就会被当垃圾清掉;
 *   4. 体检(对账):只报不删,异常计数展示,全量清单在 main 日志里。
 *
 * 无瞬态 loading(规则 7):扫描/体检/清理都是本地毫秒级操作,按钮文案与
 * 已显示的结果区块在操作期间保持不动,结果到达才一次性刷新——中间态文案
 * ("扫描中…")曾导致按钮宽度跳 + 区块拆装的闪烁(用户实测反馈)。防重复
 * 点击用 ref 标志,不产生任何视觉变化。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { getAllDraftAttachmentUrls } from '@/lib/composerDraftStore';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

type StatsResult = Awaited<ReturnType<typeof window.electronAPI.cindyMediaStorage.stats>>;
type ScanResult = Awaited<ReturnType<typeof window.electronAPI.cindyMediaStorage.scan>>;
type CleanupResult = Awaited<ReturnType<typeof window.electronAPI.cindyMediaStorage.cleanup>>;
type ReconcileResult = Awaited<ReturnType<typeof window.electronAPI.cindyMediaStorage.reconcile>>;

type CleanPhase =
  | { kind: 'idle' }
  | { kind: 'scanned'; scan: ScanResult }
  | { kind: 'done'; result: CleanupResult };

export function StorageManagementCard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [phase, setPhase] = useState<CleanPhase>({ kind: 'idle' });
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  // in-flight 防重入标志(不进 state:操作期间界面零变化,见文件头)。
  const cleanupBusyRef = useRef(false);
  const reconcileBusyRef = useRef(false);
  const directoryCleanupBusyRef = useRef(false);

  const refreshStats = async () => {
    try {
      const res = await window.electronAPI.cindyMediaStorage.stats();
      setStats(res);
    } catch {
      // 保持上一份显示;错误由具体操作路径提示。
    }
  };

  useEffect(() => {
    void refreshStats();
  }, []);

  const handleOpenLegacyImagesDir = async () => {
    try {
      const result = await window.electronAPI.cindyMediaStorage.openLegacyImagesDir();
      if (!result.opened) toast.info(t('settings.about.storage.legacyImagesDirectoryMissing'));
    } catch {
      toast.error(t('settings.about.storage.legacyImagesOpenFailed'));
    }
  };

  const handleClearLegacyImagesDir = async () => {
    if (directoryCleanupBusyRef.current) return;
    directoryCleanupBusyRef.current = true;
    try {
      const result = await window.electronAPI.cindyMediaStorage.clearLegacyImagesDir();
      if (!result.cleared) return;
      toast.success(t('settings.about.storage.legacyImagesCleared'));
    } catch {
      toast.error(t('settings.about.storage.legacyImagesClearFailed'));
    } finally {
      directoryCleanupBusyRef.current = false;
    }
  };

  const handleOpenChatAttachmentsDir = async () => {
    try {
      const result = await window.electronAPI.cindyMediaStorage.openChatAttachmentsDir();
      if (!result.opened) {
        toast.info(t('settings.about.storage.chatAttachmentsDirectoryMissing'));
      }
    } catch {
      toast.error(t('settings.about.storage.chatAttachmentsOpenFailed'));
    }
  };

  const handleClearChatAttachmentsDir = async () => {
    if (directoryCleanupBusyRef.current) return;
    directoryCleanupBusyRef.current = true;
    try {
      const result = await window.electronAPI.cindyMediaStorage.clearChatAttachmentsDir();
      if (!result.cleared) return;
      toast.success(t('settings.about.storage.chatAttachmentsCleared'));
    } catch {
      toast.error(t('settings.about.storage.chatAttachmentsClearFailed'));
    } finally {
      directoryCleanupBusyRef.current = false;
    }
  };

  const handleScan = async () => {
    if (cleanupBusyRef.current) return;
    cleanupBusyRef.current = true;
    try {
      // 操作期间不切任何 UI 状态:已显示的报告区块保持原样,新结果到达才替换。
      const scan = await window.electronAPI.cindyMediaStorage.scan({
        draftUrls: getAllDraftAttachmentUrls(),
      });
      if (!scan.success) {
        toast.error(scan.error || t('settings.about.storage.scanFailed'));
        return;
      }
      setPhase({ kind: 'scanned', scan });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.storage.scanFailed'));
    } finally {
      cleanupBusyRef.current = false;
    }
  };

  const handleCleanup = async (scan: ScanResult) => {
    if (cleanupBusyRef.current) return;
    cleanupBusyRef.current = true;
    try {
      const result = await window.electronAPI.cindyMediaStorage.cleanup({
        draftUrls: getAllDraftAttachmentUrls(),
        zeroRefHashes: scan.zeroRef.hashes,
        evictCacheHashes: scan.cache.evictable.map((e) => e.hash),
        deadDirNames: scan.deadDirs.filter((d) => d.eligible).map((d) => d.name),
        cleanTmpFiles: scan.tmpFileCount > 0,
      });
      setPhase({ kind: 'done', result });
      toast.success(
        t('settings.about.storage.cleanupDoneToast', { size: formatBytes(result.freedBytes) }),
      );
      void refreshStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.storage.cleanupFailed'));
    } finally {
      cleanupBusyRef.current = false;
    }
  };

  const handleReconcile = async () => {
    if (reconcileBusyRef.current) return;
    reconcileBusyRef.current = true;
    try {
      const res = await window.electronAPI.cindyMediaStorage.reconcile();
      if (!res.success) {
        toast.error(res.error || t('settings.about.storage.reconcileFailed'));
        return;
      }
      setReconcile(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.storage.reconcileFailed'));
    } finally {
      reconcileBusyRef.current = false;
    }
  };

  const cleanableBytes = (scan: ScanResult): number =>
    scan.zeroRef.bytes +
    scan.cache.evictable.reduce((sum, e) => sum + e.bytes, 0) +
    scan.deadDirs.filter((d) => d.eligible).reduce((sum, d) => sum + d.bytes, 0);

  const hasCleanable = (scan: ScanResult): boolean =>
    scan.zeroRef.count > 0 ||
    scan.cache.evictable.length > 0 ||
    scan.deadDirs.some((d) => d.eligible) ||
    scan.tmpFileCount > 0;

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      {/* 占用总览 */}
      <div className="flex flex-col gap-1.5 px-[18px] py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.usageLabel')}
          </span>
          <span
            className={cn(
              'truncate text-13 font-medium',
              stats && !stats.success
                ? 'text-[var(--settings-section-sublabel)] opacity-70'
                : 'text-[var(--settings-section-title)]',
            )}
          >
            {stats
              ? stats.success
                ? t('settings.about.storage.usageValue', {
                    size: formatBytes(stats.blobs.totalBytes),
                    count: stats.blobs.totalCount,
                    cacheSize: formatBytes(stats.blobs.cacheBytes),
                  })
                : t('settings.about.storage.statsFailed')
              : ''}
          </span>
        </div>
      </div>

      <Divider />

      <div className="flex items-center justify-between gap-3 px-[18px] py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.legacyImagesLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.storage.legacyImagesDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CardButton onClick={handleOpenLegacyImagesDir}>
            {t('settings.about.storage.legacyImagesOpenButton')}
          </CardButton>
          <CardButton onClick={handleClearLegacyImagesDir}>
            {t('settings.about.storage.legacyImagesClearButton')}
          </CardButton>
        </div>
      </div>

      <Divider />

      <div className="flex items-center justify-between gap-3 px-[18px] py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.chatAttachmentsLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.storage.chatAttachmentsDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CardButton onClick={handleOpenChatAttachmentsDir}>
            {t('settings.about.storage.chatAttachmentsOpenButton')}
          </CardButton>
          <CardButton onClick={handleClearChatAttachmentsDir}>
            {t('settings.about.storage.chatAttachmentsClearButton')}
          </CardButton>
        </div>
      </div>

      <Divider />

      {/* 清理:扫描 → 报数确认 → 执行 → 结果 */}
      <div className="flex flex-col gap-2 px-[18px] py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-13 text-[var(--settings-section-sublabel)]">
              {t('settings.about.storage.cleanupLabel')}
            </span>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.about.storage.cleanupDescription')}
            </p>
          </div>
          <CardButton onClick={handleScan}>
            {t('settings.about.storage.scanButton')}
          </CardButton>
        </div>

        {phase.kind === 'scanned' && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5">
            {hasCleanable(phase.scan) ? (
              <>
                <ReportLine
                  visible={phase.scan.zeroRef.count > 0}
                  text={t('settings.about.storage.reportZeroRef', {
                    count: phase.scan.zeroRef.count,
                    size: formatBytes(phase.scan.zeroRef.bytes),
                  })}
                />
                <ReportLine
                  visible={phase.scan.zeroRef.protectedCount > 0}
                  text={t('settings.about.storage.reportProtected', {
                    count: phase.scan.zeroRef.protectedCount,
                  })}
                />
                <ReportLine
                  visible={phase.scan.cache.evictable.length > 0}
                  text={t('settings.about.storage.reportCache', {
                    size: formatBytes(
                      phase.scan.cache.evictable.reduce((sum, e) => sum + e.bytes, 0),
                    ),
                    total: formatBytes(phase.scan.cache.totalBytes),
                    limit: formatBytes(phase.scan.cache.limitBytes),
                  })}
                />
                <ReportLine
                  visible={phase.scan.deadDirs.some((d) => d.eligible)}
                  text={t('settings.about.storage.reportDeadDirs', {
                    size: formatBytes(
                      phase.scan.deadDirs
                        .filter((d) => d.eligible)
                        .reduce((sum, d) => sum + d.bytes, 0),
                    ),
                  })}
                />
                <ReportLine
                  visible={phase.scan.tmpFileCount > 0}
                  text={t('settings.about.storage.reportTmpFiles', {
                    count: phase.scan.tmpFileCount,
                  })}
                />
                <div className="mt-1 flex items-center justify-end gap-2">
                  <CardButton onClick={() => setPhase({ kind: 'idle' })}>
                    {t('settings.about.storage.cancelButton')}
                  </CardButton>
                  <CardButton emphasis onClick={() => handleCleanup(phase.scan)}>
                    {cleanableBytes(phase.scan) > 0
                      ? t('settings.about.storage.confirmCleanup', {
                          size: formatBytes(cleanableBytes(phase.scan)),
                        })
                      : t('settings.about.storage.confirmCleanupNoSize')}
                  </CardButton>
                </div>
              </>
            ) : (
              <p className="text-12 text-[var(--settings-section-sublabel)]">
                {t('settings.about.storage.nothingToClean')}
              </p>
            )}
          </div>
        )}

        {phase.kind === 'done' && (
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.cleanupResult', {
              size: formatBytes(phase.result.freedBytes),
              skipped:
                phase.result.zeroRef.skipped +
                phase.result.cacheEvicted.skipped +
                phase.result.deadDirs.skipped.length,
            })}
          </p>
        )}
      </div>

      <Divider />

      {/* 体检(对账,只报不删) */}
      <div className="flex flex-col gap-1.5 px-[18px] py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-13 text-[var(--settings-section-sublabel)]">
              {t('settings.about.storage.reconcileLabel')}
            </span>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.about.storage.reconcileDescription')}
            </p>
          </div>
          <CardButton onClick={handleReconcile}>
            {t('settings.about.storage.reconcileButton')}
          </CardButton>
        </div>
        {reconcile && (
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)]">
            {reconcile.orphanCount === 0 && reconcile.missingCount === 0 && reconcile.strayCount === 0
              ? t('settings.about.storage.reconcileHealthy')
              : t('settings.about.storage.reconcileIssues', {
                  orphans: reconcile.orphanCount,
                  orphanSize: formatBytes(reconcile.orphanBytes),
                  missing: reconcile.missingCount,
                  stray: reconcile.strayCount,
                })}
          </p>
        )}
      </div>
    </div>
  );
}

function ReportLine({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null;
  return <p className="text-12 leading-[1.5] text-[var(--settings-section-sublabel)]">{text}</p>;
}

function CardButton({
  children,
  onClick,
  emphasis = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full px-2.5 py-1 text-12 font-medium transition-colors',
        'border border-[var(--settings-theme-card-border)]',
        emphasis
          ? 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] border-transparent hover:opacity-90'
          : 'text-[var(--settings-section-title)] hover:bg-[var(--settings-theme-card-border)]/40',
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      className="h-px w-full"
      style={{ background: 'var(--settings-theme-card-border)' }}
    />
  );
}
