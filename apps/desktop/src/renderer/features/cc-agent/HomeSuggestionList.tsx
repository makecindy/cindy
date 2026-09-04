import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  Code2,
  FileText,
  FolderDown,
  FolderGit2,
  Gauge,
  Hammer,
  HardDrive,
  Receipt,
  Shuffle,
  Sparkles,
  Wallet,
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  type HomeSuggestionId,
  homeSuggestionBatch,
  homeSuggestionLabelKey,
  isHomeSuggestionsHidden,
  nextHomeSuggestionBatch,
  setHomeSuggestionsHidden,
} from './homeSuggestions';

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
};

export function HomeSuggestionList({
  narrow,
  onSelect,
}: {
  narrow: boolean;
  onSelect: (id: HomeSuggestionId) => void;
}) {
  const { t } = useTranslation();
  const [batchIndex, setBatchIndex] = useState(0);
  const [hidden, setHidden] = useState(isHomeSuggestionsHidden);

  const batch = useMemo(() => homeSuggestionBatch(batchIndex), [batchIndex]);
  const visible = narrow ? batch.slice(0, 2) : batch;

  if (hidden) return null;

  return (
    <div data-testid="home-suggestions" className="group/sug mt-4 w-full">
      <div className="flex flex-col items-start gap-px">
        {visible.map((id) => {
          const Icon = ICONS[id];
          return (
            <button
              key={id}
              type="button"
              data-testid={`home-suggestion-${id}`}
              onClick={() => onSelect(id)}
              className={cn(
                'inline-flex h-[38px] max-w-full items-center gap-2.5 rounded-full px-3',
                'text-14 text-[var(--text-secondary)] transition-colors',
                'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={16} strokeWidth={2} className="shrink-0 text-current" />
              <span className="min-w-0 truncate">{t(homeSuggestionLabelKey(id))}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-1.5">
        <button
          type="button"
          data-testid="home-suggestions-shuffle"
          onClick={() => setBatchIndex((index) => nextHomeSuggestionBatch(index))}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-12',
            'text-[var(--text-tertiary)] opacity-0 transition-opacity',
            'group-hover/sug:opacity-100 hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
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
            'text-[var(--text-tertiary)] opacity-0 transition-opacity',
            'group-hover/sug:opacity-100 hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
          )}
        >
          <X size={11} strokeWidth={2} />
          {t('newChat.homeSuggestions.dismiss')}
        </button>
      </div>
    </div>
  );
}
