import { helpSettings } from './HelpSection.settings-search';
import { Button } from '@/components/ui/button';
import { GitBranch, MessageSquareText, Sparkles, Download } from 'lucide-react';
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
const sectionDescClass = 'mt-1 text-12 leading-[1.6] text-[var(--text-secondary)]';

export function HelpSection({ onAskHelp }: HelpSectionProps) {
  const { t } = useTranslation();
  const isLinux = window.electronAPI?.platform === 'linux';

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
            <div id={helpSettings.gettingStartedTitle.targetId} className={sectionTitleClass}>{t(helpSettings.gettingStartedTitle.titleKey)}</div>
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
            <div id={helpSettings.workflowsTitle.targetId} className={sectionTitleClass}>{t(helpSettings.workflowsTitle.titleKey)}</div>
            <p className={sectionDescClass}>{t(helpSettings.workflowsTitle.descriptionKey)}</p>
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
            <div id={helpSettings.recommendedWaysTitle.targetId} className={sectionTitleClass}>{t(helpSettings.recommendedWaysTitle.titleKey)}</div>
            <p className={sectionDescClass}>{t(helpSettings.recommendedWaysTitle.descriptionKey)}</p>
            <ul className="mt-2 space-y-1.5 text-13 leading-[1.6] text-[var(--settings-section-title)]">
              <li>{t('settings.help.recommendedWays.item1')}</li>
              <li>{t('settings.help.recommendedWays.item2')}</li>
              <li>{t('settings.help.recommendedWays.item3')}</li>
            </ul>
          </div>
        </div>
      </div>

      {isLinux ? (
        <div className={cardClass}>
          <div className="flex items-start gap-3">
            <Download size={16} className="mt-0.5 shrink-0 text-[var(--settings-section-title)]" />
            <div className="min-w-0">
              <div id={helpSettings.linuxUpdatesTitle.targetId} className={sectionTitleClass}>{t(helpSettings.linuxUpdatesTitle.titleKey)}</div>
              <p className={sectionDescClass}>{t(helpSettings.linuxUpdatesTitle.descriptionKey)}</p>
              <ul className="mt-2 space-y-1.5 text-13 leading-[1.6] text-[var(--settings-section-title)]">
                <li>{t('settings.help.linuxUpdates.item1')}</li>
                <li>{t('settings.help.linuxUpdates.item2')}</li>
                <li>{t('settings.help.linuxUpdates.item3')}</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      <div className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div id={helpSettings.qnaTitle.targetId} className={sectionTitleClass}>{t(helpSettings.qnaTitle.titleKey)}</div>
            <p className={sectionDescClass}>{t('settings.help.qnaDescription')}</p>
          </div>
          <Button data-setting-id={helpSettings.qnaTitle.id}
            variant="secondary"
            size="md"
            compact
            type="button"
            onClick={onAskHelp}
            className="shrink-0"
          >
            {t('settings.help.openAssistant')}
          </Button>
        </div>
      </div>
    </div>
  );
}
