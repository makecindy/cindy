/**
 * PreRunPluginFields — 「前置检查」选插件时的两项设置(定时任务与伙伴例行任务共用)。
 * ---------------------------------------------------------------------------
 * 插件下拉只列本机已启用、声明了该运行前检查且用户已批准的插件；任务里保存的插件后来
 * 不可用时仍作为一项保留显示，不悄悄换掉。出错处理由用户在这里按任务选择。
 * 颜色只用语义 token,Light / Dark 由主题变量自动适配。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  GHOST_CONTROL_POINTS,
  type GhostControlPointCandidate,
  type GhostControlPointFailureAction,
} from '../../../../shared/ghost';

type PreRunPoint = 'will-schedule-run' | 'will-routine-run' | 'will-start-task';

export function usePreRunPluginCandidates(point: PreRunPoint, enabled = true): GhostControlPointCandidate[] | null {
  const [candidates, setCandidates] = useState<GhostControlPointCandidate[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // 页面开着时装上、更新、启停或卸载插件，候选也要跟着变。
    const refresh = () => {
      window.electronAPI.ghosts
        .listControlPointCandidates(point)
        .then((list) => alive && setCandidates(list))
        .catch(() => alive && setCandidates([]));
    };
    refresh();
    const off = window.electronAPI.ghosts.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [point, enabled]);
  return candidates;
}

export function PreRunPluginFields({
  point,
  pluginId,
  onFailure,
  onPluginChange,
  onFailureChange,
  className,
}: {
  point: PreRunPoint;
  pluginId: string;
  onFailure: GhostControlPointFailureAction;
  onPluginChange(pluginId: string): void;
  onFailureChange(action: GhostControlPointFailureAction): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const candidates = usePreRunPluginCandidates(point);

  // 新开启插件来源时自动选上唯一可选的插件，少一步操作。
  useEffect(() => {
    if (!pluginId && candidates?.length === 1) onPluginChange(candidates[0].pluginId);
  }, [candidates, pluginId, onPluginChange]);

  if (candidates === null) return null;
  const saved = pluginId && !candidates.some((item) => item.pluginId === pluginId);
  if (candidates.length === 0 && !saved) {
    return (
      <p className={cn('text-xs leading-[1.5] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]', className)}>
        {t('scheduler.editor.preRunPlugin.empty')}
      </p>
    );
  }

  const pluginOptions = [
    ...(saved ? [{ value: pluginId, label: t('scheduler.editor.preRunPlugin.unavailable') }] : []),
    ...candidates.map((item) => ({ value: item.pluginId, label: item.name })),
  ];
  const failureOptions = GHOST_CONTROL_POINTS[point].failureActions.map((action) => ({
    value: action,
    label: t(`scheduler.editor.preRunPlugin.onFailure.${action}`),
  }));

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Select
          // 还没选时 Radix 以 label 作占位文字。
          label={t('scheduler.editor.preRunPlugin.choose')}
          value={pluginId}
          options={pluginOptions}
          onValueChange={onPluginChange}
          truncateOptions
          className="min-w-[160px] max-w-[260px] flex-1"
        />
        {/* 标签与下拉作为一组换行，窄面板里不会把标签留在上一行。 */}
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
            {t('scheduler.editor.preRunPlugin.onFailureLabel')}
          </span>
          <Select
            label={t('scheduler.editor.preRunPlugin.onFailureLabel')}
            value={onFailure}
            options={failureOptions}
            onValueChange={(value) => onFailureChange(value as GhostControlPointFailureAction)}
          />
        </div>
      </div>
      <p className="text-xs leading-[1.5] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
        {saved ? t('scheduler.editor.preRunPlugin.unavailableHint') : t('scheduler.editor.preRunPlugin.hint')}
      </p>
    </div>
  );
}
