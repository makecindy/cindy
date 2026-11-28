import { Lightbulb } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { SettingsPageHeader } from '@/components/ui/settings-rows';

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
    <div className="flex flex-col gap-2">
      <SettingsPageHeader
        title={t(imBotSettings.imBot.sectionKey)}
        adornment={<Badge tone="outline" size="xs" className="bg-[var(--settings-badge-bg)]">
          {t('settings.imBot.beta')}
        </Badge>}
      />
      {context}
      <div key={contentKey} className="mt-4 flex flex-col gap-8">
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
        className="text-14 font-medium leading-[1.4] text-[var(--settings-section-title)]"
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
