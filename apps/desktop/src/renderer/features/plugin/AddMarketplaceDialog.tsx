/**
 * 添加插件市场对话框：添加表单（来源 / Git 引用 / 稀疏路径）+ 已添加市场的
 * 管理入口（新开 MarketplaceSourcesDialog，避免本对话框被列表撑长）。
 *
 * 视觉规格遵循 DESIGN.md §4 Dialog & Modal：overlay 用 --overlay-modal token，
 * 容器 12px radius + --confirm-bg + --confirm-shadow，表单对话框放宽到 460px；
 * 单行输入 pill、多行输入 8px 内层 radius，按钮全部 pill。
 */
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { extractIpcError } from '@/utils/ipcError';
import type { MarketSourceSummary } from '../../../shared/pluginMarket';

import { marketplaceSourceErrorKey } from './lib/pluginMarketErrorKey';
import { MarketplaceDiscoveryNotice } from './MarketplaceDiscoveryNotice';
import { MarketplaceGuideDialog } from './MarketplaceGuideDialog';
import { MarketplaceSourcesDialog } from './MarketplaceSourcesDialog';

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
    trimmed.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\')
  );
}

export function AddMarketplaceDialog({
  open,
  onOpenChange,
  onSourcesChanged,
}: AddMarketplaceDialogProps) {
  const { t } = useTranslation();
  // 账号/模式作为来源列表的作用域键:切号必须清掉上一账号的来源摘要。
  const { mode, dataOwnerId } = useAuth();
  const [sources, setSources] = useState<MarketSourceSummary[] | null>(null);
  const [gitReady, setGitReady] = useState<boolean | null>(null);
  const [sourceInput, setSourceInput] = useState('');
  const [refInput, setRefInput] = useState('');
  const [sparseInput, setSparseInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // 添加/刷新失败的内联错误：本地化引导 + git 原始详情（与 Codex 同级信息量）。
  const [operationError, setOperationError] = useState<{
    key: string;
    detail: string | null;
  } | null>(null);
  // 添加成功的发现回执:插件数 + 跳过/暂不可读提示(与错误互斥,新一轮操作前清空)。
  const [addedSummary, setAddedSummary] = useState<MarketSourceSummary | null>(null);

  // 只有 git 克隆类错误码的 detail 是消毒后的 stderr 摘录,值得原文展示;
  // 其它错误码的 message 是内部英文文案,展示反而会和本地化引导重复。
  const GIT_DETAIL_CODES = new Set([
    'MARKET_CLONE_AUTH_FAILED',
    'MARKET_CLONE_FAILED',
    'MARKET_REF_NOT_FOUND',
  ]);
  const toOperationError = (error: unknown) => {
    const ipc = extractIpcError(error);
    return {
      key: marketplaceSourceErrorKey(error),
      detail: ipc && GIT_DETAIL_CODES.has(ipc.code) ? ipc.message : null,
    };
  };

  const loadSources = useCallback(async () => {
    try {
      const list = await window.electronAPI.pluginMarket.listSources();
      setSources(list);
    } catch {
      // 会话切换中等场景下读取失败：保持上一次列表，下次打开再试。
      setSources((current) => current ?? []);
    }
  }, []);

  // 来源摘要里有私有仓库 URL 与本地绝对路径,属于上一账号的数据。Main 的返回前
  // generation 校验只能拒掉新请求,撤不回 Renderer 已经缓存并正在展示的列表——
  // 所以账号/模式一变就立刻清空本地状态并关掉来源管理子对话框,再按新账号重载。
  useEffect(() => {
    setSources(null);
    setSourcesOpen(false);
    setOperationError(null);
    // 回执含上一账号的市场名与计数,作用域同来源列表:切号/重开一并清空。
    setAddedSummary(null);
    if (!open) return;
    void loadSources();
  }, [mode, dataOwnerId, open, loadSources]);

  useEffect(() => {
    if (!open) return;
    setSourceInput('');
    setRefInput('');
    setSparseInput('');
    void window.electronAPI.pluginMarket
      .gitPreflight()
      .then((result) => setGitReady(result.ok))
      .catch(() => setGitReady(null));
  }, [open]);

  const sourceIsLocal = looksLikeLocalPath(sourceInput);
  const addDisabled =
    adding ||
    sourceInput.trim().length === 0 ||
    (gitReady === false && !sourceIsLocal);

  const handleAdd = useCallback(async () => {
    if (addDisabled) return;
    setAdding(true);
    setOperationError(null);
    setAddedSummary(null);
    try {
      // 本地目录的授权必须来自 Main 原生目录选择器(选择即授权):Renderer 直传
      // 绝对路径在 IPC 层会被拒——XSS 控制下的自报路径不构成用户授权。输入的
      // 路径只作为原生框的初始定位提示;用户取消则静默结束。
      let summary: MarketSourceSummary;
      if (sourceIsLocal) {
        const picked = await window.electronAPI.pluginMarket.pickLocalSource(sourceInput.trim());
        if (picked.canceled) return;
        summary = picked.summary;
      } else {
        const sparsePaths = sparseInput
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        const ref = refInput.trim();
        summary = await window.electronAPI.pluginMarket.addSource({
          source: sourceInput.trim(),
          ...(ref ? { ref } : {}),
          ...(sparsePaths.length > 0 ? { sparsePaths } : {}),
        });
      }
      setAddedSummary(summary);
      setSourceInput('');
      setRefInput('');
      setSparseInput('');
      await loadSources();
      onSourcesChanged();
    } catch (error) {
      setOperationError(toOperationError(error));
    } finally {
      setAdding(false);
    }
  }, [
    addDisabled,
    loadSources,
    onSourcesChanged,
    refInput,
    sourceInput,
    sourceIsLocal,
    sparseInput,
    t,
  ]);

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
          <Dialog.Description className="mt-2 shrink-0 text-12 text-[var(--confirm-desc)]">
            {t('settings.ghosts.market.sources.dialogDescription')}{' '}
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              className="cursor-pointer bg-transparent p-0 text-12 text-[var(--settings-source-link)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('settings.ghosts.market.sources.learnMore')}
            </button>
          </Dialog.Description>

          {/* 负 margin + 内边距补偿：滚动容器不裁掉输入框向外渲染的 focus ring。 */}
          <div className="-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
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
                    'outline-none transition-colors focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
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
                    'outline-none transition-colors focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
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
                    'outline-none transition-colors focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
              </label>
            </div>

            {operationError ? (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
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

            {addedSummary ? (
              <div className="mt-3">
                <MarketplaceDiscoveryNotice summary={addedSummary} action="added" />
              </div>
            ) : null}

            {sources && sources.length > 0 ? (
              <button
                type="button"
                onClick={() => setSourcesOpen(true)}
                className={cn(
                  'mt-5 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3',
                  'transition-colors hover:bg-[var(--surface-hover-soft)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <span className="text-13 font-medium text-[var(--text-primary)]">
                  {t('settings.ghosts.market.sources.listTitle')}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-12 tabular-nums text-[var(--text-tertiary)]">
                  {sources.length}
                  <ChevronRight size={13} aria-hidden="true" />
                </span>
              </button>
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
      <MarketplaceGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
      <MarketplaceSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        sources={sources ?? []}
        onChanged={() => {
          void loadSources();
          onSourcesChanged();
        }}
      />
    </Dialog.Root>
  );
}
