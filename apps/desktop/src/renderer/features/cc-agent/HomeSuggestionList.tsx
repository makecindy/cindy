import { Button } from '@/components/ui/button';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  BookOpen,
  CalendarCheck,
  Code2,
  Eye,
  FileText,
  FolderDown,
  FolderGit2,
  Folders,
  Gamepad2,
  Gauge,
  Hammer,
  HardDrive,
  Images,
  MessageSquarePlus,
  Newspaper,
  Puzzle,
  Receipt,
  Shuffle,
  Sparkles,
  TrendingUp,
  Wallet,
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  type HomeSuggestionId,
  isHomeSuggestionsHidden,
  setHomeSuggestionsHidden,
} from './homeSuggestions';
import {
  buildHomeTaskCatalog,
  nextHomeTaskBatch,
  readPluginRecommendationSnapshot,
  type HomeTaskBatch,
  type HomeTaskSuggestion,
} from './pluginHomeSuggestions';

const ICONS: Record<HomeSuggestionId, LucideIcon> = {
  downloadsDesktop: FolderDown,
  whatCindyCanDo: Sparkles,
  recentDocs: FileText,
  listCodeProjects: Code2,
  storageUsage: HardDrive,
  unusedApps: AppWindow,
  uncommittedChanges: FolderGit2,
  devEnvironment: Hammer,
  whySlow: Gauge,
  diagnoseNetwork: Wifi,
  subscriptionSpend: Receipt,
  expenseTracker: Wallet,
  stockDigest: TrendingUp,
  morningBrief: Newspaper,
  watchWebpage: Eye,
  kidsGame: Gamepad2,
  habitTracker: CalendarCheck,
  organizeFolder: Folders,
  photoTimeline: Images,
  photoAlbumPage: Images,
  exploreRepo: BookOpen,
  initAgentDoc: FileText,
  makePlugin: Puzzle,
  sendFeedback: MessageSquarePlus,
  readOwnSource: Code2,
};

export function HomeSuggestionList({
  narrow,
  onSelect,
  onPluginSelect,
  onPreviewChange,
  includePlugins = true,
}: {
  narrow: boolean;
  onSelect: (id: HomeSuggestionId) => void;
  onPluginSelect?: (suggestion: HomeTaskSuggestion) => void;
  /** 悬停/聚焦某条建议时报告该条目,离开时报告 null;由调用方算出与点击填入一致的预览文字。 */
  onPreviewChange?: (suggestion: HomeTaskSuggestion | null) => void;
  includePlugins?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const batchSize = narrow ? 2 : 4;
  const draw = (previous: HomeTaskBatch | null) => {
    const snapshot = readPluginRecommendationSnapshot();
    return nextHomeTaskBatch(
      buildHomeTaskCatalog(
        snapshot,
        i18n?.resolvedLanguage ?? i18n?.language ?? 'en',
        t,
        includePlugins && !!onPluginSelect,
      ),
      snapshot,
      previous,
      batchSize,
    );
  };
  const [batch, setBatch] = useState(() => draw(null));
  const [hidden, setHidden] = useState(isHomeSuggestionsHidden);
  // 行在悬停中被卸载(隐藏、换批、整块被替换)时收不到 mouseleave,由这里兜底清掉预览。
  const onPreviewChangeRef = useRef(onPreviewChange);
  onPreviewChangeRef.current = onPreviewChange;
  useEffect(() => () => onPreviewChangeRef.current?.(null), []);
  // 悬停与键盘焦点各自记录:预览取悬停项,没有悬停时回落到焦点项,两者都没有才清空。
  // 点击(填入)视为本次交互结束,两者一起清掉,直到再次移入/聚焦。
  const hoveredRef = useRef<HomeTaskSuggestion | null>(null);
  const focusedRef = useRef<HomeTaskSuggestion | null>(null);
  const emitPreview = () => onPreviewChange?.(hoveredRef.current ?? focusedRef.current);
  const resetPreview = () => {
    hoveredRef.current = null;
    focusedRef.current = null;
    emitPreview();
  };
  const descriptionIdPrefix = useId();

  if (batchSize > batch.displayedCount) {
    setBatch({ ...batch, displayedCount: batchSize });
  }
  const visible = batch.items.slice(0, batchSize);
  // 预览只能指向当前仍显示的条目:窄屏裁掉行、换一批等让行离开 DOM 时收不到可靠的
  // mouseleave / blur,这里按可见集合统一清掉失效的悬停 / 焦点项。
  const visibleKey = visible.map((item) => item.id).join('\n');
  useEffect(() => {
    const visibleIds = new Set(visibleKey.split('\n'));
    let changed = false;
    if (hoveredRef.current && !visibleIds.has(hoveredRef.current.id)) {
      hoveredRef.current = null;
      changed = true;
    }
    if (focusedRef.current && !visibleIds.has(focusedRef.current.id)) {
      focusedRef.current = null;
      changed = true;
    }
    if (changed) emitPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- emitPreview 每次渲染重建,只在可见集合变化时核对
  }, [visibleKey]);

  if (hidden) return null;

  return (
    <div data-testid="home-suggestions" className="group/sug mt-4 w-full">
      <div className="flex flex-col items-start gap-px">
        {visible.map((item) => {
          const { id } = item;
          const Icon = item.builtinId ? ICONS[item.builtinId] : Puzzle;
          return (
            <Fragment key={id}>
              <button
                type="button"
                data-testid={`home-suggestion-${id}`}
                // 输入框里的视觉预览对读屏隐藏;完整 prompt 通过描述关联到按钮本身。
                aria-describedby={`${descriptionIdPrefix}-${id}`}
                onClick={() => {
                  resetPreview();
                  if (item.builtinId) onSelect(item.builtinId);
                  else onPluginSelect?.(item);
                }}
                onMouseEnter={() => {
                  hoveredRef.current = item;
                  emitPreview();
                }}
                onMouseLeave={() => {
                  hoveredRef.current = null;
                  emitPreview();
                }}
                onFocus={() => {
                  focusedRef.current = item;
                  emitPreview();
                }}
                onBlur={() => {
                  focusedRef.current = null;
                  emitPreview();
                }}
                className={cn(
                  'inline-flex h-[38px] max-w-full items-center gap-2.5 rounded-full px-3',
                  'text-14 text-[var(--text-secondary)] transition-colors',
                  'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                )}
              >
                <Icon size={16} strokeWidth={2} className="shrink-0 text-current" />
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
              {/* 放在按钮外,只作描述,不并入按钮名称。 */}
              <span id={`${descriptionIdPrefix}-${id}`} className="sr-only">
                {item.prompt}
              </span>
            </Fragment>
          );
        })}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-1.5">
        <Button
          variant="secondary"
          size="xs"
          compact
          tone="quiet"
          type="button"
          data-testid="home-suggestions-shuffle"
          onClick={() => {
            resetPreview();
            setBatch((previous) => draw(previous));
          }}
          className="opacity-0 group-hover/sug:opacity-100 focus-visible:opacity-100"
        >
          <Shuffle size={11} strokeWidth={2} />
          {t('newChat.homeSuggestions.shuffle')}
        </Button>
        <Button
          variant="secondary"
          size="xs"
          compact
          tone="quiet"
          type="button"
          data-testid="home-suggestions-dismiss"
          onClick={() => {
            resetPreview();
            setHomeSuggestionsHidden(true);
            setHidden(true);
          }}
          className="opacity-0 group-hover/sug:opacity-100 focus-visible:opacity-100"
        >
          <X size={11} strokeWidth={2} />
          {t('newChat.homeSuggestions.dismiss')}
        </Button>
      </div>
    </div>
  );
}
