import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BatteryCharging,
  ChevronDown,
  ChevronRight,
  Keyboard,
  RotateCcw,
  Usb,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { useWorkLouderCodex } from '@/hooks/useWorkLouderCodex';
import { useSkillhub } from '@/features/skillhub/hooks/useSkillhub';
import { cn } from '@/lib/utils';
import {
  WorkLouderCodexKeyboardLayout,
  WorkLouderCodexKeycapPicker,
  type WorkLouderCodexEditableKey,
} from './WorkLouderCodexKeyboardLayout';
import {
  WORKLOUDER_CODEX_AGENT_SOURCES,
  WORKLOUDER_CODEX_ANALOG_DIRECTIONS,
  WORKLOUDER_CODEX_AUTO_DIM_OPTIONS,
  WORKLOUDER_CODEX_COMMAND_IDS,
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CODEX_DEFAULT_LAYOUT,
  WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  WORKLOUDER_CODEX_ENCODER_ACTIONS,
  WORKLOUDER_CODEX_ENCODER_MODES,
  WORKLOUDER_CODEX_KEYCAP_IDS,
  WORKLOUDER_CODEX_VOICE_BUTTON_MODES,
  cloneWorkLouderCodexLayout,
  type WorkLouderCodexAction,
  type WorkLouderCodexAgentSource,
  type WorkLouderCodexAutoDim,
  type WorkLouderCodexCommandId,
  type WorkLouderCodexCommandSlot,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexKeycapId,
  type WorkLouderCodexLayout,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderCodexState,
} from '../../../shared/workLouderCodex';

