/**
 * DocSearchBar — Ctrl+F search box pinned to the top-right of FileBodyView.
 *
 * Mirrors the visual / interaction style of the global FindInPageBar but
 * scoped to the doc area only. Pure controlled component:
 *   - parent (FileBodyView) owns query / activeIndex / total
 *   - parent owns the keyboard hook that opens this bar
 *   - DocSearchBar only handles in-input keys (Esc / Enter / Shift+Enter)
 *
 * Why a separate component: keeps FileBodyView's JSX readable and lets us
 * forward the input ref so the parent's open-handler can focus it after
 * the bar mounts.
 */

import { forwardRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface DocSearchBarProps {
  query: string;
  total: number;
  activeIndex: number;
  /** 命中数被搜索后端上限截断时显示 "N+" 暗示精确化 query。 */
  truncated?: boolean;
  onChange: (next: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export const DocSearchBar = forwardRef<HTMLInputElement, DocSearchBarProps>(
  function DocSearchBar(
    { query, total, activeIndex, truncated = false, onChange, onNext, onPrev, onClose },
    ref,
  ) {
    const { t } = useTranslation();
    return (
      <div
        className={cn(
          'flex items-center gap-1',
          'rounded-lg border border-border',
          'bg-popover text-popover-foreground',
          'shadow-sm',
          'px-2 py-1',
          /* 固定 300 而非 min-width:右侧 count (1/1 / 12/345) 出现时
             不能把整条往外撑;input 内部已经 min-w-0 + flex-1,会自己
             被 count 挤窄,光标超长由浏览器原生横滚处理。 */
          'w-[300px]',
        )}
        role="search"
        aria-label={t('ccAgent.workdirBrowse.docSearch.ariaLabel')}
        // 稳定钩子 —— WorkdirBrowseSidebar 的 Esc handler 用 querySelector
        // 看这条选择器判断 DocSearchBar 是否可见,从而把 Esc 优先权让给它
        // (DocSearchBar 不可见时 Esc 才轮到 sidebar 把 search → tree)。
        // 用 data-attr 而不是 aria-label/className 是因为它们是"会被改的视觉/
        // 文案钩子",data-attr 是明确的协议字段。
        data-doc-search-bar=""
      >
        <input
          ref={ref}
          type="text"
          value={query}
          placeholder={t('ccAgent.workdirBrowse.docSearch.placeholder')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) onPrev();
              else onNext();
            }
          }}
          className={cn(
            'min-w-0 flex-1',
            'bg-transparent outline-none',
            'text-sm',
            'placeholder:text-[var(--text-placeholder)]',
          )}
        />
        <span
          className="select-none whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
          title={truncated ? t('ccAgent.workdirBrowse.docSearch.truncatedTitle') : undefined}
        >
          {query
            ? total > 0
              ? `${activeIndex + 1}/${total}${truncated ? '+' : ''}`
              : '0/0'
            : ''}
        </span>
        <button
          type="button"
          aria-label={t('ccAgent.workdirBrowse.docSearch.prev')}
          disabled={!query || total === 0}
          onClick={onPrev}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded',
            'hover:bg-titlebar-button-hover',
            'disabled:opacity-40 disabled:hover:bg-transparent',
            'focus-visible:outline-none',
          )}
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          aria-label={t('ccAgent.workdirBrowse.docSearch.next')}
          disabled={!query || total === 0}
          onClick={onNext}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded',
            'hover:bg-titlebar-button-hover',
            'disabled:opacity-40 disabled:hover:bg-transparent',
            'focus-visible:outline-none',
          )}
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          aria-label={t('ccAgent.workdirBrowse.docSearch.close')}
          onClick={onClose}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded',
            'hover:bg-titlebar-button-hover',
            'focus-visible:outline-none',
          )}
        >
          <X size={14} />
        </button>
      </div>
    );
  },
);
