/**
 * 添加插件市场对话框：上半部分添加表单（来源 / Git 引用 / 稀疏路径），
 * 下半部分已添加源列表（刷新 / 移除）。
 *
 * 视觉规格遵循 DESIGN.md §4 Dialog & Modal：overlay 用 --overlay-modal token，
 * 容器 12px radius + --confirm-bg + --confirm-shadow，表单对话框放宽到 460px；
 * 单行输入 pill、多行输入 8px 内层 radius，按钮全部 pill。
 */
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { MarketSourceSummary } from '../../../shared/pluginMarket';

import { marketplaceSourceErrorKey } from './lib/pluginMarketErrorKey';

export interface AddMarketplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 来源增删 / 刷新成功后通知父级重拉市场快照。 */
  onSourcesChanged: () => void;
}

/** 与 main 侧 parse.ts 同形状的前置判断：仅用于决定 Git 不可用时要不要禁用添加。 */
function looksLikeLocalPath(input: string): boolean {
  const trimmed = input.trim();
  return (
    trimmed.startsWith('~') ||
    trimmed.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\')
  );
}

function sourceSummary(source: MarketSourceSummary['source']): string {
  if (source.type === 'local') return source.path;
  return source.url.replace(/\.git$/, '').replace(/^https:\/\//, '');
}

export function AddMarketplaceDialog({
  open,
  onOpenChange,
  onSourcesChanged,
}: AddMarketplaceDialogProps) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [sources, setSources] = useState<MarketSourceSummary[] | null>(null);
  const [gitReady, setGitReady] = useState<boolean | null>(null);
  const [sourceInput, setSourceInput] = useState('');
  const [refInput, setRefInput] = useState('');
  const [sparseInput, setSparseInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [busySource, setBusySource] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const list = await window.electronAPI.pluginMarket.listSources();
      setSources(list);
    } catch {
      // 会话切换中等场景下读取失败：保持上一次列表，下次打开再试。
      setSources((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSourceInput('');
    setRefInput('');
    setSparseInput('');
    void loadSources();
    void window.electronAPI.pluginMarket
      .gitPreflight()
      .then((result) => setGitReady(result.ok))
      .catch(() => setGitReady(null));
  }, [open, loadSources]);

  const sourceIsLocal = looksLikeLocalPath(sourceInput);
  const addDisabled =
    adding ||
    sourceInput.trim().length === 0 ||
    (gitReady === false && !sourceIsLocal);

  const handleAdd = useCallback(async () => {
    if (addDisabled) return;
    setAdding(true);
    try {
      const sparsePaths = sparseInput
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      await window.electronAPI.pluginMarket.addSource({
        source: sourceInput.trim(),
        ...(refInput.trim() ? { ref: refInput.trim() } : {}),
        ...(sparsePaths.length > 0 ? { sparsePaths } : {}),
      });
      setSourceInput('');
      setRefInput('');
      setSparseInput('');
      await loadSources();
      onSourcesChanged();
    } catch (error) {
      toast.error(t(marketplaceSourceErrorKey(error)));
    } finally {
      setAdding(false);
    }
  }, [addDisabled, loadSources, onSourcesChanged, refInput, sourceInput, sparseInput, t]);

  const handleRefresh = useCallback(
    async (name: string) => {
      setBusySource(name);
      try {
        await window.electronAPI.pluginMarket.refreshSource(name);
        await loadSources();
        onSourcesChanged();
      } catch (error) {
        toast.error(t(marketplaceSourceErrorKey(error)));
      } finally {
        setBusySource(null);
      }
    },
    [loadSources, onSourcesChanged, t],
  );

  const handleRemove = useCallback(
    async (source: MarketSourceSummary) => {
      const confirmed = await confirm({
        title: t('settings.ghosts.market.sources.removeConfirmTitle', {
          name: source.name,
        }),
        description: t('settings.ghosts.market.sources.removeConfirmDescription'),
        confirmText: t('settings.ghosts.market.sources.remove'),
      });
      if (!confirmed) return;
      setBusySource(source.name);
      try {
        await window.electronAPI.pluginMarket.removeSource(source.name);
        await loadSources();
        onSourcesChanged();
      } catch (error) {
        toast.error(t(marketplaceSourceErrorKey(error)));
      } finally {
        setBusySource(null);
      }
    },
    [confirm, loadSources, onSourcesChanged, t],
  );

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
    <Dialog.Root open={open} onOpenChange={(next) => !adding && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[85vh] w-full select-none flex-col rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={
            {
              WebkitAppRegion: 'no-drag',
              maxWidth: 'min(460px, 100vw - 32px)',
            } as React.CSSProperties
          }
        >
          <Dialog.Title className="shrink-0 text-lg font-medium text-[var(--confirm-title)]">
            {t('settings.ghosts.market.sources.dialogTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 shrink-0 text-base text-[var(--confirm-desc)]">
            {t('settings.ghosts.market.sources.dialogDescription')}
          </Dialog.Description>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {gitReady === false ? (
              <p className="mb-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12 text-[var(--text-secondary)]">
                {t('settings.ghosts.market.sources.gitUnavailable')}
              </p>
            ) : null}

            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-12 text-[var(--text-secondary)]">
                  {t('settings.ghosts.market.sources.sourceLabel')}
                </span>
                <input
                  value={sourceInput}
                  onChange={(event) => setSourceInput(event.target.value)}
                  placeholder={t('settings.ghosts.market.sources.sourcePlaceholder')}
                  spellCheck={false}
                  className={cn(
                    'h-10 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4',
                    'text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                  )}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-12 text-[var(--text-secondary)]">
                  {t('settings.ghosts.market.sources.refLabel')}
                </span>
                <input
                  value={refInput}
                  onChange={(event) => setRefInput(event.target.value)}
                  placeholder={t('settings.ghosts.market.sources.refPlaceholder')}
                  spellCheck={false}
                  disabled={sourceIsLocal}
                  className={cn(
                    'h-10 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4',
                    'text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-12 text-[var(--text-secondary)]">
                  {t('settings.ghosts.market.sources.sparseLabel')}
                </span>
                <textarea
                  value={sparseInput}
                  onChange={(event) => setSparseInput(event.target.value)}
                  placeholder={t('settings.ghosts.market.sources.sparsePlaceholder')}
                  spellCheck={false}
                  rows={2}
                  disabled={sourceIsLocal}
                  className={cn(
                    'resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2.5',
                    'text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
              </label>
            </div>

            {sources && sources.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-13 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.market.sources.listTitle')}
                </h3>
                <div className="mt-2 flex flex-col gap-2">
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
                        <span className="shrink-0">
                          {formatSyncedAt(source.lastSyncedAt)}
                        </span>
                      </div>
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
                            'inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)]',
                            'transition-colors hover:bg-[var(--surface-hover-soft)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
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
            ) : null}
          </div>

          <div className="mt-6 flex shrink-0 justify-end gap-2.5">
            <button
              type="button"
              disabled={adding}
              onClick={() => onOpenChange(false)}
              className={cn(
                'inline-flex min-w-[96px] items-center justify-center rounded-full border px-6 py-2.5 text-13 font-medium',
                'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)]',
                'transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                'active:scale-[0.98] disabled:opacity-50',
              )}
            >
              {t('settings.ghosts.market.sources.close')}
            </button>
            <button
              type="button"
              disabled={addDisabled}
              onClick={() => void handleAdd()}
              className={cn(
                'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]',
                'transition-colors hover:bg-[var(--confirm-btn-primary-hover)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--confirm-btn-primary-bg)]',
                'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
              )}
            >
              {adding ? <Spinner size={14} /> : t('settings.ghosts.market.sources.add')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
