import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Keyboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { useWorkLouderCodex } from '@/hooks/useWorkLouderCodex';
import { cn } from '@/lib/utils';
import {
  WORKLOUDER_CODEX_AUTO_DIM_OPTIONS,
  WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  type WorkLouderCodexAutoDim,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderCodexState,
} from '../../../shared/workLouderCodex';

interface WorkLouderCodexEntryProps {
  state: WorkLouderCodexState | null;
  loading: boolean;
  onOpen(): void;
}

export function WorkLouderCodexEntry({ state, loading, onOpen }: WorkLouderCodexEntryProps) {
  const { t } = useTranslation();
  const status = state?.connectionStatus ?? 'connecting';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-4 text-left outline-none transition-colors',
        'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
        'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
      )}
      aria-label={t('settings.shortcuts.workLouderCodex.openAria')}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <Keyboard size={20} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]">
          {t('settings.shortcuts.workLouderCodex.title')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
          {t('settings.shortcuts.workLouderCodex.entryDescription')}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <ConnectionStatus status={status} loading={loading} compact />
        <ChevronRight size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      </span>
    </button>
  );
}

export function WorkLouderCodexEntryContainer({ onOpen }: { onOpen(): void }) {
  const { state, loading } = useWorkLouderCodex();
  return <WorkLouderCodexEntry state={state} loading={loading} onOpen={onOpen} />;
}

export function WorkLouderCodexSettings({ onBack }: { onBack(): void }) {
  const { t } = useTranslation();
  const { state, loading, saving, error, setSettings, reload } = useWorkLouderCodex();
  const [brightnessDraft, setBrightnessDraft] = useState(100);
  const isDefault =
    state?.settings.lightingBrightness === WORKLOUDER_CODEX_DEFAULT_SETTINGS.lightingBrightness &&
    state.settings.lightingAutoDim === WORKLOUDER_CODEX_DEFAULT_SETTINGS.lightingAutoDim &&
    state.settings.singleTapAgentKeys === WORKLOUDER_CODEX_DEFAULT_SETTINGS.singleTapAgentKeys;

  useEffect(() => {
    if (state) setBrightnessDraft(state.settings.lightingBrightness);
  }, [state?.settings.lightingBrightness]);

  const commitBrightness = (): void => {
    if (!state || brightnessDraft === state.settings.lightingBrightness) return;
    void setSettings({ lightingBrightness: brightnessDraft });
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex size-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]"
            aria-label={t('settings.shortcuts.workLouderCodex.back')}
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.shortcuts.workLouderCodex.title')}
          </h2>
        </div>
        <button
          type="button"
          disabled={!state || saving || isDefault}
          onClick={() => void setSettings({ ...WORKLOUDER_CODEX_DEFAULT_SETTINGS })}
          className="shrink-0 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('settings.shortcuts.reset')}
        </button>
      </div>

      <SettingsCard className="flex items-center gap-4">
        <CodexMicroKeyPreview />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('settings.shortcuts.workLouderCodex.connection.label')}
            </p>
            <ConnectionStatus status={state?.connectionStatus ?? 'connecting'} loading={loading} />
          </div>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t(
              `settings.shortcuts.workLouderCodex.connection.descriptions.${state?.connectionStatus ?? 'connecting'}`,
            )}
          </p>
        </div>
      </SettingsCard>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-4 py-3 text-12 text-[var(--error-fg)]">
          <span>{t(`settings.shortcuts.workLouderCodex.errors.${error}`)}</span>
          {error === 'load' && (
            <button
              type="button"
              onClick={() => void reload()}
              className="font-medium underline underline-offset-2"
            >
              {t('settings.shortcuts.workLouderCodex.retry')}
            </button>
          )}
        </div>
      )}

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.lighting.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.lighting.brightness.label')}
          description={t('settings.shortcuts.workLouderCodex.lighting.brightness.description')}
          control={
            <div className="flex min-w-[220px] items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                step={10}
                value={brightnessDraft}
                disabled={!state || saving}
                onChange={(event) => setBrightnessDraft(Number(event.currentTarget.value))}
                onPointerUp={commitBrightness}
                onKeyUp={commitBrightness}
                onBlur={commitBrightness}
                className="h-1 flex-1 cursor-pointer accent-[var(--switch-track-on)] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t('settings.shortcuts.workLouderCodex.lighting.brightness.aria')}
              />
              <span className="w-10 text-right text-12 tabular-nums text-[var(--text-secondary)]">
                {brightnessDraft}%
              </span>
            </div>
          }
        />
        <SettingsDivider />
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.lighting.autoDim.label')}
          description={t('settings.shortcuts.workLouderCodex.lighting.autoDim.description')}
          control={
            <div className="relative min-w-[150px]">
              <select
                value={state?.settings.lightingAutoDim ?? '3-minutes'}
                disabled={!state || saving}
                onChange={(event) =>
                  void setSettings({
                    lightingAutoDim: event.currentTarget.value as WorkLouderCodexAutoDim,
                  })
                }
                className={cn(
                  'h-9 w-full appearance-none rounded-full border py-0 pl-3 pr-8 text-12 outline-none',
                  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                  'focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50',
                )}
                aria-label={t('settings.shortcuts.workLouderCodex.lighting.autoDim.aria')}
              >
                {WORKLOUDER_CODEX_AUTO_DIM_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(`settings.shortcuts.workLouderCodex.lighting.autoDim.options.${option}`)}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--settings-input-text)] opacity-70"
                aria-hidden="true"
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.agentKeys.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.agentKeys.source.label')}
          description={t('settings.shortcuts.workLouderCodex.agentKeys.source.description')}
          control={
            <span className="rounded-full border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-3 py-1.5 text-12 font-medium text-[var(--text-secondary)]">
              {t('settings.shortcuts.workLouderCodex.agentKeys.source.value')}
            </span>
          }
        />
        <SettingsDivider />
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.label')}
          description={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.description')}
          control={
            <Switch
              checked={state?.settings.singleTapAgentKeys ?? true}
              disabled={!state || saving}
              onCheckedChange={(checked) => void setSettings({ singleTapAgentKeys: checked })}
              aria-label={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.aria')}
            />
          }
        />
        <SettingsDivider />
        <div className="grid grid-cols-3 gap-2 py-1 max-sm:grid-cols-2">
          {Array.from({ length: state?.agentSlotCount ?? 6 }, (_, index) => (
            <div
              key={index}
              className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-3 py-2.5"
              aria-label={t('settings.shortcuts.workLouderCodex.agentKeys.slotAria', {
                slot: String(index).padStart(2, '0'),
                position: index + 1,
              })}
            >
              <span className="text-11 font-medium tracking-wide text-[var(--text-tertiary)]">
                AG{String(index).padStart(2, '0')}
              </span>
              <span className="truncate text-12 font-medium text-[var(--text-primary)]">
                {t('settings.shortcuts.workLouderCodex.agentKeys.slot', { position: index + 1 })}
              </span>
            </div>
          ))}
        </div>
      </SettingsGroup>
    </div>
  );
}

function SettingsCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="px-1 text-13 font-medium text-[var(--settings-section-title)]">{title}</h3>
      <SettingsCard>{children}</SettingsCard>
    </div>
  );
}

function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{label}</p>
        <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function SettingsDivider() {
  return <div className="my-1 h-px bg-[var(--settings-theme-card-border)]" />;
}

function ConnectionStatus({
  status,
  loading,
  compact = false,
}: {
  status: WorkLouderCodexConnectionStatus;
  loading: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const effectiveStatus = loading ? 'connecting' : status;
  const dotClass =
    effectiveStatus === 'connected'
      ? 'bg-[var(--settings-badge-connected)]'
      : effectiveStatus === 'error' || effectiveStatus === 'unavailable'
        ? 'bg-[var(--error-fg)]'
        : 'bg-[var(--text-tertiary)]';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full text-12 text-[var(--text-secondary)]',
        compact
          ? 'px-1.5 py-1'
          : 'border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-2.5 py-1.5',
      )}
    >
      <span className={cn('size-1.5 rounded-full', dotClass)} aria-hidden="true" />
      {t(`settings.shortcuts.workLouderCodex.connection.status.${effectiveStatus}`)}
    </span>
  );
}

function CodexMicroKeyPreview() {
  return (
    <div
      className="grid size-[76px] shrink-0 grid-cols-3 gap-1 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] p-2"
      aria-hidden="true"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span
          key={index}
          className="flex items-center justify-center rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] text-10 font-medium text-[var(--text-tertiary)]"
        >
          {index + 1}
        </span>
      ))}
    </div>
  );
}

export type { WorkLouderCodexSettingsPatch };
