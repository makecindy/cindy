/**
 * 「+」面板里「添加目录…」的二级页：先列最近使用的项目目录，点一下即加为可读写目录；
 * 底部「选择其他文件夹」再打开系统选择器。与顶部项目选择器同一份最近目录数据
 * (useProjectPickerOptions)，在「+」的 MorphPopover 里原地替换主面板，宽度与行样式沿用主面板。
 *
 * 键盘：↑↓ 移动、Enter 选中；搜索框为空时退格、或点左上角返回回到主面板(与主面板「空框退格往回退」一致)。
 * Esc 由 MorphPopover 统一关闭整个面板。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Folder as FolderIcon, FolderPlus, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ErrorNotice } from '@/components/ui/error-notice';
import { MORPH_CONTENT_RESIZE_EVENT } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import { MENU_CURRENT_ROW_ATTR, currentMarkedRow } from '@/components/ui/dropdown-menu-highlight';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { useProjectPickerOptions } from '@/hooks/useProjectPickerOptions';
import { filterFolderPickerOptions, type FolderPickerOption } from './FolderPickerPopover';
import { selectableRecentExtraDirs } from './extraDirsActions';

/** 可聚焦行(最近目录 + 「选择其他文件夹」)的标记，按 DOM 顺序与 focusedIndex 对应。 */
const ROW_ATTR = 'data-add-dir-row';

/** 与项目选择器一致:超过 4 个目录才需要搜索。 */
const SEARCH_MIN_COUNT = 5;

/** 行尾位置提示：所在目录的最后两级(完整路径放悬停提示)，让单行行高也能区分同名目录。 */
function parentHint(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const parent = parts.slice(0, -1);
  if (parent.length === 0) return '';
  return parent.length > 2 ? `…/${parent.slice(-2).join('/')}` : `/${parent.join('/')}`;
}

interface AddDirectoryPanelProps {
  /** 已添加的目录(只读 + 可写)，最近列表里不再出现。 */
  addedDirs: readonly string[];
  workingDir?: string | null;
  onBack: () => void;
  /** 选中最近目录；授权失败时 reject，面板显示错误并留在本页。 */
  onSelectRecent: (option: FolderPickerOption) => Promise<void>;
  /** 打开系统选择器；用户取消时面板留在本页。 */
  onBrowse: () => Promise<void>;
}

