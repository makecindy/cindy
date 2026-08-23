/**
 * GhostLibrarySection — 插件详情页的「持久作品库」设置区(2026-08-20)。
 * ---------------------------------------------------------------------------
 * 只在 manifest 声明 library 槽时渲染。职责:
 *   - 展示位置(默认/自定义)、占用、磁盘余量、状态横幅(漂移/只读/orphaned);
 *   - 更改位置(宿主弹原生选择器 → 候选校验 → 确认 → 迁移状态机);
 *   - 恢复默认位置(反向迁移 + 撤销 binding);漂移时的「解除位置记录」恢复;
 *   - 删除作品数据——与卸载是**两个独立操作**,独立破坏性确认,进 30 天回收站。
 * 全部动作走 window.electronAPI.ghosts.library*(宿主裁决,插件无权发起)。
 * 样式常量与 GhostPluginDetailView 同值(语义 token,Light/Dark 自动适配)。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Library as LibraryIcon, Loader2, RefreshCw } from 'lucide-react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { GhostLibraryOverview } from '../../../shared/ghost';

const SECTION_CLASS = 'mt-10';
const SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';
const ROW_CLASS = 'flex items-center justify-between gap-4 text-13 leading-5';
const ACTION_BUTTON_CLASS =
  'text-13 font-medium text-[var(--accent)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_BUTTON_CLASS =
  'text-13 font-medium text-[var(--danger)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 外层:未声明 library 槽直接不挂载内层(内层用了 useConfirmDialog,测试环境
 * 无 Provider——不声明就不进 hook,老用例零影响)。
 */
export function GhostLibrarySection({ ghostId, slots }: { ghostId: string; slots: readonly string[] }) {
  if (!slots.includes('library')) return null;
  return <GhostLibrarySectionInner ghostId={ghostId} />;
}

