import { GitBranch, MessageSquareText, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface HelpSectionProps {
  onAskHelp: () => void;
}

const cardClass = cn(
  'rounded-xl border border-[var(--settings-theme-card-border)]',
  'bg-[var(--settings-theme-card-bg)]',
  'px-[18px] py-4',
);

const sectionTitleClass = 'text-13 font-medium leading-[1.3] text-[var(--settings-section-title)]';
const sectionDescClass = 'mt-1 text-12 leading-[1.6] text-[var(--settings-section-sublabel)] opacity-80';

export function HelpSection({ onAskHelp }: HelpSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.help.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.help.description')}
        </p>
      </div>

      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--settings-section-title)]" />
          <div className="min-w-0">
            <div className={sectionTitleClass}>{t('settings.help.gettingStarted.title')}</div>
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-13 leading-[1.6] text-[var(--settings-section-title)]">
              <li>{t('settings.help.gettingStarted.step1')}</li>
              <li>{t('settings.help.gettingStarted.step2')}</li>
              <li>{t('settings.help.gettingStarted.step3')}</li>
            </ol>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <GitBranch size={16} className="mt-0.5 shrink-0 text-[var(--settings-section-title)]" />
          <div className="min-w-0">
            <div className={sectionTitleClass}>{t('settings.help.workflows.title')}</div>
            <p className={sectionDescClass}>{t('settings.help.workflows.description')}</p>
            <ul className="mt-2 space-y-1.5 text-13 leading-[1.6] text-[var(--settings-section-title)]">
              <li>{t('settings.help.workflows.item1')}</li>
              <li>{t('settings.help.workflows.item2')}</li>
              <li>{t('settings.help.workflows.item3')}</li>
            </ul>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <MessageSquareText size={16} className="mt-0.5 shrink-0 text-[var(--settings-section-title)]" />
          <div className="min-w-0">
            <div className={sectionTitleClass}>{t('settings.help.recommendedWays.title')}</div>
            <p className={sectionDescClass}>{t('settings.help.recommendedWays.description')}</p>
            <ul className="mt-2 space-y-1.5 text-13 leading-[1.6] text-[var(--settings-section-title)]">
              <li>{t('settings.help.recommendedWays.item1')}</li>
              <li>{t('settings.help.recommendedWays.item2')}</li>
              <li>{t('settings.help.recommendedWays.item3')}</li>
            </ul>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className={sectionTitleClass}>{t('settings.help.qnaTitle')}</div>
            <p className={sectionDescClass}>{t('settings.help.qnaDescription')}</p>
          </div>
          <button
            type="button"
            onClick={onAskHelp}
            className="shrink-0 rounded-full border border-[var(--settings-theme-card-border)] px-4 py-2 text-12 font-medium text-[var(--settings-section-title)] transition-colors hover:bg-[var(--settings-theme-card-border)]/40"
          >
            {t('settings.help.openAssistant')}
          </button>
        </div>
      </div>
    </div>
  );
}
