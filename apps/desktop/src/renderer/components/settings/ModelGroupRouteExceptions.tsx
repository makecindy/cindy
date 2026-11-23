/**
 * 路线详情里的「例外」：在按选法挑之前先看这些情况——消息里有图片时只用能看图的来源，某个时段(可只在某几天)改走
 * 另一条路线。每条例外写成一句话；改动经 onChange 立即保存。规则见 docs/product-rules/model-groups.md §3.2。
 */
import { useCallback, useMemo, useState } from 'react';
import { Clock, Image as ImageIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SettingsBlock, SettingsCard, SettingsRow, SettingsRowIcon, SettingsSection } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { MODEL_GROUP_LIMITS, type ModelGroupException, type ModelGroupRoute } from '../../../shared/modelGroups';
import { modelGroupsSettings } from './ModelGroupsSection.settings-search';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

interface HoursDraft {
  from: number;
  to: number;
  routeId: string;
  /** 选中的星期(Date#getDay)；空 = 每天。 */
  days: number[];
}

/**
 * 一周七天按这种语言的习惯排(周一或周日开头)，名字用系统的短写法。说明句里连着的三天及以上写成一段
 * (周一至周五)，其余逐个列出。
 */
function useWeekdays(locale: string, range: (from: string, to: string) => string) {
  return useMemo(() => {
    let firstDay = 1;
    try {
      const info = (new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?(): { firstDay: number }; weekInfo?: { firstDay: number } });
      firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1;
    } catch {
      firstDay = 1;
    }
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    // 2023-01-01 是星期日：加 day 天就是 Date#getDay() === day 的那一天。
    const name = (day: number) => format.format(Date.UTC(2023, 0, 1 + day));
    const start = firstDay % 7;
    const order = Array.from({ length: 7 }, (_, i) => (start + i) % 7);
    const list = new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' });
    const describe = (days: readonly number[]) => {
      const parts: string[] = [];
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 3) parts.push(range(name(run[0]), name(run[run.length - 1])));
        else parts.push(...run.map(name));
        run = [];
      };
      for (const day of order) {
        if (days.includes(day)) run.push(day);
        else flush();
      }
      flush();
      return list.format(parts);
    };
    return { order: order.map((day) => ({ day, label: name(day) })), describe };
  }, [locale, range]);
}

