import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Folder, MessageCircle, Timer, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { agentKindToVendor } from '@/components/sidebar/VendorIcon';
import { AgentSelect } from '@/components/new-chat/AgentSelect';
import {
  addRecentFolder,
  FolderPickerPopover,
  type FolderPickerOption,
} from '@/components/new-chat/FolderPickerPopover';
import { useDetectCwd } from '@/hooks/useWorktreeQueries';
import { useAgentCapabilities, type ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { ModelIconMark, ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { useModelDiscoveryPending } from '@/components/new-chat/useModelDiscoveryPending';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  nativeDefaultSourceId,
} from '@cindy/model-providers';
import * as sessionService from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';
import {
  getProjectPickerDisplayName,
  getProjectPickerEmptyLabelKey,
} from '@/hooks/useProjectPickerOptions';
import {
  configToCron,
  cronExprToIntervalMs,
  cronToConfig,
  DEFAULT_SCHEDULE_INTERVAL_MS,
  resolveScheduleTimingPresentation,
  summarizeConfig,
  switchScheduleTimingMode,
  WEEKDAY_LABELS,
  DEFAULT_CONFIG,
  type CodexScheduleConfig,
} from '../lib/cronCodexPreset';
import { getScheduleDefaultModel, type EffortValue } from '../hooks/useScheduleForm';
import {
  isFollowingSessionSelection,
  PENDING_SESSION_ID,
  usesBoundSessionModel,
} from '../lib/scheduleFormLogic';
import type { SessionReference } from '../../../../shared/sessionReference';
import { isReviewSessionSource } from '../../../../shared/sessionSource';

export type Destination = 'local' | 'worktree' | 'thread';
export type AgentKind = 'claude-code' | 'codex' | 'pi';

interface ChipButtonProps {
  icon?: React.ReactNode;
  label?: string;
  disabled?: boolean;
  active?: boolean;
  variant?: 'toolbar' | 'pill';
  className?: string;
  onClick?: () => void;
}

export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(function ChipButton(
  { icon, label, disabled, active, variant = 'toolbar', className, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-[34px] shrink-0 items-center rounded-full text-13 leading-none transition-colors',
        'gap-1.5 px-3',
        variant === 'toolbar'
          ? cn(
              'border border-transparent bg-transparent',
              active
                ? 'text-[var(--msg-assistant-text)]'
                : 'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)] dark:hover:text-[var(--msg-assistant-text)]',
            )
          : active
            ? 'border border-[var(--settings-source-meta)] bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] dark:border-[var(--settings-input-placeholder)] dark:bg-[var(--chat-input-chip-bg)] dark:text-[var(--msg-assistant-text)]'
            : 'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] text-[var(--settings-btn-secondary-text)] hover:border-[var(--settings-source-meta)] hover:text-[var(--msg-assistant-text)] dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)] dark:text-[var(--settings-section-desc)] dark:hover:border-[var(--settings-input-placeholder)] dark:hover:text-[var(--msg-assistant-text)]',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...rest}
    >
      {icon && <span className="shrink-0 -translate-y-px">{icon}</span>}
      {label && <span className="truncate text-center text-13 font-normal leading-[1.33]">{label}</span>}
      <ChevronDown size={13} className="shrink-0 opacity-60" />
    </button>
  );
});

const POPOVER_BASE = cn(
  'z-[10010] rounded-xl border p-2 shadow-lg',
  'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]',
);

function stopWheel(e: React.WheelEvent) {
  e.stopPropagation();
}