const DOUBLE_KEYCAPS = new Set<WorkLouderCodexKeycapId>(['MIC', 'EMPT5']);

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
  const {
    state,
    loading,
    saving,
    error,
    setSettings,
    resetSettings,
    openInputMonitoringSettings,
    reload,
  } = useWorkLouderCodex();
  const { skills, bootstrapped, refresh: refreshSkills } = useSkillhub();
  const [brightnessDraft, setBrightnessDraft] = useState(100);
  const [editingSlot, setEditingSlot] = useState<WorkLouderCodexCommandSlot | null>(null);
  const [editingKeycapId, setEditingKeycapId] = useState<WorkLouderCodexKeycapId | null>(null);
  const [keycapQuery, setKeycapQuery] = useState('');
  const settings = state?.settings ?? WORKLOUDER_CODEX_DEFAULT_SETTINGS;
  const enabledSkills = useMemo(
    () => skills.filter((skill) => skill.kind === 'skill' && !skill.parseError),
    [skills],
  );
  const isDefault =
    state !== null &&
    JSON.stringify(state.settings) === JSON.stringify(WORKLOUDER_CODEX_DEFAULT_SETTINGS);

  useEffect(() => {
    if (state) setBrightnessDraft(state.settings.lightingBrightness);
  }, [state?.settings.lightingBrightness]);

  useEffect(() => {
    if (!bootstrapped) void refreshSkills();
  }, [bootstrapped, refreshSkills]);

  const commitBrightness = (): void => {
    if (!state || brightnessDraft === state.settings.lightingBrightness) return;
    void setSettings({ lightingBrightness: brightnessDraft });
  };

  const patchLayout = (update: (layout: WorkLouderCodexLayout) => void): void => {
    const layout = cloneWorkLouderCodexLayout(settings.layout);
    update(layout);
    void setSettings({ layout });
  };

  const visibleCommandSlots: WorkLouderCodexCommandSlot[] = settings.layout.separateMicrophoneKeys
    ? WORKLOUDER_CODEX_COMMAND_SLOTS.filter((slot) => slot !== 'ACT10_ACT11')
    : WORKLOUDER_CODEX_COMMAND_SLOTS.filter((slot) => slot !== 'ACT10' && slot !== 'ACT11');

  const changeCommandKeycap = (
    slot: WorkLouderCodexCommandSlot,
    keycapId: WorkLouderCodexKeycapId,
  ): void => {
    patchLayout((layout) => {
      const activeSlots = layout.separateMicrophoneKeys
        ? WORKLOUDER_CODEX_COMMAND_SLOTS.filter((item) => item !== 'ACT10_ACT11')
        : WORKLOUDER_CODEX_COMMAND_SLOTS.filter((item) => item !== 'ACT10' && item !== 'ACT11');
      const duplicate = activeSlots.find(
        (item) => item !== slot && layout.slots[item].keycapId === keycapId,
      );
      const previous = { ...layout.slots[slot] };
      layout.slots[slot] = { ...layout.slots[slot], keycapId };
      if (duplicate) layout.slots[duplicate] = previous;
    });
  };

  const openKeycapEditor = (key: WorkLouderCodexEditableKey): void => {
    if (!key.startsWith('ACT')) return;
    const slot = key as WorkLouderCodexCommandSlot;
    setEditingSlot(slot);
    setEditingKeycapId(settings.layout.slots[slot].keycapId);
    setKeycapQuery('');
  };

  const closeKeycapEditor = (): void => {
    setEditingSlot(null);
    setEditingKeycapId(null);
    setKeycapQuery('');
  };

  const editingAssignment = editingSlot ? settings.layout.slots[editingSlot] : null;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex size-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
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
          onClick={() => void resetSettings()}
          className="shrink-0 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
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
            {connectionDescription(t, state)}
          </p>
          {state?.device.deviceType && (
            <div className="flex flex-wrap gap-2 pt-1">
              <DeviceChip icon={<Keyboard size={12} />}>
                {state.device.deviceType === 'creator-micro-2' ? 'Creator Micro 2' : 'Codex Micro'}
              </DeviceChip>
              {state.device.isUsbConnection && (
                <DeviceChip icon={<Usb size={12} />}>USB</DeviceChip>
              )}
              {state.device.batteryPercentage !== null && (
                <DeviceChip
                  icon={state.device.isCharging ? <BatteryCharging size={12} /> : undefined}
                >
                  {state.device.batteryPercentage}%
                </DeviceChip>
              )}
              {state.device.firmwareVersion && (
                <DeviceChip>
                  {t('settings.shortcuts.workLouderCodex.device.firmware', {
                    version: state.device.firmwareVersion,
                  })}
                </DeviceChip>
              )}
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.shortcuts.workLouderCodex.layout.keyboard.title')}
          </h3>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t('settings.shortcuts.workLouderCodex.layout.keyboard.description')}
          </p>
        </div>
        <WorkLouderCodexKeyboardLayout
          layout={settings.layout}
          agentSlots={state?.agentSlots ?? []}
          disabled={!state || saving}
          footer={t('settings.shortcuts.workLouderCodex.layout.keyboard.editHint')}
          labels={{
            analogStick: t('settings.shortcuts.workLouderCodex.layout.keyboard.analogStick'),
            encoder: t('settings.shortcuts.workLouderCodex.layout.keyboard.encoder'),
            codexMicro: t('settings.shortcuts.workLouderCodex.layout.keyboard.codexMicro'),
          }}
          onEditKeycap={openKeycapEditor}
        />
      </SettingsCard>

      <WorkLouderCodexKeycapPicker
        open={editingSlot !== null}
        slot={editingSlot}
        selectedKeycapId={editingKeycapId}
        query={keycapQuery}
        onQueryChange={setKeycapQuery}
        onOpenChange={(open) => {
          if (!open) closeKeycapEditor();
        }}
        onSelect={setEditingKeycapId}
        onCancel={closeKeycapEditor}
        onSave={() => {
          if (editingSlot && editingKeycapId) changeCommandKeycap(editingSlot, editingKeycapId);
        }}
        assignedAction={
          editingAssignment?.action
            ? actionValue(editingAssignment.action)
            : t('settings.shortcuts.workLouderCodex.layout.editor.noAssignment')
        }
        copy={{
          title: t('settings.shortcuts.workLouderCodex.layout.editor.title'),
          description: t('settings.shortcuts.workLouderCodex.layout.editor.description'),
          searchPlaceholder: t(
            'settings.shortcuts.workLouderCodex.layout.editor.searchPlaceholder',
          ),
          close: t('settings.shortcuts.workLouderCodex.layout.editor.close'),
          cancel: t('settings.shortcuts.workLouderCodex.layout.editor.cancel'),
          save: t('settings.shortcuts.workLouderCodex.layout.editor.save'),
          assignedShortcut: t('settings.shortcuts.workLouderCodex.layout.editor.assignedShortcut'),
          noAssignment: t('settings.shortcuts.workLouderCodex.layout.editor.noAssignment'),
        }}
      />

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

      {state?.device.inputMonitoringPermission !== 'not-required' && (
        <SettingsGroup title={t('settings.shortcuts.workLouderCodex.device.title')}>
          <SettingsRow
            label={t('settings.shortcuts.workLouderCodex.device.inputMonitoring.label')}
            description={t(
              `settings.shortcuts.workLouderCodex.device.inputMonitoring.${state?.device.inputMonitoringPermission ?? 'unknown'}`,
            )}
            control={
              <button
                type="button"
                onClick={() => void openInputMonitoringSettings()}
                className="rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-12 text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                {t('settings.shortcuts.workLouderCodex.device.inputMonitoring.open')}
              </button>
            }
          />
        </SettingsGroup>
      )}

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.agentKeys.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.agentKeys.source.label')}
          description={t('settings.shortcuts.workLouderCodex.agentKeys.source.description')}
          control={
            <SelectControl
              value={settings.agentSource}
              disabled={!state || saving}
              ariaLabel={t('settings.shortcuts.workLouderCodex.agentKeys.source.label')}
              onChange={(value) =>
                void setSettings({ agentSource: value as WorkLouderCodexAgentSource })
              }
            >
              {WORKLOUDER_CODEX_AGENT_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`settings.shortcuts.workLouderCodex.agentKeys.source.options.${source}`)}
                </option>
              ))}
            </SelectControl>
          }
        />
        <SettingsDivider />
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.label')}
          description={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.description')}
          control={
            <Switch
              checked={settings.singleTapAgentKeys}
              disabled={!state || saving}
              onCheckedChange={(checked) => void setSettings({ singleTapAgentKeys: checked })}
              aria-label={t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.aria')}
            />
          }
        />
        <SettingsDivider />
        <div className="grid grid-cols-2 gap-2 py-1 max-sm:grid-cols-1">
          {Array.from({ length: state?.agentSlotCount ?? 6 }, (_, index) => {
            const slot = state?.agentSlots[index];
            return (
              <div
                key={index}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-11 font-medium tracking-wide text-[var(--text-tertiary)]">
                    AG{String(index).padStart(2, '0')}
                  </span>
                  {settings.agentSource !== 'custom' && (
                    <span className="max-w-[180px] truncate text-12 font-medium text-[var(--text-primary)]">
                      {slot?.title ?? t('settings.shortcuts.workLouderCodex.agentKeys.newTask')}
                    </span>
                  )}
                </div>
                {settings.agentSource === 'custom' && (
                  <ActionSelect
                    action={settings.customAgentKeys[index] ?? null}
                    state={state}
                    skills={enabledSkills}
                    disabled={!state || saving}
                    emptyLabel={t('settings.shortcuts.workLouderCodex.agentKeys.newTask')}
                    allowTasks
                    allowKeycaps
                    onChange={(action) => {
                      const customAgentKeys = settings.customAgentKeys.map((item) =>
                        item ? { ...item } : null,
                      );
                      customAgentKeys[index] = action;
                      void setSettings({ customAgentKeys });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.commandKeys.title')}>
        <div className="flex flex-col gap-1">
          {visibleCommandSlots.map((slot, index) => {
            const assignment = settings.layout.slots[slot];
            const double = slot === 'ACT10_ACT11';
            const keycaps = WORKLOUDER_CODEX_KEYCAP_IDS.filter((keycap) =>
              double ? DOUBLE_KEYCAPS.has(keycap) : !DOUBLE_KEYCAPS.has(keycap),
            );
            return (
              <div key={slot}>
                {index > 0 && <SettingsDivider />}
                <div className="flex flex-wrap items-center gap-3 py-2">
                  <span className="w-[88px] shrink-0 text-12 font-medium text-[var(--text-secondary)]">
                    {slot === 'ACT10_ACT11' ? 'ACT10 + 11' : slot}
                  </span>
                  <SelectControl
                    value={assignment.keycapId}
                    disabled={!state || saving}
                    ariaLabel={t('settings.shortcuts.workLouderCodex.commandKeys.keycap')}
                    onChange={(value) =>
                      changeCommandKeycap(slot, value as WorkLouderCodexKeycapId)
                    }
                    className="min-w-[110px] flex-1"
                  >
                    {keycaps.map((keycap) => (
                      <option key={keycap} value={keycap}>
                        {keycap}
                      </option>
                    ))}
                  </SelectControl>
                  <ActionSelect
                    action={assignment.action}
                    state={state}
                    skills={enabledSkills}
                    disabled={!state || saving}
                    emptyLabel={t('settings.shortcuts.workLouderCodex.commandKeys.builtIn')}
                    onChange={(action) =>
                      patchLayout((layout) => {
                        layout.slots[slot].action = action;
                      })
                    }
                    className="min-w-[210px] flex-[2]"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.microphone.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.microphone.mode.label')}
          description={t('settings.shortcuts.workLouderCodex.microphone.mode.description')}
          control={
            <SelectControl
              value={settings.layout.voiceButtonMode}
              disabled={!state || saving}
              ariaLabel={t('settings.shortcuts.workLouderCodex.microphone.mode.label')}
              onChange={(value) =>
                patchLayout((layout) => {
                  layout.voiceButtonMode = value as WorkLouderCodexLayout['voiceButtonMode'];
                })
              }
            >
              {WORKLOUDER_CODEX_VOICE_BUTTON_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`settings.shortcuts.workLouderCodex.microphone.mode.options.${mode}`)}
                </option>
              ))}
            </SelectControl>
          }
        />
        <SettingsDivider />
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.microphone.separate.label')}
          description={t('settings.shortcuts.workLouderCodex.microphone.separate.description')}
          control={
            <Switch
              checked={settings.layout.separateMicrophoneKeys}
              disabled={!state || saving}
              onCheckedChange={(checked) =>
                patchLayout((layout) => {
                  layout.separateMicrophoneKeys = checked;
                })
              }
              aria-label={t('settings.shortcuts.workLouderCodex.microphone.separate.label')}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.analog.title')}>
        {WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map((direction, index) => (
          <div key={direction}>
            {index > 0 && <SettingsDivider />}
            <SettingsRow
              label={t(`settings.shortcuts.workLouderCodex.analog.directions.${direction}`)}
              description={t('settings.shortcuts.workLouderCodex.analog.description')}
              control={
                <ActionSelect
                  action={settings.layout.analogStick[direction]}
                  state={state}
                  skills={enabledSkills}
                  disabled={!state || saving}
                  emptyLabel={t('settings.shortcuts.workLouderCodex.actions.none')}
                  onChange={(action) =>
                    patchLayout((layout) => {
                      layout.analogStick[direction] = action;
                    })
                  }
                />
              }
            />
          </div>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.encoder.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.encoder.mode.label')}
          description={t('settings.shortcuts.workLouderCodex.encoder.mode.description')}
          control={
            <SelectControl
              value={settings.layout.encoderMode}
              disabled={!state || saving}
              ariaLabel={t('settings.shortcuts.workLouderCodex.encoder.mode.label')}
              onChange={(value) =>
                patchLayout((layout) => {
                  layout.encoderMode = value as WorkLouderCodexLayout['encoderMode'];
                })
              }
            >
              {WORKLOUDER_CODEX_ENCODER_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`settings.shortcuts.workLouderCodex.encoder.mode.options.${mode}`)}
                </option>
              ))}
            </SelectControl>
          }
        />
        {settings.layout.encoderMode === 'custom' &&
          WORKLOUDER_CODEX_ENCODER_ACTIONS.map((gesture) => (
            <div key={gesture}>
              <SettingsDivider />
              <SettingsRow
                label={t(`settings.shortcuts.workLouderCodex.encoder.gestures.${gesture}`)}
                description={t('settings.shortcuts.workLouderCodex.encoder.customDescription')}
                control={
                  <ActionSelect
                    action={settings.layout.encoder[gesture]}
                    state={state}
                    skills={enabledSkills}
                    disabled={!state || saving}
                    emptyLabel={t('settings.shortcuts.workLouderCodex.actions.none')}
                    onChange={(action) =>
                      patchLayout((layout) => {
                        layout.encoder[gesture] = action;
                      })
                    }
                  />
                }
              />
            </div>
          ))}
      </SettingsGroup>

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
            <SelectControl
              value={settings.lightingAutoDim}
              disabled={!state || saving}
              ariaLabel={t('settings.shortcuts.workLouderCodex.lighting.autoDim.aria')}
              onChange={(value) =>
                void setSettings({ lightingAutoDim: value as WorkLouderCodexAutoDim })
              }
            >
              {WORKLOUDER_CODEX_AUTO_DIM_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`settings.shortcuts.workLouderCodex.lighting.autoDim.options.${option}`)}
                </option>
              ))}
            </SelectControl>
          }
        />
      </SettingsGroup>

      <SettingsCard className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.shortcuts.workLouderCodex.layout.reset.title')}
          </p>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t('settings.shortcuts.workLouderCodex.layout.reset.description')}
          </p>
        </div>
        <button
          type="button"
          disabled={!state || saving}
          onClick={() =>
            void setSettings({
              layout: cloneWorkLouderCodexLayout(WORKLOUDER_CODEX_DEFAULT_LAYOUT),
            })
          }
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-12 text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={13} />
          {t('settings.shortcuts.workLouderCodex.layout.reset.button')}
        </button>
      </SettingsCard>
    </div>
  );
}

function ActionSelect({
  action,
  state,
  skills,
  disabled,
  emptyLabel,
  allowTasks = false,
  allowKeycaps = false,
  onChange,
  className,
}: {
  action: WorkLouderCodexAction | null;
  state: WorkLouderCodexState | null;
  skills: SkillhubSkill[];
  disabled: boolean;
  emptyLabel: string;
  allowTasks?: boolean;
  allowKeycaps?: boolean;
  onChange(action: WorkLouderCodexAction | null): void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <SelectControl
      value={actionValue(action)}
      disabled={disabled}
      ariaLabel={t('settings.shortcuts.workLouderCodex.actions.choose')}
      onChange={(value) => onChange(parseActionValue(value, state, skills))}
      className={cn('min-w-[190px]', className)}
    >
      <option value="none">{emptyLabel}</option>
      {allowTasks && state && state.taskOptions.length > 0 && (
        <optgroup label={t('settings.shortcuts.workLouderCodex.actions.tasks')}>
          {state.taskOptions.map((task) => (
            <option key={task.id} value={`task:${task.id}`}>
              {task.title}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={t('settings.shortcuts.workLouderCodex.actions.commands')}>
        {WORKLOUDER_CODEX_COMMAND_IDS.map((commandId) => (
          <option key={commandId} value={`command:${commandId}`}>
            {formatCommandLabel(commandId)}
          </option>
        ))}
      </optgroup>
      {allowKeycaps && (
        <optgroup label={t('settings.shortcuts.workLouderCodex.actions.keycaps')}>
          {WORKLOUDER_CODEX_KEYCAP_IDS.map((keycapId) => (
            <option key={keycapId} value={`keycap:${keycapId}`}>
              {keycapId}
            </option>
          ))}
        </optgroup>
      )}
      {skills.length > 0 && (
        <optgroup label={t('settings.shortcuts.workLouderCodex.actions.skills')}>
          {skills.map((skill) => (
            <option key={skill.id} value={`skill:${skill.id}`}>
              {skill.name}
            </option>
          ))}
        </optgroup>
      )}
    </SelectControl>
  );
}

function SelectControl({
  value,
  disabled,
  ariaLabel,
  onChange,
  children,
  className,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange(value: string): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-[150px]', className)}>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={cn(
          'h-9 w-full appearance-none rounded-full border py-0 pl-3 pr-8 text-12 outline-none',
          'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
          'focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50',
        )}
        aria-label={ariaLabel}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--settings-input-text)] opacity-70"
        aria-hidden="true"
      />
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
    <div className="flex flex-wrap items-center justify-between gap-5 py-2">
      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{label}</p>
        <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">{description}</p>
      </div>
      <div className="min-w-0 shrink-0 max-sm:w-full">{control}</div>
    </div>
  );
}

function SettingsDivider() {
  return <div className="my-1 h-px bg-[var(--settings-theme-card-border)]" />;
}

function DeviceChip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-2 py-1 text-11 text-[var(--text-secondary)]">
      {icon}
      {children}
    </span>
  );
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

function connectionDescription(
  t: ReturnType<typeof useTranslation>['t'],
  state: WorkLouderCodexState | null,
): string {
  const key = state?.connectionReason ?? state?.connectionStatus ?? 'connecting';
  return t(`settings.shortcuts.workLouderCodex.connection.descriptions.${key}`);
}

function actionValue(action: WorkLouderCodexAction | null): string {
  if (!action) return 'none';
  switch (action.type) {
    case 'command':
      return `command:${action.commandId}`;
    case 'task':
      return `task:${action.sessionId}`;
    case 'keycap':
      return `keycap:${action.keycapId}`;
    case 'skill':
      return `skill:${action.skillId}`;
    case 'composer-text':
      return `text:${action.text}`;
    case 'external-url':
      return `url:${action.url}`;
  }
}

function parseActionValue(
  value: string,
  state: WorkLouderCodexState | null,
  skills: SkillhubSkill[],
): WorkLouderCodexAction | null {
  if (value === 'none') return null;
  if (value.startsWith('command:')) {
    return { type: 'command', commandId: value.slice(8) as WorkLouderCodexCommandId };
  }
  if (value.startsWith('task:')) {
    const sessionId = value.slice(5);
    return state?.taskOptions.some((task) => task.id === sessionId)
      ? { type: 'task', sessionId }
      : null;
  }
  if (value.startsWith('keycap:')) {
    return { type: 'keycap', keycapId: value.slice(7) as WorkLouderCodexKeycapId };
  }
  if (value.startsWith('skill:')) {
    const skillId = value.slice(6);
    const skill = skills.find((item) => item.id === skillId);
    return skill ? { type: 'skill', skillId, name: skill.name } : null;
  }
  if (value.startsWith('text:')) {
    return { type: 'composer-text', text: value.slice(5) };
  }
  if (value.startsWith('url:')) {
    const url = value.slice(4);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    return { type: 'external-url', url };
  }
  return null;
}

function formatCommandLabel(commandId: string): string {
  return commandId
    .split('.')
    .at(-1)!
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

export type { WorkLouderCodexSettingsPatch };