function GhostLibrarySectionInner({ ghostId }: { ghostId: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [overview, setOverview] = useState<GhostLibraryOverview | null>(null);
  const [busy, setBusy] = useState<'relocate' | 'delete' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI.ghosts.libraryOverview(ghostId);
      setOverview(next);
      setLoadError(null);
    } catch {
      setLoadError(t('settings.ghosts.library.loadFailed'));
    }
  }, [ghostId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const drifted = overview !== null && overview.state === 'unavailable';

  const handleChangeLocation = async () => {
    if (busy) return;
    const picked = await window.electronAPI.ghosts.libraryPickLocation(ghostId);
    if (!picked.ok) {
      if (!picked.cancelled) toast.error(picked.message ?? t('settings.ghosts.library.pickFailed'));
      return;
    }
    const candidate = picked.candidate!;
    if (picked.warnings && picked.warnings.length > 0) {
      const proceed = await confirm({
        title: t('settings.ghosts.library.cloudWarningTitle'),
        description: picked.warnings.join('\n'),
        confirmText: t('settings.ghosts.library.cloudWarningProceed'),
        cancelText: t('settings.ghosts.library.cancel'),
      });
      if (!proceed) return;
    }
    const ok = await confirm({
      title: t('settings.ghosts.library.relocateConfirmTitle'),
      description: t('settings.ghosts.library.relocateConfirmDescription'),
      confirmText: t('settings.ghosts.library.relocateConfirmText'),
      cancelText: t('settings.ghosts.library.cancel'),
    });
    if (!ok) return;
    setBusy('relocate');
    try {
      const res = await window.electronAPI.ghosts.libraryRelocate(ghostId, candidate);
      if (res.ok) {
        toast.success(t('settings.ghosts.library.relocateDone'));
      } else {
        toast.error(`${t('settings.ghosts.library.relocateFailed')}:${res.message ?? ''}`);
      }
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const handleRevertDefault = async () => {
    if (busy) return;
    const ok = await confirm({
      title: t('settings.ghosts.library.revertConfirmTitle'),
      description: t('settings.ghosts.library.relocateConfirmDescription'),
      confirmText: t('settings.ghosts.library.revertConfirmText'),
      cancelText: t('settings.ghosts.library.cancel'),
    });
    if (!ok) return;
    setBusy('relocate');
    try {
      const res = await window.electronAPI.ghosts.libraryRevertDefault(ghostId);
      if (!res.ok) toast.error(`${t('settings.ghosts.library.relocateFailed')}:${res.message ?? ''}`);
      else toast.success(t('settings.ghosts.library.relocateDone'));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const handleUnbind = async () => {
    if (busy) return;
    const ok = await confirm({
      title: t('settings.ghosts.library.unbindConfirmTitle'),
      description: t('settings.ghosts.library.unbindConfirmDescription'),
      confirmText: t('settings.ghosts.library.unbindConfirmText'),
      cancelText: t('settings.ghosts.library.cancel'),
    });
    if (!ok) return;
    await window.electronAPI.ghosts.libraryUnbind(ghostId);
    void refresh();
  };

  const handleDelete = async () => {
    if (busy) return;
    // 删除确认由 Main 原生确认框裁决(唯一有效确认):preload 即使被其它
    // trusted renderer 调用也绕不过去。Renderer 不再先弹一次,避免双重确认。
    setBusy('delete');
    try {
      const res = await window.electronAPI.ghosts.libraryDelete(ghostId);
      if (res.ok) toast.success(t('settings.ghosts.library.deleteDone'));
      else if (!res.cancelled) toast.error(`${t('settings.ghosts.library.deleteFailed')}:${res.message ?? ''}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <section className={SECTION_CLASS} aria-labelledby="ghost-library-title">
      <div className="flex items-center justify-between">
        <h3 id="ghost-library-title" className="flex items-center gap-2 text-18 font-medium leading-[1.444] text-[var(--text-primary)]">
          <LibraryIcon size={18} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
          {t('settings.ghosts.library.title')}
        </h3>
        <button
          type="button"
          className={ACTION_BUTTON_CLASS}
          onClick={() => void refresh()}
          aria-label={t('settings.ghosts.library.refresh')}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      <div className={cn(SURFACE_CLASS, 'mt-5 max-w-[760px] rounded-xl p-4')}>
        {loadError ? (
          <p className="text-13 text-[var(--warning-fg)]">{loadError}</p>
        ) : overview === null ? (
          <p className="text-13 text-[var(--text-tertiary)]">{t('settings.ghosts.library.loading')}</p>
        ) : (
          <>
            {drifted ? (
              <p className="mb-3 text-13 text-[var(--warning-fg)]">
                {overview.reason === 'disk-missing'
                  ? t('settings.ghosts.library.stateDiskMissing')
                  : t('settings.ghosts.library.stateBindingMoved')}
              </p>
            ) : null}
            {overview.state === 'readonly' ? (
              <p className="mb-3 text-13 text-[var(--warning-fg)]">{t('settings.ghosts.library.stateReadonly')}</p>
            ) : null}
            {overview.orphaned ? (
              <p className="mb-3 text-13 text-[var(--text-secondary)]">{t('settings.ghosts.library.orphanedBanner')}</p>
            ) : null}
            <div className="space-y-2">
              <div className={ROW_CLASS}>
                <span className="text-[var(--text-secondary)]">{t('settings.ghosts.library.locationLabel')}</span>
                <span className="min-w-0 break-all text-right text-[var(--text-primary)]">
                  {overview.location === 'custom' && overview.customCandidate
                    ? `${t('settings.ghosts.library.locationCustomPrefix')} ${overview.customCandidate}`
                    : t('settings.ghosts.library.locationDefault')}
                </span>
              </div>
              <div className={ROW_CLASS}>
                <span className="text-[var(--text-secondary)]">{t('settings.ghosts.library.usageLabel')}</span>
                <span className="text-[var(--text-primary)]">
                  {formatBytes(overview.usedBytes)} · {overview.fileCount} {t('settings.ghosts.library.filesUnit')}
                </span>
              </div>
              {overview.diskFreeBytes !== null ? (
                <div className={ROW_CLASS}>
                  <span className="text-[var(--text-secondary)]">{t('settings.ghosts.library.diskFreeLabel')}</span>
                  <span className="text-[var(--text-primary)]">{formatBytes(overview.diskFreeBytes)}</span>
                </div>
              ) : null}
            </div>
            {overview.softLimitExceeded ? (
              <p className="mt-3 text-12 text-[var(--warning-fg)]">
                {t('settings.ghosts.library.softLimitWarning', { limit: formatBytes(overview.softLimitBytes) })}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {busy === 'relocate' ? (
                <span className="inline-flex items-center gap-1.5 text-13 text-[var(--text-secondary)]">
                  <span className="inline-flex animate-spin">
                    <Loader2 size={14} aria-hidden="true" />
                  </span>
                  {t('settings.ghosts.library.relocateBusy')}
                </span>
              ) : (
                <>
                  <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => void handleChangeLocation()}>
                    {t('settings.ghosts.library.changeLocation')}
                  </button>
                  {drifted ? (
                    <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => void handleUnbind()}>
                      {t('settings.ghosts.library.unbind')}
                    </button>
                  ) : overview.location === 'custom' ? (
                    <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => void handleRevertDefault()}>
                      {t('settings.ghosts.library.revertDefault')}
                    </button>
                  ) : null}
                </>
              )}
              <span className="flex-1" />
              <button
                type="button"
                className={DANGER_BUTTON_CLASS}
                disabled={busy !== null}
                onClick={() => void handleDelete()}
              >
                {busy === 'delete' ? t('settings.ghosts.library.deleteBusy') : t('settings.ghosts.library.deleteData')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
