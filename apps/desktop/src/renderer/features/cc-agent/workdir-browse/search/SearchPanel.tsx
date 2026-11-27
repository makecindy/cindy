/**
 * SearchPanel — 文件侧栏的搜索状态
 *
 * 内部三段（从上到下）：
 *   1. Input Area      padding [4, 12, 8, 12]  gap:6  → 共享 SearchInput（panel 档）+ 「Aa」大小写开关
 *   2. Results Header  padding [8, 12, 4, 24]
 *      左:"23 results in 5 files"  Inter 12 / 500 / Stone(#737373)
 *      右:list-tree 14×14 #737373
 *   3. Results Tree    padding:4  gap:1   → SearchResults
 *
 * 状态文本(空查询 / 搜索中 / 无结果 / truncated / error)走 Results Header
 * 同一行的左侧文字位 — 设计稿这一行是计数,我们复用它做状态展示,避免再多一行
 * 视觉跳变。
 */

import { cn } from '@/lib/utils';
import { ListTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SearchInput } from '@/components/ui/search-input';
import { Tip } from '@/components/ui/tooltip';
import { SearchResults } from './SearchResults';
import type { FileResult, SearchStatus } from './hooks/useProjectSearch';

export interface SearchPanelProps {
  query: string;
  onQueryChange: (next: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (next: boolean) => void;

  results: FileResult[];
  totalMatches: number;
  totalFiles: number;
  status: SearchStatus;
  errorMessage: string | null;
  /** 稳定错误码(如 RG_UNAVAILABLE),优先于 errorMessage 映射友好文案。 */
  errorCode?: string | null;
  /** 1000 等硬上限,在 truncated 时拼出 "1000+ results, refine your query"。 */
  maxMatches: number;

  onOpenMatch: (relPath: string, lineNumber: number) => void;
}

export function SearchPanel({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  results,
  totalMatches,
  totalFiles,
  status,
  errorMessage,
  errorCode = null,
  maxMatches,
  onOpenMatch,
}: SearchPanelProps) {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;
  const placeholder = t('ccAgent.workdirBrowse.searchPanel.placeholderSearch');
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* 1. Input Area — pt-1 pr-3 pb-2 pl-3 = [4, 12, 8, 12] */}
      <div className="pt-1 pr-3 pb-2 pl-3">
        {/* 共享搜索框 panel 档（主人裁决 2026-11-27：所有搜索框都有清空）。Esc 清空是这里原有的
            行为，保留；data-workdir-search-input 是 doc 模式 Ctrl+Shift+F 跨组件聚焦的钩子
            （见 WorkdirBrowseSidebar 的 'workdir-open-project-search' 监听）。 */}
        <SearchInput
          surface="panel"
          value={query}
          onChange={onQueryChange}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              onQueryChange('');
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          data-workdir-search-input=""
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          trailing={
            <MatchCaseToggle value={caseSensitive} onChange={onCaseSensitiveChange} />
          }
        />
      </div>

      {/* 2. Results Header — padding [8, 12, 4, 24] */}
      <div className="flex items-center justify-between pt-2 pr-3 pb-1 pl-6">
        <span className="min-w-0 truncate text-12 font-medium text-sidebar-muted">
          <StatusText
            hasQuery={hasQuery}
            status={status}
            totalMatches={totalMatches}
            totalFiles={totalFiles}
            maxMatches={maxMatches}
            errorMessage={errorMessage}
            errorCode={errorCode}
          />
        </span>
        {hasQuery && totalMatches > 0 && (
          <span className="shrink-0 text-sidebar-action-icon">
            <ListTree size={14} strokeWidth={2} />
          </span>
        )}
      </div>

      {/* 3. Results Tree — padding:4(uniform) gap:1。
          虚拟化:滚动容器在 SearchResults 内部(useVirtualizer 要求),所以这里
          只给固定高度(min-h-0 + flex-1) + padding,不再加 overflow-y-auto,
          避免双层滚动。横向截断由 SearchResults 自己 overflow-x-hidden 兜住。 */}
      <div className={cn('min-h-0 flex-1 p-1')}>
        <SearchResults results={results} onOpenMatch={onOpenMatch} />
      </div>
    </div>
  );
}

interface StatusTextProps {
  hasQuery: boolean;
  status: SearchStatus;
  totalMatches: number;
  totalFiles: number;
  maxMatches: number;
  errorMessage: string | null;
  errorCode: string | null;
}

function StatusText({
  hasQuery,
  status,
  totalMatches,
  totalFiles,
  maxMatches,
  errorMessage,
  errorCode,
}: StatusTextProps) {
  const { t } = useTranslation();
  if (!hasQuery) return <>{t('ccAgent.workdirBrowse.searchPanel.empty')}</>;
  if (status === 'searching' && totalMatches === 0) return <>{t('ccAgent.workdirBrowse.searchPanel.searching')}</>;
  if (status === 'error') {
    // 按稳定码映射友好文案(规则 9:不做 message 字符串匹配);无码回落原始 message。
    const text =
      errorCode === 'RG_UNAVAILABLE'
        ? t('ccAgent.workdirBrowse.searchPanel.rgUnavailable')
        : (errorMessage ?? t('ccAgent.workdirBrowse.searchPanel.failed'));
    return <span className="text-[var(--error-fg)]">{text}</span>;
  }
  if (status === 'truncated') {
    return <>{t('ccAgent.workdirBrowse.searchPanel.truncated', { max: maxMatches, files: totalFiles })}</>;
  }
  if (status === 'done' && totalMatches === 0) return <>{t('ccAgent.workdirBrowse.searchPanel.noResults')}</>;
  return (
    <>
      {t('ccAgent.workdirBrowse.searchPanel.summary', { count: totalMatches })}
      {' '}
      {t('ccAgent.workdirBrowse.searchPanel.inFile', { count: totalFiles })}
    </>
  );
}

/** 「Aa」区分大小写开关：22×22，开启时用侧栏选中底。排在搜索框清空按钮右侧。 */
function MatchCaseToggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Tip
      text={
        value
          ? t('ccAgent.workdirBrowse.searchPanel.matchCaseOn')
          : t('ccAgent.workdirBrowse.searchPanel.matchCaseOff')
      }
    >
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-label={t('ccAgent.workdirBrowse.searchPanel.matchCaseAria')}
        aria-pressed={value}
        className={cn(
          'flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-lg px-1',
          'text-11 font-semibold leading-none transition-colors',
          value
            ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
            : 'text-sidebar-muted hover:bg-sidebar-item-hover hover:text-foreground',
        )}
      >
        Aa
      </button>
    </Tip>
  );
}