export function ProjectChip({
  value,
  workspaceKind,
  onChange,
  onChangeWorkspaceKind,
  projectOptions,
  disabled,
  onChangeDestination,
}: {
  value: string;
  workspaceKind: 'project' | 'dialogue';
  onChange: (v: string) => void;
  onChangeWorkspaceKind: (v: 'project' | 'dialogue') => void;
  projectOptions: readonly FolderPickerOption[];
  disabled?: boolean;
  onChangeDestination?: (v: Destination) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const display = useMemo(() => {
    if (workspaceKind === 'dialogue') return t(getProjectPickerEmptyLabelKey('generic'));
    return getProjectPickerDisplayName(value, projectOptions) ?? t('newChat.folderPicker.selectProject');
  }, [projectOptions, t, value, workspaceKind]);

  const handleSelect = (path: string, source: 'project' | 'recent' | 'browse' | 'dialogue') => {
    if (source === 'dialogue') {
      onChangeWorkspaceKind('dialogue');
      onChange('');
      onChangeDestination?.('local');
      return;
    }
    if (source !== 'project') addRecentFolder(path);
    onChangeWorkspaceKind('project');
    onChange(path);
    onChangeDestination?.('local');
  };

  return (
    <FolderPickerPopover
      open={open}
      onOpenChange={(v) => !disabled && setOpen(v)}
      onSelect={handleSelect}
      projectOptions={projectOptions}
      align="start"
      sideOffset={6}
      collisionPadding={16}
    >
      <ChipButton
        icon={workspaceKind === 'dialogue' ? <MessageCircle size={14} /> : <Folder size={14} />}
        label={display}
        active={open}
        disabled={disabled}
        variant="pill"
        className="[&>span:nth-child(2)]:min-w-[94px] max-w-[220px] gap-[7px]"
      />
    </FolderPickerPopover>
  );
}

/**
 * Scheduler compatibility adapter: keep the persisted scheduler kind shape,
 * while sharing the same AgentSelect dropdown used by IM settings and chat.
 */
export function AgentTabs({ value, onChange, disabled }: { value: AgentKind; onChange: (v: AgentKind) => void; disabled?: boolean }) {
  return (
    <AgentSelect
      value={agentKindToVendor(value)}
      disabled={disabled}
      side="top"
      // ScheduleFormDialog 是 Radix modal。MorphPopover 的 custom portal 不在
      // Dialog focus scope 内，动画结束聚焦选中项时会被拉回并立即自动收起；
      // 此处使用 Radix Popover，让嵌套焦点与 outside-interaction 语义正确组合。
      useMorphPopover={false}
      overlayContentClassName="z-[10010]"
      onChange={(vendor) => {
        onChange(vendor === 'cc' ? 'claude-code' : vendor === 'pi' ? 'pi' : 'codex');
      }}
    />
  );
}

export function ScheduleSettingsButton({
  cwd,
  enabled,
  onEnabledChange,
  lockEnabled = false,
}: {
  cwd: string | null;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** true → 隐藏 worktree on/off toggle。 */
  lockEnabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detect = useDetectCwd(cwd);

  const cantUseReason = useMemo<string | null>(() => {
    if (detect.loading) return t('scheduler.chips.branchHints.detecting');
    if (!detect.data) return null;
    if (!detect.data.gitInstalled) return t('scheduler.chips.branchHints.gitMissing');
    if (!detect.data.isGitRepo) return t('scheduler.chips.branchHints.notRepo');
    if (detect.data.isInsideWorktree) return t('scheduler.chips.branchHints.insideWorktree');
    return null;
  }, [detect.data, detect.loading, t]);

  const switchDisabled = !!cantUseReason || detect.loading || !cwd;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full transition-colors',
            enabled
              ? 'text-[var(--msg-assistant-text)]'
              : 'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--confirm-btn-secondary-hover)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)] dark:hover:text-[var(--msg-assistant-text)]',
          )}
          aria-label={t('scheduler.chips.advancedAria')}
          aria-pressed={enabled}
        >
          <SlidersHorizontal size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        className={cn(POPOVER_BASE, 'w-[240px]')}
        onWheel={stopWheel}
      >
        <div className="px-2 pt-1.5 pb-1 text-13 font-medium text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
          {t('scheduler.chips.advanced')}
        </div>

        {enabled && (
          <p className="px-2 pb-1 text-11 leading-4 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
            {t('scheduler.chips.worktreeHint')}
          </p>
        )}

        {!lockEnabled && (
        <Tip text={switchDisabled && cantUseReason ? cantUseReason : null} side="top" contentClassName="z-[10020]">
          <button
            type="button"
            onClick={() => !switchDisabled && onEnabledChange(!enabled)}
            disabled={switchDisabled}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-13 transition-colors',
              'hover:bg-[var(--surface-hover)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              enabled ? 'text-[var(--msg-assistant-text)] dark:text-[var(--msg-assistant-text)]' : 'text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]',
            )}
            aria-pressed={enabled}
            aria-label={t('scheduler.chips.useWorktreeAria')}
          >
            <span
              className={cn(
                'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded border-[1.5px] transition-colors',
                enabled
                  ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                  : 'border-[var(--cmd-palette-item-meta)] bg-transparent',
              )}
            >
              {enabled && (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-[10px] w-[10px]">
                  <path d="M3 8l3.5 3.5L13 5" />
                </svg>
              )}
            </span>
            <span>{t('scheduler.chips.worktree')}</span>
          </button>
        </Tip>
        )}
      </PopoverContent>
    </Popover>
  );
}

type EditableScheduleMenuMode =
  | 'intervalMinutes'
  | 'interval'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly';
type ScheduleMenuMode = EditableScheduleMenuMode | 'exactInterval';

// Note: these mode strings mirror codex i18n keys (settings.automations.scheduleMode.*),
// kept stable as IDs. Display labels are looked up via t('scheduler.chips.scheduleMenu.<mode>').
// Minutes 放最前 — 是最灵活 / 最高频的调度粒度，适合开发/调试场景
const SCHEDULE_MENU_MODES: ReadonlyArray<EditableScheduleMenuMode> = [
  'intervalMinutes',
  'interval',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
];

const INTERVAL_MENU_MODES: ReadonlyArray<EditableScheduleMenuMode> = [
  'intervalMinutes',
  'interval',
];

function formatIntervalDuration(intervalMs: number, locale: string): string {
  const units: ReadonlyArray<{ factor: number; unit: string }> = [
    { factor: 24 * 60 * 60_000, unit: 'day' },
    { factor: 60 * 60_000, unit: 'hour' },
    { factor: 60_000, unit: 'minute' },
    { factor: 1_000, unit: 'second' },
    { factor: 1, unit: 'millisecond' },
  ];
  const selected = units.find(({ factor }) => intervalMs % factor === 0) ?? units[units.length - 1];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: selected.unit,
    unitDisplay: 'long',
  }).format(intervalMs / selected.factor);
}

const WEEKDAY_SHORT: Record<number, string> = {
  1: 'Mo',
  2: 'Tu',
  3: 'We',
  4: 'Th',
  5: 'Fr',
  6: 'Sa',
  0: 'Su',
};

