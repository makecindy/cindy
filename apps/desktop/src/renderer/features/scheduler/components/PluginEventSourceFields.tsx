/**
 * PluginEventSourceFields — 自动化「事件」触发选择插件提供的事件（收到消息、新邮件等）。
 * ---------------------------------------------------------------------------
 * 只列本机已启用、声明了事件的插件；任务里保存的插件后来不可用时仍保留显示，不悄悄去掉。
 * 勾选插件 = 全部事件；也可以只勾其中几种。「只看」条件按插件声明的字段筛选（例如只看某个会话或某个人），
 * 同一插件内的条件全部满足才触发。
 * 规则见 docs/product-rules/plugin-event-triggers.md。颜色只用语义 token，Light / Dark 自动适配。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  PLUGIN_EVENT_FILTER_OPERATORS,
  PLUGIN_EVENT_LIMITS,
  type PluginEventFilterOperator,
  type SchedulePluginEventFilter,
  type SchedulePluginEventSource,
} from '@cindy/maker-scheduler/plugin-events';
import type { GhostEventSourceCandidate } from '../../../../shared/ghost';
import {
  pluginCheckState,
  pluginEventChecked,
  setPluginEventSelected,
  setPluginFilters,
  setPluginSelected,
} from '../lib/pluginEventSelection';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

/** 本机可选的插件事件来源；装上、更新、启停或卸载插件时跟着刷新。 */
export function usePluginEventSources(enabled = true): GhostEventSourceCandidate[] | null {
  const [sources, setSources] = useState<GhostEventSourceCandidate[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const ghosts = window.electronAPI.ghosts;
    const refresh = () => {
      // Remote-control windows and older preloads may not expose the local listing.
      if (typeof ghosts?.listEventSources !== 'function') {
        setSources([]);
        return;
      }
      ghosts
        .listEventSources()
        .then((list) => alive && setSources(list))
        .catch(() => alive && setSources([]));
    };
    refresh();
    const off = typeof ghosts?.onChanged === 'function' ? ghosts.onChanged(refresh) : () => undefined;
    return () => {
      alive = false;
      off();
    };
  }, [enabled]);
  return sources;
}

/** 「只看」条件：字段 + 等于 / 包含 / 不等于 + 值。空值的条件不保存。 */
function PluginFilterRows({
  fields,
  filters,
  onChange,
}: {
  fields: readonly string[];
  filters: readonly SchedulePluginEventFilter[];
  onChange(next: SchedulePluginEventFilter[]): void;
}) {
  const { t } = useTranslation();
  const declared = [...new Set(fields)];
  if (!declared.length && !filters.length) return null;
  const update = (index: number, patch: Partial<SchedulePluginEventFilter>) =>
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)));
  const fieldLabel = t('scheduler.editor.webhook.plugin.filterField');
  const operatorLabel = t('scheduler.editor.webhook.plugin.filterOperator');
  const valueLabel = t('scheduler.editor.webhook.plugin.filterValue');
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 pl-6">
      {filters.map((filter, index) => {
        const options = [...new Set([...declared, filter.field])].map((field) => ({ value: field, label: field }));
        return (
          <div key={index} className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={hintClass}>{t('scheduler.editor.webhook.plugin.filterOnly')}</span>
            <Select label={fieldLabel} size="compact" width="sm" className="min-w-0 shrink" value={filter.field} options={options}
              onValueChange={(field) => update(index, { field })} />
            <Select label={operatorLabel} size="compact" width="xs" value={filter.operator}
              options={PLUGIN_EVENT_FILTER_OPERATORS.map((operator) => ({ value: operator, label: t(`scheduler.editor.webhook.plugin.operators.${operator}`) }))}
              onValueChange={(operator) => update(index, { operator: operator as PluginEventFilterOperator })} />
            <Input aria-label={valueLabel} className="min-w-[120px] flex-1" value={filter.value}
              maxLength={PLUGIN_EVENT_LIMITS.filterValueChars} onChange={(text) => update(index, { value: text })} />
            <Button variant="secondary" tone="quiet" size="sm" compact aria-label={t('scheduler.editor.webhook.plugin.filterRemove')}
              onClick={() => onChange(filters.filter((_, i) => i !== index))}>
              <X size={14} aria-hidden />
            </Button>
          </div>
        );
      })}
      {declared.length > 0 && filters.length < PLUGIN_EVENT_LIMITS.filtersPerSource && (
        <div>
          <Button variant="secondary" tone="quiet" size="sm" compact
            onClick={() => onChange([...filters, { field: declared[0]!, operator: 'equals', value: '' }])}>
            <Plus size={14} aria-hidden />
            {t('scheduler.editor.webhook.plugin.filterAdd')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PluginEventSourceFields({
  value,
  candidates,
  onChange,
}: {
  value: readonly SchedulePluginEventSource[];
  candidates: readonly GhostEventSourceCandidate[] | null;
  onChange(next: SchedulePluginEventSource[]): void;
}) {
  const { t } = useTranslation();
  if (candidates === null) return <p className={hintClass}>{t('ccAgent.common.loading')}</p>;
  const missing = value.filter((source) => !candidates.some((candidate) => candidate.plugin === source.plugin));

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-13 font-medium text-[var(--text-primary)]">
        {t('scheduler.editor.webhook.plugin.label')}
      </legend>
      {candidates.length === 0 && missing.length === 0 && (
        <p className={hintClass}>{t('scheduler.editor.webhook.plugin.empty')}</p>
      )}
      {candidates.map((candidate) => {
        const state = pluginCheckState(value, candidate.plugin);
        const filters = value.find((source) => source.plugin === candidate.plugin)?.filters ?? [];
        return (
          <div key={candidate.plugin} className="min-w-0 rounded-xl border border-[var(--border-default)] px-3 py-2">
            <label className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 text-13 text-[var(--text-primary)]">
              <Checkbox
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onChange={(event) => onChange(setPluginSelected(value, candidate.plugin, event.target.checked))}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{candidate.name}</span>
              <span className={`shrink-0 ${hintClass}`}>
                {t(`scheduler.editor.webhook.plugin.state.${candidate.state}`)}
              </span>
            </label>
            <div className="flex min-w-0 flex-col pl-6">
              {candidate.events.map((event) => (
                <label
                  key={event.type}
                  className="flex min-h-8 min-w-0 cursor-pointer items-center gap-2 text-13 text-[var(--text-primary)]"
                >
                  <Checkbox
                    checked={pluginEventChecked(value, candidate.plugin, event.type)}
                    onChange={(change) =>
                      onChange(setPluginEventSelected(value, candidate, event.type, change.target.checked))}
                  />
                  <span className="min-w-0 truncate">{event.name}</span>
                </label>
              ))}
            </div>
            {state !== 'none' && (
              <PluginFilterRows
                fields={candidate.events.flatMap((event) => event.fields)}
                filters={filters}
                onChange={(next) => onChange(setPluginFilters(value, candidate.plugin, next))}
              />
            )}
          </div>
        );
      })}
      {missing.map((source) => (
        <div
          key={source.plugin}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-[var(--border-default)] px-3 py-2 text-13"
        >
          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={source.plugin}>
            {t('scheduler.editor.webhook.plugin.unavailable')}
          </span>
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            compact
            className="shrink-0"
            onClick={() => onChange(setPluginSelected(value, source.plugin, false))}
          >
            {t('scheduler.editor.webhook.plugin.remove')}
          </Button>
        </div>
      ))}
      <p className={hintClass}>{t('scheduler.editor.webhook.plugin.hint')}</p>
    </fieldset>
  );
}
