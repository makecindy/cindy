/**
 * 备用模型模式的**头部与底部**。
 *
 * 不是第二个面板:进入备用模式后,中间仍然是那张真实的模型列表(同一个
 * `UnifiedModelPanel`,同样的搜索、分组、供应商侧栏)。这里只在它上下各加一条,
 * 说明「现在点中的模型会成为备用」,并把已有链条摆出来。
 *
 * 这样做的理由:选模型只有一套界面。如果备用另起一张列表,用户要学两遍同一件事,
 * 而且两张列表的能力必然随时间分叉。
 *
 * 视觉:整块底色抬到 `--surface-elevated-soft`(比主面板浅一档),与主面板区分,
 * 但仍是同一套 token —— 没有新造颜色,也没有引入新控件。
 */

import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FallbackChain, FallbackChainEntry } from '@cindy/maker-shared/fallback-chain';

import { cn } from '@/lib/utils';

export interface FallbackChainHeaderProps {
  chain: FallbackChain;
  labelOf: (entry: FallbackChainEntry) => string;
  onBack: () => void;
  onRemove: (uid: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  interactionDisabled?: boolean;
  /** 让调用方实测头部高度:chip 换行后它不再是一个常量。 */
  containerRef?: (node: HTMLDivElement | null) => void;
}

/**
 * 链条一览:主模型 → 备用 1 → 备用 2 …
 *
 * 用箭头连成一条而不是竖排列表 —— 顺序就是接管顺序,顺着读更直观,也不抢列表的
 * 纵向空间。
 *
 * ★ 换行而不是横向滚动:横向滚动时第 3 条之后的链节直接滑出面板右缘,用户看不见
 * 自己刚加的备用,也够不到它的 ✕(面板里没有横向滚动条的提示)。链条最多 8 节,
 * 换行最坏也就多占两行,比「加了但看不到」好得多。
 */
function ChainStrip({
  chain,
  labelOf,
  onRemove,
  interactionDisabled,
  removeLabel,
}: {
  chain: FallbackChain;
  labelOf: (entry: FallbackChainEntry) => string;
  onRemove: (uid: string) => void;
  interactionDisabled: boolean;
  removeLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
      {chain.entries.map((entry, index) => (
        <span key={entry.uid} className="flex shrink-0 items-center gap-1">
          {index > 0 && (
            <span aria-hidden className="shrink-0 text-11 text-[var(--text-tertiary)]">
              →
            </span>
          )}
          <span
            data-fallback-chip={entry.uid}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-11',
              index === 0
                ? 'bg-[var(--model-item-check)] text-[var(--model-dropdown-bg)]'
                : 'bg-[var(--model-item-hover)] text-[var(--model-item-text)]',
            )}
          >
            <span className="max-w-[160px] truncate" title={labelOf(entry)}>
              {labelOf(entry)}
            </span>
            {index > 0 && (
              <button
                type="button"
                aria-label={removeLabel}
                title={removeLabel}
                disabled={interactionDisabled}
                onClick={() => onRemove(entry.uid)}
                className={cn(
                  'shrink-0 rounded-[3px] text-[var(--model-item-desc)]',
                  'transition-colors hover:text-[var(--model-item-text)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <X size={11} />
              </button>
            )}
          </span>
        </span>
      ))}
    </div>
  );
}

/** 备用模式的头部:返回、标题、启用开关,以及当前链条。 */
export function FallbackChainHeader({
  chain,
  labelOf,
  onBack,
  onRemove,
  onToggleEnabled,
  interactionDisabled = false,
  containerRef,
}: FallbackChainHeaderProps) {
  const { t } = useTranslation();
  return (
    <div
      ref={containerRef}
      data-fallback-header
      className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--model-dropdown-border)] px-3.5 py-2.5"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('newChat.modelSelector.fallback.back')}
          title={t('newChat.modelSelector.fallback.back')}
          className={cn(
            'shrink-0 rounded-[6px] p-0.5 text-[var(--text-secondary)]',
            'transition-colors hover:text-[var(--text-primary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--model-item-text)]">
          {t('newChat.modelSelector.fallback.title')}
        </span>
        {chain.entries.length > 1 && (
          <button
            type="button"
            role="switch"
            aria-checked={chain.enabled}
            disabled={interactionDisabled}
            onClick={() => onToggleEnabled(!chain.enabled)}
            className={cn(
              'shrink-0 rounded-[6px] px-1.5 py-0.5 text-11 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              chain.enabled
                ? 'text-[var(--model-item-check)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--model-item-text)]',
              interactionDisabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {chain.enabled
              ? t('newChat.modelSelector.fallback.enabled')
              : t('newChat.modelSelector.fallback.disabled')}
          </button>
        )}
      </div>
      <ChainStrip
        chain={chain}
        labelOf={labelOf}
        onRemove={onRemove}
        interactionDisabled={interactionDisabled}
        removeLabel={t('newChat.modelSelector.fallback.remove')}
      />
      {/* 这一行是模式提示,不是装饰:列表看起来和平时一样,必须说清这次点击的后果。 */}
      <p className="text-11 leading-[1.4] text-[var(--text-tertiary)]">
        {t('newChat.modelSelector.fallback.pickHint')}
      </p>
    </div>
  );
}