export function AddDirectoryPanel({
  addedDirs,
  workingDir,
  onBack,
  onSelectRecent,
  onBrowse,
}: AddDirectoryPanelProps) {
  const { t } = useTranslation();
  const projectOptions = useProjectPickerOptions();
  const recentOptions = useMemo(
    () => selectableRecentExtraDirs(projectOptions, { addedDirs, workingDir }),
    [projectOptions, addedDirs, workingDir],
  );
  const [query, setQuery] = useState('');
  const showSearch = recentOptions.length >= SEARCH_MIN_COUNT;
  const visibleOptions = useMemo(
    () => filterFolderPickerOptions(recentOptions, showSearch ? query : ''),
    [recentOptions, showSearch, query],
  );
  // 最后一个可聚焦行是「选择其他文件夹」。
  const rowCount = visibleOptions.length + 1;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const pendingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const highlightPanelRef = useMenuPanel(panelRef, {
    lockWidth: false,
    options: {
      current: currentMarkedRow,
      currentAttributes: [MENU_CURRENT_ROW_ATTR],
      keyboardSource: document,
    },
  });
  const focusedRowRef = useRef<HTMLButtonElement>(null);

  // 主面板的搜索框随切页卸载，焦点要接到本页：有搜索框给搜索框，否则给面板根(承接方向键)。
  useEffect(() => {
    (searchRef.current ?? rootRef.current)?.focus();
  }, [showSearch]);

  // 与主面板原地互换、列表或错误提示变化时，请「+」弹层重量尺寸：内容变高会被弹层的
  // 高度钳住，它的 ResizeObserver 看不到增长(见 MORPH_CONTENT_RESIZE_EVENT)。
  useLayoutEffect(() => {
    rootRef.current?.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
  }, [visibleOptions.length, showSearch, failed]);

  useEffect(() => {
    if (focusedIndex >= rowCount) setFocusedIndex(Math.max(0, rowCount - 1));
  }, [focusedIndex, rowCount]);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusedIndex]);

  const run = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const activate = (index: number) => {
    const option = visibleOptions[index];
    void run(option ? () => onSelectRecent(option) : onBrowse);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const fromSearch = event.target === searchRef.current;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (focusedIndex + step + rowCount) % rowCount;
      setFocusedIndex(next);
      // 焦点已在某一行(Tab 进来)时真实焦点跟着走，否则回车会落在原来那行、加的不是高亮目录。
      if (event.target instanceof HTMLElement && event.target.hasAttribute(ROW_ATTR)) {
        rootRef.current?.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)[next]?.focus();
      }
      return;
    }
    // 行按钮自己处理 Enter；这里只接搜索框与面板根上的 Enter。
    if (event.key === 'Enter' && (fromSearch || event.target === rootRef.current)) {
      event.preventDefault();
      activate(focusedIndex);
      return;
    }
    if (event.key === 'Backspace' && (event.target === rootRef.current || (fromSearch && !query))) {
      event.preventDefault();
      onBack();
    }
  };

  const rowClass = (disabled?: boolean) =>
    cn(
      COMPOSER_MENU_ROW,
      'flex w-full items-center gap-2 px-[10px] text-left',
      disabled && 'cursor-not-allowed opacity-50',
    );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-composer-suggestion-panel=""
      data-morph-scroll="inner"
      // 整页都是面板自己的输入面：焦点落在这里(含搜索框)时编辑器失焦不能把面板关掉。
      data-composer-suggestion-search=""
      onKeyDown={handleKeyDown}
      aria-busy={pending}
      // 外壳锁成不滚后，会把量到的确定高度写到本层的 style.height 上。
      // 没有外壳时高度仍是 auto，独立挂载按内容撑开。
      className="pointer-events-auto relative flex min-h-0 max-h-full flex-1 flex-col outline-none"
    >
      <div
        ref={highlightPanelRef}
        {...menuPanelAttrs}
        // 标题、搜索框与「选择其他文件夹」固定，只有目录列表滚动(与项目选择器一致)。
        // 高度由外层 MorphPopover 的确定高度经 flex-1 传下来；不用 h-full，
        // 否则父层只有 max-h-full 时高度仍是 auto，列表会按全部内容撑高 (#9536)。
        className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden p-[6px]"
      >
        <MenuHighlightLayer />
        <div className="flex h-[32px] items-center gap-1 pb-[2px]">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onBack}
            aria-label={t('extraDirs.back')}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--cmd-palette-item-hover)]',
              'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-0 truncate text-14 font-medium text-[var(--cmd-palette-item-text)]">
            {t('extraDirs.addTitle')}
          </span>
          <Tip text={t('extraDirs.writableHintDetail')} side="top">
            <span className="ml-auto shrink-0 pr-[6px] text-12 text-[var(--cmd-palette-item-meta)]">
              {t('extraDirs.writableHint')}
            </span>
          </Tip>
        </div>
        {/* 有搜索框时省掉分组标题：新建任务页面板只有 240px，标题再占一行列表就只剩两行多。 */}
        {!showSearch && (
          <div className="flex h-[24px] items-center px-[10px] text-12 font-medium text-[var(--cmd-palette-item-meta)]">
            {t('newChat.folderPicker.recent')}
          </div>
        )}
        {showSearch && (
          <div className="px-[4px] pb-[6px]">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cmd-palette-item-meta)]"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setFocusedIndex(0);
                }}
                placeholder={t('extraDirs.searchRecent')}
                aria-label={t('extraDirs.searchRecent')}
                className={cn(
                  'h-8 w-full rounded-full border border-[var(--cmd-palette-border)] bg-transparent',
                  'pl-7 pr-2 text-13 text-[var(--cmd-palette-item-text)] outline-none',
                  'placeholder:text-[var(--text-placeholder)]',
                  'focus:border-[var(--chat-input-border-focus)]',
                )}
              />
            </div>
          </div>
        )}
        <div
          role="list"
          aria-label={t('newChat.folderPicker.recent')}
          // 标题和「选择其他文件夹」固定，只有这一层在上面那个确定高度里滚动 (#9536)。
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        >
          {visibleOptions.map((option, index) => (
            <button
              key={option.path}
              ref={index === focusedIndex ? focusedRowRef : undefined}
              type="button"
              disabled={pending}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setFocusedIndex(index)}
              onFocus={() => setFocusedIndex(index)}
              {...{ [ROW_ATTR]: '' }}
              onClick={() => activate(index)}
              {...menuRowAttrs({ current: index === focusedIndex, disabled: pending })}
              // 与「+」主面板动作行同高的单行：新建任务页面板高度只有 240px，两行行高放不下几个目录。
              className={cn(rowClass(pending), 'shrink-0 py-2')}
            >
              <FolderIcon size={14} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
              {withMenuLabels(<span className="min-w-0 shrink truncate">{option.name}</span>)}
              <Tip text={option.description ?? option.path} mono>
                <span className="ml-auto min-w-0 shrink-[2] truncate pl-2 text-12 font-normal text-[var(--cmd-palette-item-meta)]">
                  {parentHint(option.path)}
                </span>
              </Tip>
            </button>
          ))}
          {visibleOptions.length === 0 && (
            <div
              role="status"
              className="flex h-[40px] select-none items-center px-[10px] text-13 text-[var(--cmd-palette-empty)]"
            >
              {query && showSearch ? t('extraDirs.noMatchingRecent') : t('extraDirs.noRecent')}
            </div>
          )}
        </div>
        {failed && (
          <ErrorNotice
            role="alert"
            className="mx-[4px] my-[4px]"
            message={t('extraDirs.addFailed')}
          />
        )}
        <div role="separator" className="my-[6px] border-t border-[var(--cmd-palette-border)]" />
        <button
          ref={focusedIndex === rowCount - 1 ? focusedRowRef : undefined}
          type="button"
          disabled={pending}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setFocusedIndex(rowCount - 1)}
          onFocus={() => setFocusedIndex(rowCount - 1)}
          {...{ [ROW_ATTR]: '' }}
          onClick={() => activate(rowCount - 1)}
          {...menuRowAttrs({ current: focusedIndex === rowCount - 1, disabled: pending })}
          className={cn(rowClass(pending), 'shrink-0 py-2')}
        >
          <FolderPlus size={14} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
          {withMenuLabels(
            <span className="min-w-0 flex-1 truncate">
              {t('newChat.folderPicker.browseFolder')}
            </span>,
          )}
        </button>
      </div>
    </div>
  );
}