export function ScheduleChip({
  cronExpr,
  intervalMs,
  onChangeSchedule,
  disabled,
}: {
  cronExpr: string;
  intervalMs?: number;
  onChangeSchedule: (value: { cronExpr: string; intervalMs?: number }) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const timingMode = intervalMs === undefined ? 'cron' : 'interval';
  const timingPresentation = resolveScheduleTimingPresentation(cronExpr, intervalMs);
  const displayCronExpr = timingPresentation.kind === 'intervalExact'
    ? cronExpr
    : timingPresentation.displayCronExpr;
  const [config, setConfig] = useState<CodexScheduleConfig>(() => normalizeScheduleConfig(cronToConfig(displayCronExpr)));

  useEffect(() => {
    setConfig((prev) => {
      const next = normalizeScheduleConfig(cronToConfig(displayCronExpr));
      if (configToCron(prev) === displayCronExpr) return prev;
      return next;
    });
  }, [displayCronExpr]);

  const activeMode: ScheduleMenuMode = timingPresentation.kind === 'intervalExact'
    ? 'exactInterval'
    : toMenuMode(config);
  const availableModes: ReadonlyArray<ScheduleMenuMode> = timingMode === 'interval'
    ? (timingPresentation.kind === 'intervalExact'
      ? ['exactInterval', ...INTERVAL_MENU_MODES]
      : INTERVAL_MENU_MODES)
    : SCHEDULE_MENU_MODES;
  const intervalIsPreset = timingPresentation.kind !== 'intervalExact';
  const scheduleUnset = intervalMs === undefined && cronExpr.trim() === '';
  const scheduleSummary = intervalMs === undefined
    ? summarizeConfig(normalizeScheduleConfig(config))
    : formatIntervalDuration(intervalMs, i18n.resolvedLanguage ?? i18n.language);
  const chipLabel = scheduleUnset
    ? t('scheduler.chips.chooseTime')
    : t(`scheduler.chips.timingMode.${timingMode}Chip`, { schedule: scheduleSummary });

  const update = (patch: Partial<CodexScheduleConfig>) => {
    const next = normalizeScheduleConfig({ ...config, ...patch });
    const nextCronExpr = configToCron(next);
    setConfig(next);
    onChangeSchedule({
      cronExpr: nextCronExpr,
      intervalMs: timingMode === 'interval'
        ? (cronExprToIntervalMs(nextCronExpr) ?? intervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS)
        : undefined,
    });
  };

  const setTimingMode = (nextMode: 'cron' | 'interval') => {
    if (nextMode === timingMode) return;
    const next = switchScheduleTimingMode(
      nextMode === 'cron' ? cronExpr : configToCron(config),
      intervalMs,
      nextMode,
    );
    setConfig(normalizeScheduleConfig(cronToConfig(next.cronExpr)));
    onChangeSchedule(next);
  };

  const setMode = (mode: EditableScheduleMenuMode) => {
    const patch: Partial<CodexScheduleConfig> = { mode };
    if (mode === 'interval') patch.intervalHours = config.mode === 'interval' ? config.intervalHours : 1;
    if (mode === 'intervalMinutes') {
      patch.intervalMinutes = config.mode === 'intervalMinutes' ? config.intervalMinutes : 5;
    }
    update(patch);
  };

  return (
    <Popover open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
      <PopoverTrigger asChild>
        <ChipButton icon={<Timer size={14} />} label={chipLabel} active={open} disabled={disabled} variant="pill" className="max-w-[300px] [&>span:nth-child(2)]:translate-y-[0.5px]" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="z-[10010] w-[600px] rounded-xl bg-transparent p-0 shadow-none border-0"
        onWheel={stopWheel}
      >
        <div
          className="flex flex-col gap-2"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2 shadow-lg dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
            <div className="flex h-[34px] items-center gap-1 rounded-lg bg-[var(--chat-input-chip-bg)] p-[3px]">
              {(['cron', 'interval'] as const).map((mode) => {
                const active = timingMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTimingMode(mode)}
                    className={cn(
                      'h-full flex-1 rounded-md border px-3 text-12 font-medium transition-colors',
                      active
                        ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)]'
                        : 'border-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)]',
                    )}
                  >
                    {t(`scheduler.chips.timingMode.${mode}`)}
                  </button>
                );
              })}
            </div>
            <p className="px-1 pt-1.5 text-11 leading-4 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
              {t(
                timingMode === 'interval' && !intervalIsPreset
                  ? 'scheduler.chips.timingMode.intervalUnsupportedHint'
                  : `scheduler.chips.timingMode.${timingMode}Hint`,
              )}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-[260px] shrink-0 rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2 shadow-lg dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
              <div className="flex flex-col gap-[2px]">
                {availableModes.map((mode) => {
                const active = activeMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => mode !== 'exactInterval' && setMode(mode)}
                    className={cn(
                      'flex h-[34px] w-full items-center rounded-lg px-3 text-left text-sm font-medium transition-colors',
                      active
                        ? 'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] dark:bg-[var(--chat-input-chip-bg)] dark:text-[var(--msg-assistant-text)]'
                        : 'text-[var(--msg-assistant-text)] hover:bg-[var(--confirm-btn-secondary-hover)] dark:text-[var(--msg-assistant-text)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                    )}
                  >
                    {mode === 'exactInterval'
                      ? t('scheduler.chips.timingMode.currentExact', { schedule: scheduleSummary })
                      : t(`scheduler.chips.scheduleMenu.${mode}`)}
                  </button>
                );
                })}
              </div>
            </div>
            {activeMode === 'exactInterval' ? (
              <ExactIntervalPanel summary={scheduleSummary} />
            ) : (
              <ScheduleConfigPanel
                mode={activeMode}
                config={config}
                onUpdate={update}
                onCommitMode={setMode}
              />
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ExactIntervalPanel({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-3 shadow-lg dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
      <div className="text-13 font-medium text-[var(--msg-assistant-text)]">
        {t('scheduler.chips.timingMode.currentExact', { schedule: summary })}
      </div>
      <p className="pt-2 text-11 leading-4 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
        {t('scheduler.chips.timingMode.exactIntervalPanelHint')}
      </p>
    </div>
  );
}

function ScheduleConfigPanel({
  mode,
  config,
  onUpdate,
  onCommitMode,
}: {
  mode: EditableScheduleMenuMode;
  config: CodexScheduleConfig;
  onUpdate: (patch: Partial<CodexScheduleConfig>) => void;
  onCommitMode: (mode: EditableScheduleMenuMode) => void;
}) {
  const { t } = useTranslation();
  const panelConfig = mode === toMenuMode(config) ? config : previewConfigFor(mode, config);
  const commit = () => {
    if (mode !== toMenuMode(config)) onCommitMode(mode);
  };

  return (
    <div className="min-w-0 flex-1 rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2 shadow-lg dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
      <div className="flex flex-col gap-2">
        {mode === 'intervalMinutes' && (
          <>
            <div className="flex min-h-[34px] w-full items-center gap-1.5">
              <IntervalMinutesInput
                value={panelConfig.intervalMinutes}
                onFocus={commit}
                onChange={(intervalMinutes) => onUpdate({ mode: 'intervalMinutes', intervalMinutes })}
              />
              <span className="text-13 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.chips.scheduleField.minutesSuffix')}</span>
            </div>
            <PreviewPill
              text={
                panelConfig.intervalMinutes === 1
                  ? t('scheduler.chips.schedulePreview.everyMinute')
                  : t('scheduler.chips.schedulePreview.everyMinutes', { count: panelConfig.intervalMinutes })
              }
            />
          </>
        )}
        {mode === 'interval' && (
          <>
            <div className="flex min-h-[34px] w-full items-center gap-1.5">
              <IntervalHoursInput
                value={panelConfig.intervalHours}
                onFocus={commit}
                onChange={(intervalHours) => onUpdate({ mode: 'interval', intervalHours })}
              />
              <span className="text-13 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.chips.scheduleField.hoursSuffix')}</span>
            </div>
            <PreviewPill text={panelConfig.intervalHours === 1 ? t('scheduler.chips.schedulePreview.everyHour') : t('scheduler.chips.schedulePreview.everyHours', { count: panelConfig.intervalHours })} />
          </>
        )}
        {(mode === 'daily' || mode === 'weekdays') && (
          <>
            <TimeRow config={panelConfig} onFocus={commit} onUpdate={(patch) => onUpdate({ mode, ...patch })} />
            <PreviewPill text={summarizeConfig(panelConfig)} />
          </>
        )}
        {mode === 'weekly' && (
          <>
            <WeekdayRow value={panelConfig.weekday} onFocus={commit} onChange={(weekday) => onUpdate({ mode: 'weekly', weekday })} />
            <TimeRow config={panelConfig} onFocus={commit} onUpdate={(patch) => onUpdate({ mode: 'weekly', ...patch })} />
            <PreviewPill text={summarizeConfig(panelConfig)} />
          </>
        )}
        {mode === 'monthly' && (
          <>
            <MonthDayRow value={panelConfig.monthDay} onFocus={commit} onChange={(monthDay) => onUpdate({ mode: 'monthly', monthDay })} />
            <TimeRow config={panelConfig} onFocus={commit} onUpdate={(patch) => onUpdate({ mode: 'monthly', ...patch })} />
            <PreviewPill text={summarizeConfig(panelConfig)} />
          </>
        )}
      </div>
    </div>
  );
}

function IntervalHoursInput({
  value,
  onFocus,
  onChange,
}: {
  value: number;
  onFocus: () => void;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={2}
      value={draft}
      onFocus={onFocus}
      onBlur={() => setDraft(String(value))}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
        setDraft(digits);
        if (!digits) return;
        onChange(clamp(Number(digits), 1, 23));
      }}
      className={inputPillClass('w-[68px] text-center')}
    />
  );
}

