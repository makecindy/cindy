import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { MarketSkill } from '../hooks/useMarketList';
import { skillPublisherLabel } from '../lib/publisherLabel';
import { SkillIcon } from './SkillIcon';
import { SkillTagList } from './SkillTagList';

export function HomeMarketCard({ skill: s, onClick }: {
  skill: MarketSkill;
  onClick: (skill: MarketSkill) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onClick(s)}
      className={cn(
        'group flex min-h-[100px] flex-col gap-1.5 rounded-[12px] border-[0.5px] border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-3 text-left shadow-[var(--plugin-card-shadow)]',
        'transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
        'active:translate-y-0 active:scale-[0.992]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <div className="flex items-center gap-2">
        <SkillIcon url={s.icon} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--msg-assistant-text)]">
          {s.displayName || s.name}
        </span>
        <SkillTagList tags={s.tags} maxVisible={1} className="shrink-0" />
        {s.installedLocally && (
          <span className="shrink-0 rounded-full bg-[var(--chat-input-chip-bg)] px-1.5 py-0.5 text-10 text-[var(--cmd-palette-item-meta)]">
            {t('skillhub.home.installed')}
          </span>
        )}
      </div>
      {s.description && (
        <p className="line-clamp-2 text-xs text-[var(--cmd-palette-item-meta)]">
          {s.description}
        </p>
      )}
      <div className="flex items-center gap-2 text-11 text-[var(--cmd-palette-item-meta)]">
        <span className="min-w-0 truncate">{skillPublisherLabel(s)}</span>
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <Download size={11} />
          {s.downloads}
        </span>
      </div>
    </button>
  );
}