export function ModelGroupRouteExceptions({
  route,
  routes,
  onChange,
}: {
  route: ModelGroupRoute;
  /** 全部路线；时段例外只能改走别的路线。 */
  routes: readonly ModelGroupRoute[];
  onChange(next: ModelGroupException[]): Promise<boolean> | void;
}) {
  const { t, i18n } = useTranslation();
  const dayRange = useCallback(
    (from: string, to: string) => t('modelGroups.settings.exceptions.dayRange', { from, to }),
    [t],
  );
  const weekdays = useWeekdays(i18n.resolvedLanguage ?? i18n.language, dayRange);
  const [draft, setDraft] = useState<HoursDraft | null>(null);
  const exceptions = route.exceptions ?? [];
  const others = routes.filter((item) => item.id !== route.id);
  const hasImage = exceptions.some((item) => item.when.type === 'image');
  const full = exceptions.length >= MODEL_GROUP_LIMITS.exceptions;

  const sentence = (item: ModelGroupException) => {
    if (item.when.type === 'image' || item.use === 'vision') return t('modelGroups.settings.exceptions.imageRule');
    const target = routes.find((other) => other.id === item.use.routeId)?.name ?? '';
    const values = { from: hourLabel(item.when.from), to: hourLabel(item.when.to), name: target };
    return item.when.days?.length
      ? t('modelGroups.settings.exceptions.hoursRuleDays', { ...values, days: weekdays.describe(item.when.days) })
      : t('modelGroups.settings.exceptions.hoursRule', values);
  };

  const add = (kind: string) => {
    if (kind === 'image' && !hasImage) void onChange([...exceptions, { when: { type: 'image' }, use: 'vision' }]);
    if (kind === 'hours' && others[0]) setDraft({ from: 23, to: 8, routeId: others[0].id, days: [] });
  };
  const commitDraft = async () => {
    if (!draft || draft.from === draft.to) return;
    // 七天全选与一天不选一样是每天，不存星期。
    const days = draft.days.length > 0 && draft.days.length < 7 ? [...draft.days].sort((a, b) => a - b) : undefined;
    const added: ModelGroupException = {
      when: { type: 'hours', from: draft.from, to: draft.to, ...(days ? { days } : {}) },
      use: { type: 'route', routeId: draft.routeId },
    };
    if ((await onChange([...exceptions, added])) !== false) setDraft(null);
  };
  const hourOptions = HOURS.map((hour) => ({ value: String(hour), label: hourLabel(hour) }));
  const removeLabel = t('modelGroups.settings.exceptions.remove');

  return (
    <SettingsSection title={t('modelGroups.settings.exceptions.title')} description={t('modelGroups.settings.exceptions.hint')}>
      <SettingsCard data-testid="model-group-exceptions">
        {exceptions.map((item, index) => {
          const Icon = item.when.type === 'image' ? ImageIcon : Clock;
          return (
            <SettingsRow
              key={item.when.type === 'image' ? 'image' : `hours-${item.when.from}-${item.when.to}-${index}`}
              media
              data-model-group-exception={item.when.type}
              lead={<SettingsRowIcon><Icon size={16} aria-hidden /></SettingsRowIcon>}
              title={sentence(item)}
              trailing={
                <Tip text={removeLabel}>
                  <button
                    type="button"
                    aria-label={removeLabel}
                    onClick={() => void onChange(exceptions.filter((_, i) => i !== index))}
                    data-settings-search-action="Removes one exception from a route"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
                  >
                    <X size={15} />
                  </button>
                </Tip>
              }
            />
          );
        })}
        {exceptions.length === 0 && !draft && (
          <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.exceptions.empty')}</SettingsBlock>
        )}
        {draft ? (
          <SettingsBlock className="flex flex-col gap-3" data-testid="model-group-exception-draft">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="flex items-center gap-2 text-13 leading-[1.5] text-[var(--text-secondary)]">
                {t('modelGroups.settings.exceptions.from')}
                <Select
                  data-setting-id={modelGroupsSettings.routes.id}
                  label={t('modelGroups.settings.exceptions.from')}
                  value={String(draft.from)}
                  options={hourOptions}
                  size="compact"
                  className="w-[104px]"
                  onValueChange={(value) => setDraft({ ...draft, from: Number(value) })}
                />
              </span>
              <span className="flex items-center gap-2 text-13 leading-[1.5] text-[var(--text-secondary)]">
                {t('modelGroups.settings.exceptions.to')}
                <Select
                  data-setting-id={modelGroupsSettings.routes.id}
                  label={t('modelGroups.settings.exceptions.to')}
                  value={String(draft.to)}
                  options={hourOptions}
                  size="compact"
                  className="w-[104px]"
                  onValueChange={(value) => setDraft({ ...draft, to: Number(value) })}
                />
              </span>
              <span className="flex min-w-0 items-center gap-2 text-13 leading-[1.5] text-[var(--text-secondary)]">
                {t('modelGroups.settings.exceptions.useRoute')}
                <Select
                  data-setting-id={modelGroupsSettings.routes.id}
                  label={t('modelGroups.settings.exceptions.useRoute')}
                  value={draft.routeId}
                  options={others.map((item) => ({ value: item.id, label: item.name }))}
                  size="compact"
                  truncateOptions
                  className="w-[180px]"
                  onValueChange={(routeId) => setDraft({ ...draft, routeId })}
                />
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-13 leading-[1.5] text-[var(--text-secondary)]" id="model-group-exception-days">
                {t('modelGroups.settings.exceptions.days')}
              </span>
              <div role="group" aria-labelledby="model-group-exception-days" data-testid="model-group-exception-days"
                className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-full bg-[var(--segmented-track)] p-0.5">
                {weekdays.order.map(({ day, label }) => {
                  const on = draft.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      data-model-group-day={day}
                      data-settings-search-action="Limits the time exception being edited to some days of the week"
                      onClick={() => setDraft({ ...draft, days: on ? draft.days.filter((item) => item !== day) : [...draft.days, day] })}
                      className={cn(
                        'h-7 min-w-10 rounded-full border px-2.5 text-13 leading-[1.38] outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                        on
                          ? 'border-[var(--segmented-selected-border)] bg-[var(--segmented-selected-bg)] font-medium text-[var(--text-primary)]'
                          : 'border-transparent text-[var(--segmented-option-fg)] hover:text-[var(--text-primary)] active:opacity-80',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t('modelGroups.settings.exceptions.daysHint')}</span>
            </div>
            {draft.from === draft.to && (
              <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t('modelGroups.settings.exceptions.sameHour')}</span>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="md" onClick={() => setDraft(null)}
                data-settings-search-action="Cancels a time exception that has not been added">
                {t('modelGroups.settings.cancel')}
              </Button>
              <Button variant="primary" size="md" disabled={draft.from === draft.to} onClick={() => void commitDraft()}
                data-settings-search-action="Adds the time exception being edited to this route">
                {t('modelGroups.settings.exceptions.addHours')}
              </Button>
            </div>
          </SettingsBlock>
        ) : (
          <SettingsRow
            title={t('modelGroups.settings.exceptions.add')}
            hint={full
              ? t('modelGroups.settings.exceptions.full', { count: MODEL_GROUP_LIMITS.exceptions })
              : others.length === 0 ? t('modelGroups.settings.exceptions.needOtherRoute') : undefined}
            wrap
            trailing={
              <Select
                data-setting-id={modelGroupsSettings.routes.id}
                label={t('modelGroups.settings.exceptions.choose')}
                value=""
                disabled={full}
                options={[
                  { value: 'image', label: t('modelGroups.settings.exceptions.kindImage'), disabled: hasImage },
                  { value: 'hours', label: t('modelGroups.settings.exceptions.kindHours'), disabled: others.length === 0 },
                ]}
                width="sm"
                onValueChange={add}
              />
            }
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
