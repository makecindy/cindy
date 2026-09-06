import { useState } from 'react';
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
  includePlugins = true,
}: {
  narrow: boolean;
  onSelect: (id: HomeSuggestionId) => void;
  onPluginSelect?: (suggestion: HomeTaskSuggestion) => void;
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

  if (batchSize > batch.displayedCount) {
    setBatch({ ...batch, displayedCount: batchSize });
  }
  const visible = batch.items.slice(0, batchSize);

  if (hidden) return null;

  return (
    <div data-testid="home-suggestions" className="group/sug mt-4 w-full">
      <div className="flex flex-col items-start gap-px">
        {visible.map((item) => {
          const { id } = item;
          const Icon = item.builtinId ? ICONS[item.builtinId] : Puzzle;
          return (
            <button
              key={id}
              type="button"
              data-testid={`home-suggestion-${id}`}
              onClick={() => (item.builtinId ? onSelect(item.builtinId) : onPluginSelect?.(item))}
              className={cn(
                'inline-flex h-[38px] max-w-full items-center gap-2.5 rounded-full px-3',
                'text-14 text-[var(--text-secondary)] transition-colors',
                'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={16} strokeWidth={2} className="shrink-0 text-current" />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-1.5">
        <button
          type="button"
          data-testid="home-suggestions-shuffle"
          onClick={() => setBatch((previous) => draw(previous))}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-12',
            'text-[var(--text-secondary)] opacity-0 transition-opacity',
            'group-hover/sug:opacity-100 hover:bg-[var(--surface-hover)]',
          )}
        >
          <Shuffle size={11} strokeWidth={2} />
          {t('newChat.homeSuggestions.shuffle')}
        </button>
        <button
          type="button"
          data-testid="home-suggestions-dismiss"
          onClick={() => {
            setHomeSuggestionsHidden(true);
            setHidden(true);
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-12',
            'text-[var(--text-secondary)] opacity-0 transition-opacity',
            'group-hover/sug:opacity-100 hover:bg-[var(--surface-hover)]',
          )}
        >
          <X size={11} strokeWidth={2} />
          {t('newChat.homeSuggestions.dismiss')}
        </button>
      </div>
    </div>
  );
}
