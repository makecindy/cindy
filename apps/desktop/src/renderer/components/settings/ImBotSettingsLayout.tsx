import { Lightbulb } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsPageHeader, SETTINGS_SECTION_TITLE_CLASS } from '@/components/ui/settings-rows';

import type { ImBotSettingsGroup } from './ImBotSection';
import { imBotSettings } from './ImBotSection.settings-search';

/** Presentation only: each target supplies its own controllers and connection context. */
export function ImBotSettingsFrame({
  children,
  context,
  contentKey,
}: {
  children: ReactNode;
  context?: ReactNode;
  contentKey?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title={t(imBotSettings.imBot.sectionKey)}
        adornment={<span className="rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-px text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
          {t('settings.imBot.beta')}
        </span>}
      />
      {context}
      <div key={contentKey} className="flex flex-col gap-9">
        {children}
      </div>
    </div>
  );
}

export function ImBotGroupSection({
  group,
  children,
  sectionRef,
  idPrefix = '',
}: {
  /** 「插件」分区不是 ?imGroup= 深链目标，但和其他分区同一套标题与 Tips。 */
  group: ImBotSettingsGroup | 'plugins';
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const headingId = `${idPrefix}im-bot-group-heading-${group}`;
  return (
    <section
      ref={sectionRef}
      id={`${idPrefix}im-bot-group-${group}`}
      aria-labelledby={headingId}
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <h3
        id={headingId}
        className={SETTINGS_SECTION_TITLE_CLASS}
        data-settings-section-heading
        tabIndex={-1}
      >
        {t(`settings.imBot.groups.${group}`)}
      </h3>
      <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-chip)] px-3.5 py-2.5">
        <Lightbulb size={14} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
        <p className="text-12 leading-[1.6] text-[var(--text-secondary)]">
          {t(`settings.imBot.tips.${group}`)}
        </p>
      </div>
      {children}
    </section>
  );
}
