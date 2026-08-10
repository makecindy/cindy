/**
 * 已添加市场管理对话框：从「添加插件市场」里的入口按钮进入。
 *
 * 承载源列表（市场名 / 来源摘要 / 插件计数 / 上次同步时间）与单个源的
 * 刷新、移除操作。刷新与移除失败时在列表上方内联展示本地化引导 +
 * （git 类错误的）消毒后原始输出。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { RefreshCw, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { MarketSourceSummary } from '../../../shared/pluginMarket';

import { marketplaceSourceErrorKey } from './lib/pluginMarketErrorKey';
import { MarketplaceDiscoveryNotice } from './MarketplaceDiscoveryNotice';

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
            'fixed inset-0 z-[10001] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[85vh] w-full select-none flex-col rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={
            {
              WebkitAppRegion: 'no-drag',
              maxWidth: 'min(460px, 100vw - 32px)',
            } as CSSProperties
          }
        >
          <div className="flex shrink-0 items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
              {t('settings.ghosts.market.sources.listTitle')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('settings.ghosts.market.sources.close')}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {operationError ? (
              <div
                role="alert"
                className="mb-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
              >
                <p className="text-12 leading-5 text-[hsl(var(--destructive))]">
                  {t(operationError.key)}
                </p>
                {operationError.detail ? (
                  <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-11 leading-4 text-[var(--text-tertiary)]">
                    {operationError.detail}
                  </pre>
                ) : null}
              </div>
            ) : null}

            {refreshedSummary ? (
              <div className="mb-3">
                <MarketplaceDiscoveryNotice summary={refreshedSummary} action="refreshed" />
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              {sources.map((source) => (
                <div
                  key={source.name}
                  className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">
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
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-11 text-[var(--text-tertiary)]">
                    <span className="shrink-0">
                      {source.source.type === 'local'
                        ? t('settings.ghosts.market.sources.localBadge')
                        : (source.source.ref ??
                          t('settings.ghosts.market.sources.defaultRef'))}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate">{sourceSummary(source.source)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">{formatSyncedAt(source.lastSyncedAt)}</span>
                  </div>
                  {source.status === 'ok' ? (
                    <div className="mt-1.5 text-11 leading-4 text-[var(--text-tertiary)]">
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
                  <div className="mt-2.5 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={busySource !== null}
                      onClick={() => void handleRefresh(source.name)}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)]',
                        'transition-colors hover:bg-[var(--surface-hover-soft)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                      )}
                    >
                      {busySource === source.name ? (
                        <Spinner size={12} />
                      ) : (
                        <RefreshCw size={12} aria-hidden="true" />
                      )}
                      {t('settings.ghosts.market.sources.refresh')}
                    </button>
                    <button
                      type="button"
                      disabled={busySource !== null}
                      onClick={() => void handleRemove(source)}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-12 font-medium',
                        'bg-[color-mix(in_srgb,hsl(var(--destructive))_15%,transparent)] text-[hsl(var(--destructive))]',
                        'transition-colors hover:bg-[color-mix(in_srgb,hsl(var(--destructive))_25%,transparent)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--destructive))]',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                      )}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      {t('settings.ghosts.market.sources.remove')}
                    </button>
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
        zIndex={10002}
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
