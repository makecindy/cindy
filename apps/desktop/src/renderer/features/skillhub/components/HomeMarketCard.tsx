import { hasDownloadCount } from '../lib/downloads';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { MarketSkill } from '../hooks/useMarketList';
import { skillPublisherLabel } from '../lib/publisherLabel';
import { SkillIcon } from './SkillIcon';
import { SkillTagList } from './SkillTagList';
import { MarketInstallStatus, type MarketInstallStatusProps } from './MarketInstallStatus';

export function HomeMarketCard({ skill: s, onClick, onUpdate, updating }: MarketInstallStatusProps & {
  onClick: (skill: MarketSkill) => void;
}) {
  const { t, i18n } = useTranslation();
  const downloads = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(s.downloads);
  return (
    <div
      onClick={() => onClick(s)}
      className={cn(
        'group flex min-h-[108px] w-full min-w-0 cursor-pointer items-start gap-4 rounded-xl border border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-4 text-left',
        'transition-colors duration-150 hover:border-[var(--text-tertiary)]',
      )}
    >
      <div className="shrink-0 [&>span]:size-12 [&_svg]:size-6">
        <SkillIcon url={s.icon} categories={s.categories} tags={s.tags} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col self-stretch gap-1">
        <div className="flex min-h-6 min-w-0 items-start justify-between gap-2">
          <button type="button" title={s.displayName || s.name}
            onClick={(event) => { event.stopPropagation(); onClick(s); }}
            style={{ lineHeight: 20 / 15 }}
            className="min-w-0 truncate text-left text-15 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            {s.displayName || s.name}
          </button>
          <MarketInstallStatus skill={s} onUpdate={onUpdate} updating={updating} />
        </div>
        {s.description && <p title={s.description} style={{ lineHeight: 20 / 13 }} className="min-w-0 line-clamp-2 text-13 text-[var(--text-tertiary)]">{s.description}</p>}
        <div style={{ lineHeight: 16 / 11 }} className="mt-auto flex min-h-6 min-w-0 items-center gap-2 text-11 text-[var(--text-tertiary)]">
          <SkillTagList tags={s.tags} maxVisible={1} className="shrink-0 max-w-[50%]" />
          <span className="min-w-0 truncate" title={skillPublisherLabel(s)}>{skillPublisherLabel(s)}</span>
          {hasDownloadCount(s) && <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums" title={t('skillhub.marketCard.downloadsLabel')} aria-label={t('skillhub.marketCard.downloadsLabel')}>
            <Download size={12} aria-hidden="true" />{downloads}
          </span>}
        </div>
      </div>
    </div>
  );
}