function IntervalMinutesInput({
  value,
  onFocus,
  onChange,
}: {
  value: number;
  onFocus: () => void;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={2}
      value={draft}
      onFocus={onFocus}
      onBlur={() => setDraft(String(value))}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
        setDraft(digits);
        if (!digits) return;
        onChange(clamp(Number(digits), 1, 59));
      }}
      className={inputPillClass('w-[68px] text-center')}
    />
  );
}

function TimeRow({
  config,
  onFocus,
  onUpdate,
}: {
  config: Pick<CodexScheduleConfig, 'hour' | 'minute'>;
  onFocus: () => void;
  onUpdate: (patch: Pick<CodexScheduleConfig, 'hour' | 'minute'>) => void;
}) {
  return (
    <div className="flex min-h-[34px] w-full items-center">
      <TimePicker
        hour={config.hour}
        minute={config.minute}
        onFocus={onFocus}
        onChange={(patch) => onUpdate({ hour: patch.hour, minute: patch.minute })}
      />
    </div>
  );
}

function TimePicker({
  hour,
  minute,
  onFocus,
  onChange,
}: {
  hour: number;
  minute: number;
  onFocus: () => void;
  onChange: (patch: Pick<CodexScheduleConfig, 'hour' | 'minute'>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hourDraft, setHourDraft] = useState(pad(hour));
  const [minuteDraft, setMinuteDraft] = useState(pad(minute));
  const hourInputRef = React.useRef<HTMLInputElement>(null);
  const minuteInputRef = React.useRef<HTMLInputElement>(null);
  const minuteOptions = useMemo(() => {
    const options = Array.from({ length: 12 }, (_, i) => i * 5);
    if (!options.includes(minute)) options.push(minute);
    return options.sort((a, b) => a - b);
  }, [minute]);

  useEffect(() => {
    setHourDraft(pad(hour));
    setMinuteDraft(pad(minute));
  }, [hour, minute]);

  const applyTime = (nextHour: number, nextMinute: number) => {
    const patch = { hour: clamp(nextHour, 0, 23), minute: clamp(nextMinute, 0, 59) };
    onChange(patch);
    setHourDraft(pad(patch.hour));
    setMinuteDraft(pad(patch.minute));
  };

  const commitDrafts = () => {
    applyTime(Number(hourDraft || hour), Number(minuteDraft || minute));
  };

  const updateDraftPart = (
    raw: string,
    max: number,
    setValue: (value: string) => void,
    onCommit: (value: number) => void,
  ) => {
    const digits = raw.replace(/\D/g, '').slice(-2);
    if (!digits) {
      setValue('');
      return;
    }
    const next = Math.min(Number(digits), max);
    setValue(pad(next));
    onCommit(next);
  };

  const pushDraftDigit = (
    digit: string,
    current: string,
    max: number,
    setValue: (value: string) => void,
    onCommit: (value: number) => void,
  ) => {
    const digits = `${current}${digit}`.replace(/\D/g, '').slice(-2);
    const next = Math.min(Number(digits), max);
    setValue(pad(next));
    onCommit(next);
  };

  const commitPart = (part: 'hour' | 'minute') => {
    if (part === 'hour') {
      applyTime(Number(hourDraft || hour), minute);
      return;
    }
    applyTime(hour, Number(minuteDraft || minute));
  };

  const focusInput = (input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onFocus();
        if (!next) commitDrafts();
        setOpen(next);
      }}
    >
      <div className="grid h-[34px] w-[112px] grid-cols-[1fr_24px] items-center rounded-lg border border-[var(--settings-input-border)] bg-background px-2 text-13 font-medium text-[var(--settings-input-text)] dark:border-[var(--settings-input-border)] dark:text-[var(--settings-input-text)]">
        <div className="flex items-center justify-center">
        <input
          ref={hourInputRef}
          type="text"
          inputMode="numeric"
          value={hourDraft}
          maxLength={2}
          onFocus={(e) => {
            onFocus();
            e.currentTarget.select();
          }}
          onChange={(e) => updateDraftPart(e.target.value, 23, setHourDraft, (nextHour) => onChange({ hour: nextHour, minute }))}
          onBlur={() => commitPart('hour')}
          onKeyDown={(e) => {
            if (/^\d$/.test(e.key)) {
              e.preventDefault();
              pushDraftDigit(e.key, hourDraft, 23, setHourDraft, (nextHour) => onChange({ hour: nextHour, minute }));
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              setHourDraft('00');
              onChange({ hour: 0, minute });
            }
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Tab') {
              e.preventDefault();
              commitPart('hour');
              focusInput(minuteInputRef.current);
            }
          }}
          aria-label={t('scheduler.chips.scheduleField.scheduleHourAria')}
          className="w-5 bg-transparent text-center text-13 font-medium outline-none"
        />
        <span className="select-none text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">:</span>
        <input
          ref={minuteInputRef}
          type="text"
          inputMode="numeric"
          value={minuteDraft}
          maxLength={2}
          onFocus={(e) => {
            onFocus();
            e.currentTarget.select();
          }}
          onChange={(e) => updateDraftPart(e.target.value, 59, setMinuteDraft, (nextMinute) => onChange({ hour, minute: nextMinute }))}
          onBlur={() => commitPart('minute')}
          onKeyDown={(e) => {
            if (/^\d$/.test(e.key)) {
              e.preventDefault();
              pushDraftDigit(e.key, minuteDraft, 59, setMinuteDraft, (nextMinute) => onChange({ hour, minute: nextMinute }));
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              setMinuteDraft('00');
              onChange({ hour, minute: 0 });
            }
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Tab') {
              e.preventDefault();
              commitPart('minute');
              focusInput(hourInputRef.current);
            }
          }}
          aria-label={t('scheduler.chips.scheduleField.scheduleMinuteAria')}
          className="w-5 bg-transparent text-center text-13 font-medium outline-none"
        />
        </div>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('scheduler.chips.scheduleField.openTimePickerAria')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-[var(--chat-input-chip-bg)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:bg-[var(--chat-input-chip-bg)] dark:hover:text-[var(--msg-assistant-text)]"
          >
            <Timer size={14} />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={16}
        className={cn(POPOVER_BASE, 'z-[10020] w-[168px]')}
        onWheel={stopWheel}
      >
        <div className="grid grid-cols-2 gap-1.5">
          <TimeColumn
            label={t('scheduler.chips.scheduleField.hourLabel')}
            value={hour}
            options={Array.from({ length: 24 }, (_, i) => i)}
            onChange={(nextHour) => applyTime(nextHour, minute)}
          />
          <TimeColumn
            label={t('scheduler.chips.scheduleField.minuteLabel')}
            value={minute}
            options={minuteOptions}
            onChange={(nextMinute) => applyTime(hour, nextMinute)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimeColumn({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="px-2 pb-1 text-11 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{label}</div>
      <div className="max-h-[180px] overflow-y-auto pr-1" onWheel={stopWheel}>
        {options.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              className={cn(
                'flex h-7 w-full items-center justify-center rounded-md text-13 transition-colors',
                active
                  ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)] dark:bg-[var(--chat-input-chip-bg)] dark:text-[var(--msg-assistant-text)]'
                  : 'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--surface-hover)] dark:text-[var(--settings-section-desc)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)]',
              )}
            >
              {pad(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WeekdayRow({
  value,
  onChange,
  onFocus,
  multi = false,
}: {
  value: number;
  onChange: (weekday: number) => void;
  onFocus: () => void;
  multi?: boolean;
}) {
  const selected = multi ? [1, 2, 3, 4, 5] : [value];
  return (
    <div className="flex min-h-[34px] w-full items-center">
      <div className="flex h-8 items-center gap-1">
        {[1, 2, 3, 4, 5, 6, 0].map((day) => {
          const active = selected.includes(day);
          return (
            <button
              key={day}
              type="button"
              onFocus={onFocus}
              onClick={() => onChange(day)}
              className={cn(
                'flex h-8 w-[38px] items-center justify-center rounded-full border text-13 transition-colors',
                active
                  ? 'border-transparent bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)] dark:bg-[var(--chat-input-chip-bg)] dark:text-[var(--msg-assistant-text)]'
                  : 'border-[var(--cmd-palette-border)] bg-transparent text-[var(--cmd-palette-item-meta)] hover:bg-[var(--confirm-btn-secondary-hover)] dark:border-[var(--cmd-palette-border)] dark:hover:bg-[var(--settings-btn-secondary-hover-bg)]',
              )}
              aria-label={WEEKDAY_LABELS[day]}
            >
              {WEEKDAY_SHORT[day]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MonthDayRow({
  value,
  onChange,
  onFocus,
}: {
  value: number;
  onChange: (monthDay: number) => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <div className="flex min-h-[34px] w-full items-center gap-1.5">
      <span className="text-13 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.chips.scheduleField.daySuffix')}</span>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        value={draft}
        onFocus={onFocus}
        onBlur={() => setDraft(String(value))}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
          if (!digits) {
            setDraft('');
            return;
          }
          const next = clamp(Number(digits), 1, 31);
          setDraft(String(next));
          onChange(next);
        }}
        className={inputPillClass('w-[56px] text-center')}
      />
    </div>
  );
}

function PreviewPill({ text }: { text: string }) {
  return (
    <div className="flex h-[34px] w-full items-center rounded-full bg-background px-3 text-13 text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
      {text}
    </div>
  );
}

function inputPillClass(className?: string) {
  return cn(
    'h-[34px] rounded-lg border px-3 text-13 outline-none',
    'border-[var(--settings-input-border)] bg-background text-[var(--settings-input-text)]',
    'dark:border-[var(--settings-input-border)] dark:text-[var(--settings-input-text)]',
    className,
  );
}

function normalizeScheduleConfig(config: CodexScheduleConfig): CodexScheduleConfig {
  if (config.mode === 'hourly') return { ...config, mode: 'interval', intervalHours: 1 };
  // 'minute' (cron `* * * * *`) 现在归到 intervalMinutes(1)，让用户看到友好语义
  if (config.mode === 'minute') return { ...config, mode: 'intervalMinutes', intervalMinutes: 1 };
  if (config.mode === 'weekends') return { ...config, mode: 'custom', customCron: config.customCron || configToCron(config) };
  if (config.mode === 'interval') return { ...config, intervalHours: Math.max(1, config.intervalHours || 1) };
  if (config.mode === 'intervalMinutes') return { ...config, intervalMinutes: Math.max(1, Math.min(59, config.intervalMinutes || 5)) };
  return config;
}

function toMenuMode(config: CodexScheduleConfig): EditableScheduleMenuMode {
  if (config.mode === 'hourly' || config.mode === 'interval') return 'interval';
  if (config.mode === 'minute' || config.mode === 'intervalMinutes') return 'intervalMinutes';
  if (config.mode === 'daily' || config.mode === 'weekdays' || config.mode === 'weekly' || config.mode === 'monthly') return config.mode;
  return 'daily';
}

function previewConfigFor(mode: EditableScheduleMenuMode, current: CodexScheduleConfig): CodexScheduleConfig {
  if (mode === 'interval') return { ...current, mode: 'interval', intervalHours: current.intervalHours || 1 };
  if (mode === 'intervalMinutes') return { ...current, mode: 'intervalMinutes', intervalMinutes: current.intervalMinutes || 5 };
  if (mode === 'monthly') return { ...current, mode: 'monthly', monthDay: current.monthDay || 1 };
  return { ...current, mode };
}

export function ModelEffortChip({
  agentKind,
  modelValue,
  onChangeModel,
  effortValue,
  onChangeEffort,
  disabled,
  followSession,
  providerId,
  onChangeProviderId,
  onNavigateToProviders,
  fastMode,
  onChangeFast,
}: {
  agentKind: AgentKind;
  modelValue: string;
  onChangeModel: (v: string) => void;
  effortValue: EffortValue | '';
  onChangeEffort: (v: EffortValue | '') => void;
  disabled?: boolean;
  /**
   * heartbeat(绑定会话)形态:下拉顶部加"跟随会话"行(= model 空值),
   * model 空时显示"跟随会话"而非默认回退模型。false/缺省路径行为零变化
   * (空值回退默认模型的"所见即所存"逻辑保持原样,防 2026-06 显示≠运行事故复发)。
   */
  followSession?: boolean;
  /** 显式选定来源(供应商)id;'' = 跟随该 agent 原生默认来源(no-break)。 */
  providerId: string;
  /** 用户在来源轨选了某供应商时回调(等于原生默认时归一化为 '')。 */
  onChangeProviderId: (providerId: string) => void;
  /** 0 个 / 引导连接来源时跳设置→供应商页;不传则来源轨不显示「连接」入口。 */
  onNavigateToProviders?: () => void;
  /** Fast 模式状态 + 回调(与聊天一致,收进模型选择器 Edit 配置列)。heartbeat 态不传 → Edit 无 Fast。 */
  fastMode?: boolean;
  onChangeFast?: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const setOpenWithoutAutoRefresh = useCallback((next: boolean): void => {
    openRef.current = next;
    setOpen(next);
  }, []);
  // 与聊天的模型选择器同一套「发现在途」状态(理由见 useModelDiscoveryPending):
  // 定时任务这边同样是打开就触发一次发现,静默的话用户看到的清单同样可能是上一轮的。
  const discovery = useModelDiscoveryPending();
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      const nextOpen = disabled ? false : next;
      const wasOpen = openRef.current;
      openRef.current = nextOpen;
      if (nextOpen && !wasOpen) {
        discovery.begin(() =>
          window.electronAPI.maker.requestProviderModelsAutoRefresh('model-selector-open'),
        );
      }
      if (!nextOpen) discovery.reset();
      setOpen(nextOpen);
    },
    [disabled, discovery],
  );
  const caps = useAgentCapabilities(agentKind);
  // 触发器(trigger)展示用:仍按 codex/ 折扣模型的 XD 网关来源可见性过滤,算出当前
  // 选中模型名。下拉内容本体改用聊天的 ModelSelectorContent(它内部按来源/api-key 自行
  // 过滤 + 分组),这里只为 trigger 文案保留最小化 model 解析。
  const { providers } = useProviders();
  const xdConnected = providers.some((p) => p.id === 'xd' && p.connected);
  const availableModels = caps.capabilities?.availableModels;
  const models = useMemo(
    () =>
      (availableModels ?? []).filter(
        (m) => agentKind !== 'codex' || xdConnected || !m.id.startsWith('codex/'),
      ),
    [availableModels, agentKind, xdConnected],
  );
  // 只有 model/provider/effort 都为空时才显示「跟随会话」;混合覆盖态必须显式暴露，
  // 不能把来源或强度覆盖伪装成完整继承。非 followSession 维持原逻辑:空值回退跟实际
  // 运行语义同源(三级回退默认),绝不回退 models[0]。
  const isFollowingSession = isFollowingSessionSelection({
    followSession,
    model: modelValue,
    providerId,
    effort: effortValue,
  });
  const followsSessionModel = usesBoundSessionModel({ followSession, model: modelValue });
  const effectiveId = followsSessionModel ? '' : modelValue || getScheduleDefaultModel(agentKind);
  const current = models.find((m) => m.id === effectiveId);
  const allowedEfforts = (current?.efforts ?? []) as readonly EffortValue[];
  const fallbackEffort = (current?.defaultEffort ?? 'high') as EffortValue;
  const effectiveEffort: EffortValue = effortValue && allowedEfforts.includes(effortValue) ? effortValue : fallbackEffort;
  const effortLabel = (e: EffortValue) => t(`effortLevels.${e}`);
  const display = followsSessionModel
    ? [
      t('scheduler.chips.model.followSession'),
      providerId.trim()
        ? (providers.find((provider) => provider.id === providerId)?.name ?? providerId)
        : null,
      effortValue ? effortLabel(effortValue) : null,
    ].filter(Boolean).join(' · ')
    : current
      ? `${current.displayName} · ${allowedEfforts.length ? effortLabel(effectiveEffort) : t('scheduler.chips.model.effortDefault')}`
      : t('scheduler.chips.model.default');

  // railSources 仅用于 nativeDefault 归一化(下拉宽度由 ModelSelectorContent 内容自适应,见 w-auto)。
  const vendorKey = agentKind === 'claude-code' ? 'cc' : agentKind;
  const railSources = useMemo(
    () => connectedProvidersForAgent(providers, agentKind),
    [providers, agentKind],
  );
  // 归一化:选中的来源 == 原生默认 → 存 ''(= 跟随默认,与老数据/未升级字节级一致),
  // 否则存显式 id。这样只有「钉到非原生来源」才在 schedule 上落非空 providerId。
  const nativeDefault = useMemo(
    () => nativeDefaultSourceId(railSources, agentKind),
    [railSources, agentKind],
  );
  // 当前生效来源 —— 与聊天 trigger 同口径(effectiveSourceIdForModel):按「已连接且**确实
  // 提供当前模型**」收窄后再应用显式选择 / 原生默认。只查「已连接」会在显式来源不提供
  // effectiveId 时渲染错误来源的标识(如 providerId=openai 而默认模型只有 xd 提供);
  // followSession(effectiveId 为空)无从收窄,返回 null,icon 分支本就被 isFollowingSession 挡住。
  const activeSourceId = useMemo(
    () =>
      effectiveId
        ? effectiveSourceIdForModel(providers, providerId || null, effectiveId, agentKind)
        : null,
    [providers, providerId, effectiveId, agentKind],
  );
  const activeProvider = providers.find((p) => p.id === activeSourceId);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <ChipButton
          icon={
            !isFollowingSession && activeSourceId ? (
              // 图标统一规则(与聊天 trigger 同口径):模型条目 icon(AI Gateway / 目录设定)
              // 优先,缺省回落来源供应商标。
              <ModelIconMark
                icon={activeProvider ? getModel(activeProvider, effectiveId, agentKind)?.icon : undefined}
                providerId={activeSourceId}
                name={activeProvider?.name}
                routing={activeProvider?.routing}
                colorClass=""
                withMargin={false}
              />
            ) : undefined
          }
          label={display}
          active={open}
          disabled={disabled}
          className="[&>span:last-of-type]:min-w-[106px] max-w-[240px] px-2"
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className={cn(
          // z-[10010]:本 chip 在 ScheduleFormDialog 内,弹层必须盖过对话框(沿用原
          // POPOVER_BASE 的层级——丢了它会渲染在对话框下层、点了"没反应")。
          'z-[10010] overflow-hidden rounded-[12px] p-0 shadow-lg',
          'bg-[var(--model-dropdown-bg)] border border-[var(--model-dropdown-border)]',
          // 宽度由内容自适应(单栏 320;Edit 展开 ~517 向左加宽),与聊天选择器同口径。
          'w-auto',
        )}
        onWheel={stopWheel}
      >
        {/* 直接复用聊天的下拉内容本体(唯一真源:聊天选择器改了这里跟着变)。
            来源轨 / 模型分组 / 搜索 / effort / 空态全套自带;followSession 行为 opt-in。 */}
        <ModelSelectorContent
          vendorKey={vendorKey}
          modelId={effectiveId}
          effort={effectiveEffort}
          onModelChange={onChangeModel}
          onEffortChange={(e) => onChangeEffort(e as EffortValue)}
          fastMode={fastMode}
          onFastModeChange={onChangeFast}
          onDismiss={() => setOpenWithoutAutoRefresh(false)}
          currentProviderId={providerId || null}
          onProviderChange={(pid, reconciledModelId, reconciledEffort) => {
            onChangeProviderId(pid && pid !== nativeDefault ? pid : '');
            if (reconciledModelId) onChangeModel(reconciledModelId);
            if (reconciledEffort !== undefined) {
              onChangeEffort(reconciledEffort as EffortValue | '');
            }
          }}
          onNavigateToProviders={onNavigateToProviders}
          // A stale explicit provider is rendered as the effective fallback row.
          // Re-selecting that highlighted row must repair the stored provider
          // before the effort configuration card opens.
          reselectEmitsChange
          selectedRowClickOpensConfiguration
          overlayContentClassName="z-[10020]"
          discoveringModels={discovery.pending}
          followSession={
            followSession
              ? {
                  active: isFollowingSession,
                  label: t('scheduler.chips.model.followSession'),
                  onFollow: () => {
                    onChangeModel('');
                    onChangeEffort('');
                    onChangeProviderId('');
                  },
                }
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}

export function ThreadPickerInline({ value, onSelect, onOpen, reference }: {
  /** 当前 form.targetSessionId;'__pending__' 占位在组件内映射为空选。 */
  value: string;
  /**
   * 选中会话(null = 选回占位)。回传整个 Session 对象,调用方需要 agentKind
   * 做联动(锁 agent tabs / 映射 schedule agentKind)。
   */
  onSelect: (session: Session | null) => void;
  /** 已选真实会话时显示"打开会话"按钮;调用方负责 navigate + 关 dialog。 */
  onOpen?: (sessionId: string) => void;
  /** 当前绑定由 main 层解析出的生命周期状态。 */
  reference?: SessionReference;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void sessionService
      .list(50, 'active')
      .then((list) => {
        if (!alive) return;
        setSessions(list.filter((session) => !isReviewSessionSource(session.source)));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const hasRealValue = !!value && value !== PENDING_SESSION_ID;
  const referenceUnavailable =
    reference?.state === 'deleted' || reference?.state === 'missing';

  // 单行布局:select 占满 + 已选真实会话时右侧"打开会话"按钮。换选即换绑,
  // 不需要单独的"解除绑定"——切换三态/重新选择都是非破坏性的(hook 层 remembered)。
  return (
    <div className="flex items-center gap-2">
      {loading ? (
        <p className="px-1 text-xs text-[var(--cmd-palette-item-meta)]">{t('scheduler.editor.thread.loading')}</p>
      ) : error ? (
        <p className="px-1 text-xs text-[var(--cmd-palette-item-meta)]">{t('scheduler.editor.thread.loadFailed', { error })}</p>
      ) : sessions.length === 0 && !hasRealValue ? (
        <p className="px-1 text-xs text-[var(--cmd-palette-item-meta)]">{t('scheduler.editor.thread.empty')}</p>
      ) : (
        <>
          <select
            aria-label={t('scheduler.editor.thread.label')}
            // '__pending__' 占位映射为空选;真实 id 直接选中(含下方合成 option)
            value={value === PENDING_SESSION_ID ? '' : value}
            onChange={(e) => {
              const picked = sessions.find((s) => s.id === e.target.value) ?? null;
              // 选回占位项 → onSelect(null),调用方写回 '__pending__'(绝不能写 '',
              // 会被 deriveRunMode 判成 fresh 导致三态选择器跳态)
              onSelect(picked);
            }}
            className={cn(selectClass, 'min-w-0 flex-1')}
          >
            <option value="">{t('scheduler.editor.thread.selectPlaceholder')}</option>
            {/* 编辑时绑定会话可能已归档(不在 active 列表):插入 disabled 合成
                option 保住 select 显示,避免空白;disabled 防止 find 失败误写占位 */}
            {hasRealValue && !sessions.some((s) => s.id === value) && (
              <option value={value} disabled>
                {referenceUnavailable
                  ? t('scheduler.editor.thread.deletedBinding')
                  : reference?.title?.trim() ||
                    t('scheduler.editor.runSession.card.fallbackTitle', {
                      id: value.slice(0, 8),
                    })}
              </option>
            )}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {s.agentKind === 'cc' ? 'Claude Code' : s.agentKind === 'pi' ? 'Pi' : 'Codex'}
              </option>
            ))}
          </select>
          {onOpen && hasRealValue && !referenceUnavailable && (
            <button
              type="button"
              onClick={() => onOpen(value)}
              title={t('scheduler.editor.runSession.card.open')}
              className={cn(
                'inline-flex h-[34px] shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium',
                'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
                'transition-colors focus:outline-none',
              )}
            >
              <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
              {t('scheduler.editor.runSession.card.open')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const selectClass = cn(
  'w-full rounded-lg border px-2 py-1.5 text-sm',
  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
  'dark:border-[var(--settings-input-border)] dark:bg-[var(--settings-input-bg)] dark:text-[var(--settings-input-text)]',
  'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
);

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export { DEFAULT_CONFIG as DEFAULT_SCHEDULE_CONFIG };
export type { ModelDescriptor };
