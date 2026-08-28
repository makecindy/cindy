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

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Select from '@radix-ui/react-select';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { getAllDraftAttachmentUrls } from '@/lib/composerDraftStore';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DB_SLIMMING_ARCHIVE_AGE_OPTIONS,
  DB_SLIMMING_DEFAULT_ARCHIVE_AGE,
  type DbSlimmingArchiveAge,
  type DbSlimmingBackupDirectorySelection,
  type DbSlimmingResult,
  type DbSlimmingScanResult,
} from '../../../shared/localDbMaintenance';

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

      <DatabaseSlimmingSection />

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

type DbSlimmingPhase =
  | { kind: 'idle' }
  | { kind: 'scanned'; scan: DbSlimmingScanResult }
  | { kind: 'done'; result: DbSlimmingResult };

function DatabaseSlimmingSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [archiveAge, setArchiveAge] = useState<DbSlimmingArchiveAge>(
    DB_SLIMMING_DEFAULT_ARCHIVE_AGE,
  );
  const [includeActiveTasks, setIncludeActiveTasks] = useState(false);
  const [backupEnabled, setBackupEnabled] = useState(true);
  const [backupDirectory, setBackupDirectory] =
    useState<DbSlimmingBackupDirectorySelection>({ selected: false });
  const [phase, setPhase] = useState<DbSlimmingPhase>({ kind: 'idle' });
  const [scanLoading, setScanLoading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [executionLocked, setExecutionLocked] = useState(false);
  const busyRef = useRef(false);
  const activeTasksConfirmationPendingRef = useRef(false);
  const interactionLockReleaseRef = useRef<(() => void) | null>(null);

  const acquireInteractionLock = () => {
    if (!interactionLockReleaseRef.current) {
      interactionLockReleaseRef.current = acquireAppInteractionLock();
    }
  };

  const releaseInteractionLock = () => {
    interactionLockReleaseRef.current?.();
    interactionLockReleaseRef.current = null;
  };

  useEffect(() => {
    return () => {
      interactionLockReleaseRef.current?.();
      interactionLockReleaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.localDb.maintenance.getLastResult().then(
      (result) => {
        if (!cancelled && result) setPhase({ kind: 'done', result });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const invalidateScan = () => {
    setReportOpen(false);
    releaseInteractionLock();
    setPhase((current) => (current.kind === 'scanned' ? { kind: 'idle' } : current));
  };

  const handleArchiveAgeChange = (raw: string) => {
    const parsed = raw === '7-days' ? raw : Number(raw);
    if (!DB_SLIMMING_ARCHIVE_AGE_OPTIONS.includes(parsed as DbSlimmingArchiveAge)) return;
    setArchiveAge(parsed as DbSlimmingArchiveAge);
    invalidateScan();
  };

  const handleIncludeActiveTasksChange = async (checked: boolean) => {
    if (!checked) {
      setIncludeActiveTasks(false);
      invalidateScan();
      return;
    }
    if (busyRef.current || scanLoading || activeTasksConfirmationPendingRef.current) return;
    activeTasksConfirmationPendingRef.current = true;
    let accepted = false;
    try {
      accepted = await confirm({
        title: t('settings.about.storage.dbSlimmingIncludeActiveConfirmTitle'),
        description: t('settings.about.storage.dbSlimmingIncludeActiveConfirmDescription'),
        confirmText: t('settings.about.storage.dbSlimmingIncludeActiveConfirmButton'),
        cancelText: t('settings.about.storage.dbSlimmingIncludeActiveCancelButton'),
        autoFocusConfirm: true,
      });
    } finally {
      activeTasksConfirmationPendingRef.current = false;
    }
    if (!accepted) return;
    setIncludeActiveTasks(true);
    invalidateScan();
  };

  const handleChooseBackupDirectory = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const selection = await window.electronAPI.localDb.maintenance.chooseBackupDirectory();
      if (selection.selected) setBackupDirectory(selection);
    } catch {
      toast.error(t('settings.about.storage.dbSlimmingBackupDirectoryFailed'));
    } finally {
      busyRef.current = false;
    }
  };

  const handleScan = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    acquireInteractionLock();
    setReportOpen(false);
    setScanLoading(true);
    let completed = false;
    try {
      const scan = await window.electronAPI.localDb.maintenance.scan({
        archiveAgeMonths: archiveAge,
        includeActiveTasks,
      });
      setPhase({ kind: 'scanned', scan });
      setReportOpen(true);
      completed = true;
    } catch (error) {
      toast.error(
        t(
          mapIpcErrorToI18nKey(error, {
            fallback: 'settings.about.storage.dbSlimmingScanFailed',
          }),
        ),
      );
    } finally {
      busyRef.current = false;
      if (!completed) releaseInteractionLock();
      setScanLoading(false);
    }
  };

  const handleSchedule = async () => {
    if (phase.kind !== 'scanned' || busyRef.current || executionLocked) return;
    busyRef.current = true;
    acquireInteractionLock();
    setReportOpen(false);
    setExecutionLocked(true);
    try {
      const result = await window.electronAPI.localDb.maintenance.schedule({
        scanId: phase.scan.scanId,
        backupEnabled,
        ...(backupEnabled && backupDirectory.grantId
          ? { backupDirectoryGrantId: backupDirectory.grantId }
          : {}),
      });
      if (!result.scheduled) {
        busyRef.current = false;
        setExecutionLocked(false);
        setReportOpen(true);
      }
    } catch (error) {
      busyRef.current = false;
      setExecutionLocked(false);
      setReportOpen(true);
      toast.error(
        t(
          mapIpcErrorToI18nKey(error, {
            fallback: 'settings.about.storage.dbSlimmingScheduleFailed',
          }),
        ),
      );
    }
  };

  const handleReportOpenChange = (open: boolean) => {
    setReportOpen(open);
    if (!open) releaseInteractionLock();
  };

  const handleOpenBackup = async () => {
    try {
      const result = await window.electronAPI.localDb.maintenance.openLastBackupDirectory();
      if (!result.opened) toast.info(t('settings.about.storage.dbSlimmingBackupMissing'));
    } catch {
      toast.error(t('settings.about.storage.dbSlimmingBackupOpenFailed'));
    }
  };

  const scanned = phase.kind === 'scanned' ? phase.scan : null;
  const insufficientSpace = Boolean(
    scanned &&
      scanned.databaseVolumeFreeBytes !== null &&
      scanned.databaseVolumeFreeBytes < scanned.temporaryBytesRequired,
  );

  return (
    <div className="flex flex-col gap-3 px-[18px] py-4" aria-busy={scanLoading}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.dbSlimmingLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.storage.dbSlimmingDescription')}
          </p>
        </div>
        <CardButton onClick={handleScan} disabled={scanLoading} busy={scanLoading}>
          {scanLoading && <Spinner size={12} />}
          {t('settings.about.storage.dbSlimmingScanButton')}
        </CardButton>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5">
        <label
          htmlFor="db-slimming-archive-age"
          className="text-12 text-[var(--settings-section-sublabel)]"
        >
          {t('settings.about.storage.dbSlimmingArchiveAgeLabel')}
        </label>
        <div className="flex items-center">
          <Select.Root
            value={String(archiveAge)}
            onValueChange={handleArchiveAgeChange}
            disabled={scanLoading}
          >
            <Select.Trigger
              id="db-slimming-archive-age"
              aria-label={t('settings.about.storage.dbSlimmingArchiveAgeLabel')}
              className={cn(
                'flex h-8 min-w-[104px] items-center justify-between gap-2 rounded-full border px-3 text-12 outline-none transition-colors',
                'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <Select.Value />
              <Select.Icon asChild>
                <ChevronDown
                  size={13}
                  className="shrink-0 text-[var(--settings-eye-icon)]"
                  aria-hidden="true"
                />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                side="bottom"
                align="end"
                sideOffset={6}
                className={cn(
                  'z-[10010] min-w-[var(--radix-select-trigger-width)] rounded-xl p-1.5',
                  'border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)] shadow-[var(--shadow-menu)]',
                )}
              >
                <Select.Viewport className="flex flex-col gap-0.5">
                  {DB_SLIMMING_ARCHIVE_AGE_OPTIONS.map((age) => (
                    <Select.Item
                      key={age}
                      value={String(age)}
                      className={cn(
                        'flex h-8 cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2.5 text-12 outline-none transition-colors',
                        'text-[var(--settings-input-text)] data-[highlighted]:bg-[var(--settings-menu-bg-hover)]',
                        'data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]',
                      )}
                    >
                      <Select.ItemText>
                        {t(
                          age === '7-days'
                            ? 'settings.about.storage.dbSlimmingArchiveAgeOption7Days'
                            : `settings.about.storage.dbSlimmingArchiveAgeOption${age}`,
                        )}
                      </Select.ItemText>
                      <Select.ItemIndicator>
                        <Check
                          size={14}
                          className="shrink-0 text-[var(--settings-theme-icon-active)]"
                        />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>

        <label
          htmlFor="db-slimming-include-active"
          className="flex min-w-0 cursor-pointer flex-col gap-0.5"
        >
          <span className="text-12 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.dbSlimmingIncludeActiveLabel')}
          </span>
          <span className="text-11 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.storage.dbSlimmingIncludeActiveDescription')}
          </span>
        </label>
        <Switch
          id="db-slimming-include-active"
          checked={includeActiveTasks}
          disabled={scanLoading}
          onCheckedChange={(checked) => void handleIncludeActiveTasksChange(checked)}
          aria-label={t('settings.about.storage.dbSlimmingIncludeActiveLabel')}
        />

        <label
          htmlFor="db-slimming-backup-enabled"
          className="flex min-w-0 cursor-pointer flex-col gap-0.5"
        >
          <span className="text-12 text-[var(--settings-section-sublabel)]">
            {t('settings.about.storage.dbSlimmingBackupLabel')}
          </span>
          <span className="truncate text-11 text-[var(--settings-section-sublabel)] opacity-70">
            {backupDirectory.selected && backupDirectory.displayPath
              ? backupDirectory.displayPath
              : t('settings.about.storage.dbSlimmingBackupDefaultLocation')}
          </span>
        </label>
        <Switch
          id="db-slimming-backup-enabled"
          checked={backupEnabled}
          onCheckedChange={(checked) => setBackupEnabled(checked)}
          aria-label={t('settings.about.storage.dbSlimmingBackupLabel')}
        />

        {backupEnabled && (
          <div className="col-span-2 flex justify-end gap-2">
            {backupDirectory.selected && (
              <CardButton
                onClick={() => setBackupDirectory({ selected: false })}
              >
                {t('settings.about.storage.dbSlimmingUseDefaultDirectoryButton')}
              </CardButton>
            )}
            <CardButton onClick={handleChooseBackupDirectory}>
              {t('settings.about.storage.dbSlimmingChooseDirectoryButton')}
            </CardButton>
          </div>
        )}
      </div>

      {phase.kind === 'done' && (
        <div className="flex flex-col gap-1.5 text-12 leading-[1.5] text-[var(--settings-section-sublabel)]">
          {phase.result.status === 'completed' ? (
            <>
              <p>
                {t('settings.about.storage.dbSlimmingResultCompleted', {
                  size: formatBytes(phase.result.reclaimedBytes),
                  messages: phase.result.messageCount,
                  tasks:
                    (phase.result.activeTaskCount ?? 0) +
                    phase.result.deletedTaskCount +
                    phase.result.archivedTaskCount,
                })}
              </p>
              {phase.result.backupCreated && (
                <div>
                  <CardButton onClick={handleOpenBackup}>
                    {t('settings.about.storage.dbSlimmingOpenBackupButton')}
                  </CardButton>
                </div>
              )}
            </>
          ) : (
            <p>
              {t(`settings.about.storage.dbSlimmingFailure.${phase.result.reason}`, {
                defaultValue: t('settings.about.storage.dbSlimmingFailure.unknown'),
              })}
            </p>
          )}
        </div>
      )}

      <DatabaseCleanupDialog
        scanLoading={scanLoading}
        reportOpen={reportOpen}
        executionLocked={executionLocked}
        scanned={scanned}
        insufficientSpace={insufficientSpace}
        backupEnabled={backupEnabled}
        onReportOpenChange={handleReportOpenChange}
        onConfirm={handleSchedule}
      />
    </div>
  );
}

interface DatabaseCleanupDialogProps {
  scanLoading: boolean;
  reportOpen: boolean;
  executionLocked: boolean;
  scanned: DbSlimmingScanResult | null;
  insufficientSpace: boolean;
  backupEnabled: boolean;
  onReportOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function DatabaseCleanupDialog({
  scanLoading,
  reportOpen,
  executionLocked,
  scanned,
  insufficientSpace,
  backupEnabled,
  onReportOpenChange,
  onConfirm,
}: DatabaseCleanupDialogProps) {
  const { t } = useTranslation();
  const bodyId = useId();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const reportVisible = reportOpen && scanned !== null;
  const mode = scanLoading
    ? 'scanning'
    : executionLocked
      ? 'executing'
      : reportVisible
        ? 'report'
        : 'closed';
  const open = mode !== 'closed';
  const busy = mode === 'scanning' || mode === 'executing';

  useEffect(() => {
    if (mode !== 'report') return;
    const frame = requestAnimationFrame(() => confirmButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && mode === 'report') onReportOpenChange(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className="fixed inset-0 z-[10020] bg-[var(--overlay-modal)]"
          style={{ ...WINDOW_DRAG_STYLE, zIndex: 10020 }}
        >
          <AlertDialog.Content
            className={cn(
              'fixed inset-0 z-[10020] m-auto flex h-fit min-h-[180px] w-full max-w-[640px] flex-col',
              'rounded-xl border border-[var(--settings-theme-card-border)]',
              'bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)]',
              mode === 'report' ? 'select-text' : 'select-none',
            )}
            style={{ ...WINDOW_NO_DRAG_STYLE, zIndex: 10020 }}
            aria-describedby={mode === 'report' ? bodyId : undefined}
            aria-busy={busy || undefined}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            {busy ? (
              <AlertDialog.Title className="flex flex-1 items-center justify-center gap-3 text-14 font-medium text-[var(--confirm-title)]">
                <Spinner size={18} />
                <span role="status" aria-live="assertive">
                  {mode === 'scanning'
                    ? t('settings.about.storage.dbSlimmingScanLoading')
                    : t('settings.about.storage.dbSlimmingExecutionLoading')}
                </span>
              </AlertDialog.Title>
            ) : (
              scanned && (
                <>
                  <AlertDialog.Title className="shrink-0 text-lg font-medium text-[var(--confirm-title)]">
                    {t('settings.about.storage.dbSlimmingScanResultTitle')}
                  </AlertDialog.Title>
                  <div
                    id={bodyId}
                    className="mt-3 flex min-h-0 flex-1 select-text flex-col gap-1.5 overflow-y-auto overscroll-contain"
                  >
                    <ReportLine
                      visible
                      text={t(
                        scanned.includeActiveTasks
                          ? 'settings.about.storage.dbSlimmingReportTasksWithActive'
                          : 'settings.about.storage.dbSlimmingReportTasks',
                        {
                          active: scanned.activeTaskCount,
                          deleted: scanned.deletedTaskCount,
                          archived: scanned.archivedTaskCount,
                        },
                      )}
                    />
                    <ReportLine
                      visible
                      text={t('settings.about.storage.dbSlimmingReportMessages', {
                        count: scanned.messageCount,
                        size: formatBytes(scanned.estimatedMessageBytes),
                      })}
                    />
                    <ReportLine
                      visible
                      text={t('settings.about.storage.dbSlimmingReportSpace', {
                        database: formatBytes(scanned.databaseBytes),
                        temporary: formatBytes(scanned.temporaryBytesRequired),
                        free:
                          scanned.databaseVolumeFreeBytes === null
                            ? t('settings.about.storage.dbSlimmingSpaceUnknown')
                            : formatBytes(scanned.databaseVolumeFreeBytes),
                      })}
                    />
                    {insufficientSpace && (
                      <p className="text-12 leading-[1.5] text-[hsl(var(--destructive))]">
                        {t('settings.about.storage.dbSlimmingInsufficientSpace')}
                      </p>
                    )}
                    <p className="mt-2 text-12 leading-[1.5] text-[var(--settings-section-sublabel)] opacity-70">
                      {backupEnabled
                        ? t('settings.about.storage.dbSlimmingConfirmDescriptionWithBackup')
                        : t('settings.about.storage.dbSlimmingConfirmDescriptionWithoutBackup')}
                    </p>
                  </div>
                  <div className="mt-6 flex shrink-0 justify-end gap-2.5">
                    <AlertDialog.Cancel asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex min-w-[96px] items-center justify-center rounded-full border px-6 py-2.5 text-13 font-medium',
                          'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                          'transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        )}
                      >
                        {t('settings.about.storage.cancelButton')}
                      </button>
                    </AlertDialog.Cancel>
                    <button
                      ref={confirmButtonRef}
                      type="button"
                      disabled={insufficientSpace || scanned.messageCount === 0}
                      onClick={onConfirm}
                      className={cn(
                        'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                        'bg-[hsl(var(--destructive))] text-[var(--accent-pure-cta-fg)]',
                        'transition-colors hover:opacity-90',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      {t('settings.about.storage.dbSlimmingConfirmButton')}
                    </button>
                  </div>
                </>
              )
            )}
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
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
  disabled = false,
  busy = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  emphasis?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-12 font-medium transition-colors',
        'border border-[var(--settings-theme-card-border)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
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
