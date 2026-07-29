import type { ComponentType } from 'react';
import {
  Blocks,
  Code2,
  FileSpreadsheet,
  Globe2,
  Image,
  LoaderCircle,
  MessageSquareCode,
  SearchCode,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type NewMakerQuickStartKey =
  | 'appsAndTools'
  | 'docsAndData'
  | 'designAndImages'
  | 'webSearch'
  | 'exploreProject'
  | 'buildFeature'
  | 'reviewCode'
  | 'fixIssue';

export interface NewMakerQuickStartItem {
  key: NewMakerQuickStartKey;
  labelKey: string;
  kickoffKey: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

export const DIALOGUE_QUICK_STARTS: readonly NewMakerQuickStartItem[] = [
  {
    key: 'appsAndTools',
    labelKey: 'newChat.createAgent.quickStarts.dialogue.appsAndTools.label',
    kickoffKey: 'newChat.createAgent.quickStarts.dialogue.appsAndTools.kickoff',
    icon: Blocks,
  },
  {
    key: 'docsAndData',
    labelKey: 'newChat.createAgent.quickStarts.dialogue.docsAndData.label',
    kickoffKey: 'newChat.createAgent.quickStarts.dialogue.docsAndData.kickoff',
    icon: FileSpreadsheet,
  },
  {
    key: 'designAndImages',
    labelKey: 'newChat.createAgent.quickStarts.dialogue.designAndImages.label',
    kickoffKey: 'newChat.createAgent.quickStarts.dialogue.designAndImages.kickoff',
    icon: Image,
  },
  {
    key: 'webSearch',
    labelKey: 'newChat.createAgent.quickStarts.dialogue.webSearch.label',
    kickoffKey: 'newChat.createAgent.quickStarts.dialogue.webSearch.kickoff',
    icon: Globe2,
  },
] as const;

export const PROJECT_QUICK_STARTS: readonly NewMakerQuickStartItem[] = [
  {
    key: 'exploreProject',
    labelKey: 'newChat.createAgent.quickStarts.project.explore.label',
    kickoffKey: 'newChat.createAgent.quickStarts.project.explore.kickoff',
    icon: SearchCode,
  },
  {
    key: 'buildFeature',
    labelKey: 'newChat.createAgent.quickStarts.project.build.label',
    kickoffKey: 'newChat.createAgent.quickStarts.project.build.kickoff',
    icon: Code2,
  },
  {
    key: 'reviewCode',
    labelKey: 'newChat.createAgent.quickStarts.project.review.label',
    kickoffKey: 'newChat.createAgent.quickStarts.project.review.kickoff',
    icon: MessageSquareCode,
  },
  {
    key: 'fixIssue',
    labelKey: 'newChat.createAgent.quickStarts.project.fix.label',
    kickoffKey: 'newChat.createAgent.quickStarts.project.fix.kickoff',
    icon: Wrench,
  },
] as const;

interface NewMakerQuickStartsProps {
  workspaceKind: 'dialogue' | 'project';
  narrow: boolean;
  medium: boolean;
  busyKey: NewMakerQuickStartKey | null;
  onSelect: (item: NewMakerQuickStartItem) => void;
}

/**
 * Empty-state intent launchers for the New Task page. The route owns session
 * creation; this component only renders the context-appropriate cards.
 */
export function NewMakerQuickStarts({
  workspaceKind,
  narrow,
  medium,
  busyKey,
  onSelect,
}: NewMakerQuickStartsProps): React.ReactElement {
  const { t } = useTranslation();
  const items = workspaceKind === 'project' ? PROJECT_QUICK_STARTS : DIALOGUE_QUICK_STARTS;

  return (
    <div data-testid="create-agent-quick-starts" className="mt-[42px] w-full">
      <div className="mb-2.5 px-0.5">
        <div className="select-none text-[14px] font-medium leading-[18px] text-[var(--text-secondary)]">
          {t('newChat.createAgent.quickStart')}
        </div>
      </div>
      <div
        className={cn(
          'grid w-full gap-3',
          narrow ? 'grid-cols-1' : medium ? 'grid-cols-2' : 'grid-cols-4',
        )}
      >
        {items.map((item) => {
          const isBusy = busyKey === item.key;
          const disabled = busyKey !== null;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelect(item)}
              disabled={disabled}
              aria-busy={isBusy || undefined}
              className={cn(
                'group flex flex-col items-start justify-between gap-1 rounded-xl border border-[var(--create-agent-quick-card-border)] bg-[var(--create-agent-quick-card-bg)] text-left text-[var(--create-agent-quick-card-text)] transition-[background-color,transform] hover:bg-[var(--create-agent-quick-card-bg-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
                narrow ? 'min-h-[84px] p-3' : 'min-h-[112px] p-4',
              )}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--create-agent-quick-card-icon-bg)]">
                {isBusy ? (
                  <span className="inline-flex animate-spin motion-reduce:animate-none">
                    <LoaderCircle
                      size={20}
                      strokeWidth={1.75}
                      className="text-[var(--create-agent-quick-card-icon)]"
                    />
                  </span>
                ) : (
                  <Icon
                    size={20}
                    strokeWidth={1.75}
                    className="text-[var(--create-agent-quick-card-icon)]"
                  />
                )}
              </span>
              <span className="w-full min-w-0 select-none text-13 font-semibold leading-[16px]">
                {isBusy ? t('newChat.createAgent.quickStarts.starting') : t(item.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
