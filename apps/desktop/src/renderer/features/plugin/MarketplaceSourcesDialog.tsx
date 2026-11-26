import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
/**
 * 已添加市场管理对话框：从「添加插件市场」里的入口按钮进入。
 *
 * 承载源列表（市场名 / 来源摘要 / 插件计数 / 上次同步时间）与单个源的
 * 刷新、移除操作。刷新与移除失败时在列表上方内联展示本地化引导 +
 * （git 类错误的）消毒后原始输出。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Folder, RefreshCw, Store, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { MarketSourceSummary } from '../../../shared/pluginMarket';

import { marketplaceSourceErrorKey } from './lib/pluginMarketErrorKey';
import { MarketplaceDiscoveryNotice } from './MarketplaceDiscoveryNotice';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

export interface MarketplaceSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: MarketSourceSummary[];
  /** 刷新/移除成功后通知父级重拉源列表与市场快照。 */
  onChanged: () => void;
}

function sourceSummary(source: MarketSourceSummary['source']): string {
  if (source.type === 'local') return source.path;
  return source.url.replace(/\.git$/, '').replace(/^https:\/\//, '');
}

// 只有 git 克隆类错误码的 detail 是消毒后的 stderr 摘录,值得原文展示;
// 其它错误码的 message 是内部英文文案,展示反而会和本地化引导重复。
const GIT_DETAIL_CODES = new Set([
  'MARKET_CLONE_AUTH_FAILED',
  'MARKET_CLONE_FAILED',
  'MARKET_REF_NOT_FOUND',
]);

export function MarketplaceSourcesDialog({
  open,
  onOpenChange,
  sources,
  onChanged,
}: MarketplaceSourcesDialogProps) {
  const { t, i18n } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<MarketSourceSummary | null>(null);
  const [operationError, setOperationError] = useState<{
    key: string;
    detail: string | null;
  } | null>(null);
  // 刷新成功的发现回执(与错误互斥;新一轮操作前清空)。
  const [refreshedSummary, setRefreshedSummary] = useState<MarketSourceSummary | null>(null);

  const toOperationError = (error: unknown) => {
    const ipc = extractIpcError(error);
    return {
      key: marketplaceSourceErrorKey(error),
      detail: ipc && GIT_DETAIL_CODES.has(ipc.code) ? ipc.message : null,
    };
  };

  // 移除确认框由 `pendingRemove` 独立驱动:父对话框被关掉(含切号时父级清空状态并
  // 关闭)时它不会自动消失,用户随后确认会对**当前账号**执行 removeSource ——
  // 若新账号恰有同名来源,就会在还显示旧账号来源名的确认框里误删新账号的配置。
  // 所以父级一关就立刻清空待移除项,并让确认框的打开状态受父级 open 约束。
  useEffect(() => {
    if (open) return;
    setPendingRemove(null);
    setBusySource(null);
    setOperationError(null);
    // 回执含市场名与计数,与来源列表同作用域:父级一关(含切号)即清空。
    setRefreshedSummary(null);
  }, [open]);

  const handleRefresh = useCallback(
    async (name: string) => {
      setBusySource(name);
      setOperationError(null);
      setRefreshedSummary(null);
      try {
        const summary = await window.electronAPI.pluginMarket.refreshSource(name);
        setRefreshedSummary(summary);
        onChanged();
      } catch (error) {
        setOperationError(toOperationError(error));
      } finally {
        setBusySource(null);
      }
    },
    [onChanged],
  );

  const executeRemove = useCallback(
    async (source: MarketSourceSummary) => {
      setBusySource(source.name);
      setOperationError(null);
      // 被移除的可能正是回执指向的来源,残留会指向已不存在的市场。
      setRefreshedSummary(null);
      try {
        await window.electronAPI.pluginMarket.removeSource(source.name);
        onChanged();
      } catch (error) {
        setOperationError(toOperationError(error));
      } finally {
        setBusySource(null);
      }
    },
    [onChanged],
  );

  const handleRemove = useCallback((source: MarketSourceSummary) => {
    setPendingRemove(source);
  }, []);

  const formatSyncedAt = (iso: string | null): string => {
    if (!iso) return t('settings.ghosts.market.sources.neverSynced');
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'modal-scrim fixed inset-0 z-modal-raised',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'modal-panel fixed inset-0 z-modal-raised m-auto flex h-fit max-h-[70vh] w-[calc(100%-2rem)] max-w-[560px] select-none flex-col overflow-hidden p-6',
          )}
          style={
            {
              WebkitAppRegion: 'no-drag',
            } as CSSProperties
          }
        >
          <div className="flex shrink-0 items-start justify-between gap-3">
            <Dialog.Title ref={titleRef} tabIndex={-1} className="text-18 font-medium text-[var(--confirm-title)]">
              {t('settings.ghosts.market.sources.listTitle')}
            </Dialog.Title>
            <Tip text={t('settings.ghosts.market.sources.close')}>
              <Dialog.Close asChild>
                <Button variant="secondary" tone="quiet" size="sm" className="w-7 px-0" aria-label={t('settings.ghosts.market.sources.close')}>
                  <X size={15} aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </Tip>
          </div>

          <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
            {operationError ? (
              <ErrorNotice
                role="alert"
                className="mb-3"
                message={t(operationError.key)}
                details={operationError.detail ?? undefined}
              />
            ) : null}

            {refreshedSummary ? (
              <div className="mb-3">
                <MarketplaceDiscoveryNotice summary={refreshedSummary} action="refreshed" />
              </div>
            ) : null}

            <div className="divide-y divide-[var(--border-default)]">
              {sources.map((source) => (
                <div
                  key={source.name}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0 min-[480px]:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  {source.source.type === 'local' ? (
                    <Folder size={18} aria-hidden="true" className="mt-0.5 text-[var(--text-secondary)]" />
                  ) : (
                    <Store size={18} aria-hidden="true" className="mt-0.5 text-[var(--text-secondary)]" />
                  )}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="min-w-0 break-words text-14 font-medium text-[var(--text-primary)]">
                        {source.name}
                      </span>
                      <span className="shrink-0 text-12 tabular-nums text-[var(--text-tertiary)]">
                        {source.status === 'ok'
                          ? t('settings.ghosts.market.sources.pluginCount', {
                              count: source.pluginCount,
                            })
                          : t('settings.ghosts.market.sources.sourceError')}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-12 text-[var(--text-tertiary)]">
                      <span className="min-w-0 break-words">
                        {source.source.type === 'local'
                          ? t('settings.ghosts.market.sources.localBadge')
                          : (source.source.ref ??
                            t('settings.ghosts.market.sources.defaultRef'))}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{formatSyncedAt(source.lastSyncedAt)}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-12 text-[var(--text-tertiary)]">{sourceSummary(source.source)}</p>
                    {source.status === 'ok' ? (
                      <div className="mt-1.5 text-12 leading-[1.333] text-[var(--text-tertiary)]">
                        {source.pluginCount === 0 &&
                        source.skippedCount === 0 &&
                        source.unreadableCount === 0 ? (
                          <p>{t('settings.ghosts.market.sources.empty')}</p>
                        ) : null}
                        {source.skippedCount > 0 ? (
                          <p>
                            {t('settings.ghosts.market.sources.skippedEntries', {
                              count: source.skippedCount,
                            })}
                          </p>
                        ) : null}
                        {source.pluginCount === 0 &&
                        source.skippedCount > 0 &&
                        source.unreadableCount === 0 ? (
                          <p className="text-[var(--warning-fg)]">
                            {t('settings.ghosts.market.sources.emptyWithSkippedEntries')}
                          </p>
                        ) : null}
                        {source.unreadableCount > 0 ? (
                          <p className="text-[var(--warning-fg)]">
                            {t('settings.ghosts.market.sources.unreadableEntries', {
                              count: source.unreadableCount,
                            })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="col-start-2 flex flex-wrap items-center gap-2 min-[480px]:col-start-3 min-[480px]:justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      compact
                      loading={busySource === source.name}
                      type="button"
                      disabled={busySource !== null}
                      onClick={() => void handleRefresh(source.name)}
                    >
                        <RefreshCw size={12} aria-hidden="true" />
                      {t('settings.ghosts.market.sources.refresh')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      tone="danger"
                      compact
                      type="button"
                      disabled={busySource !== null}
                      onClick={() => void handleRemove(source)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      {t('settings.ghosts.market.sources.remove')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {/* 父级关闭即视为确认框关闭:切号时父级会先关掉,不能让它独立存活。 */}
      <ConfirmDialog
        open={open && pendingRemove !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingRemove(null);
        }}
        zIndex={Z_INDEX_LAYERS['modal-nested']}
        title={
          pendingRemove
            ? t('settings.ghosts.market.sources.removeConfirmTitle', {
                name: pendingRemove.name,
              })
            : ''
        }
        description={t('settings.ghosts.market.sources.removeConfirmDescription')}
        confirmText={t('settings.ghosts.market.sources.remove')}
        confirmVariant="destructive"
        onConfirm={() => {
          if (!pendingRemove) return;
          const source = pendingRemove;
          setPendingRemove(null);
          void executeRemove(source);
        }}
      />
    </Dialog.Root>
  );
}
