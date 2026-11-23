/**
 * PluginEventSourceFields — 自动化「事件」触发选择插件提供的事件（收到消息、新邮件等）。
 * ---------------------------------------------------------------------------
 * 只列本机已启用、声明了事件的插件；任务里保存的插件后来不可用时仍保留显示，不悄悄去掉。
 * 勾选插件 = 全部事件；也可以只勾其中几种。字段条件（filters）由 Agent 设置，这里只提示并原样保留。
 * 规则见 docs/product-rules/plugin-event-triggers.md。颜色只用语义 token，Light / Dark 自动适配。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { SchedulePluginEventSource } from '@cindy/maker-scheduler/plugin-events';
import type { GhostEventSourceCandidate } from '../../../../shared/ghost';
import {
  pluginCheckState,
  pluginEventChecked,
  setPluginEventSelected,
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
        const filters = value.find((source) => source.plugin === candidate.plugin)?.filters?.length ?? 0;
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
            {filters > 0 && (
              <p className={`pl-6 ${hintClass}`}>{t('scheduler.editor.webhook.plugin.filters', { count: filters })}</p>
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
