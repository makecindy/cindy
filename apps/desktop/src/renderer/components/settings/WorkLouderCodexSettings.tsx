import {
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ArrowLeft,
  BatteryCharging,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Keyboard,
  RotateCcw,
  Usb,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import * as Select from '@radix-ui/react-select';
import { Switch } from '@/components/ui/switch';
import { useCodexMicroGuard } from '@/hooks/useCodexMicroGuard';
import { useWorkLouderCodex } from '@/hooks/useWorkLouderCodex';
import { useSkillhub } from '@/features/skillhub/hooks/useSkillhub';
import { cn } from '@/lib/utils';
import {
  WorkLouderCodexKeyboardLayout,
  WorkLouderCodexKeycapPicker,
  WorkLouderCodexPartEditor,
  type WorkLouderCodexAgentKey,
  type WorkLouderCodexControlPart,
  type WorkLouderCodexEditableKey,
  type WorkLouderCodexKeyHint,
} from './WorkLouderCodexKeyboardLayout';
import {
  workLouderCodexCommandDescription,
  workLouderCodexCommandName,
} from './workLouderCodexCommandCopy';
import {
  InputDeviceConnectionStatus,
  inputDeviceConnectionTone,
  inputDeviceStatusLabelKey,
  resolveInputDeviceStatusKey,
} from './InputDeviceConnectionStatus';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_AGENT_SOURCES,
  WORKLOUDER_CODEX_ANALOG_DIRECTIONS,
  WORKLOUDER_CODEX_AUTO_DIM_OPTIONS,
  WORKLOUDER_CODEX_COMMAND_IDS,
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CODEX_ENCODER_ACTIONS,
  WORKLOUDER_CODEX_ENCODER_MODES,
  WORKLOUDER_CODEX_KEYCAP_ACTIONS,
  WORKLOUDER_CODEX_KEYCAP_IDS,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  canonicalizeWorkLouderCodexKeycapId,
  cloneWorkLouderCodexLayout,
  createWorkLouderCodexDefaultSettings,
  creatorCommandAssignment,
  isCreatorTaskKey,
  isWorkLouderCodexBlankKeycap,
  isWorkLouderCreatorProgrammableKey,
  normalizeWorkLouderCreatorTaskKeys,
  workLouderTaskKeysForLayout,
  workLouderLayoutMerges,
  workLouderMergeForKey,
  workLouderAvailableMergeDirections,
  addWorkLouderMerge,
  removeWorkLouderMerge,
  workLouderMicrophoneKeysSeparate,
  isWorkLouderCodexDoubleKeycap,
  isWorkLouderCodexMicrophoneKeycap,
  type WorkLouderMergeDirection,
  type WorkLouderCodexAction,
  type WorkLouderCodexAgentSource,
  type WorkLouderCodexAutoDim,
  type WorkLouderCodexCommandId,
  type WorkLouderCodexCommandSlot,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexKeycapId,
  type WorkLouderCodexLayout,
  type WorkLouderCreatorProgrammableKey,
  type WorkLouderCodexPreviewInput,
  type WorkLouderCodexPreviewPart,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderCodexState,
  type WorkLouderModel,
} from '../../../shared/workLouderCodex';

function workLouderCopyKey(model: WorkLouderModel, suffix: string): string {
  return model === 'creator-micro-2'
    ? `settings.shortcuts.workLouderCodex.models.creatorMicro2.${suffix}`
    : `settings.shortcuts.workLouderCodex.${suffix}`;
}

function blankKeycapLegend(
  keycapId: WorkLouderCodexKeycapId,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return isWorkLouderCodexBlankKeycap(keycapId)
    ? t('settings.shortcuts.workLouderCodex.layout.editor.blank')
    : keycapId;
}

function applyPreviewInput(
  input: WorkLouderCodexPreviewInput,
  setPressedParts: Dispatch<SetStateAction<ReadonlySet<WorkLouderCodexPreviewPart>>>,
  setEncoderTurns: Dispatch<SetStateAction<number>>,
  setAnalogStick: Dispatch<SetStateAction<{ angle: number; distance: number } | null>>,
): void {
  setPressedParts((current) => {
    const next = new Set(current);
    if (input.pressed) next.add(input.part);
    else next.delete(input.part);
    return next;
  });
  if (input.part === 'encoder' && input.turn) {
    const turn = input.turn;
    setEncoderTurns((current) => current + turn);
  }
  if (input.part === 'analog') {
    const distance = input.distance ?? 0;
    setAnalogStick(distance > 0 ? { angle: input.angle ?? 0, distance } : null);
  }
}

interface WorkLouderCodexEntryProps {
  model?: WorkLouderModel;
  state: WorkLouderCodexState | null;
  loading: boolean;
  grouped?: boolean;
  onOpen(): void;
}

export function WorkLouderCodexEntry({
  model = 'codex-micro',
  state,
  loading,
  grouped = false,
  onOpen,
}: WorkLouderCodexEntryProps) {
  const { t } = useTranslation();
  const enabled = state?.settings.deviceEnabled ?? false;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-3 text-left outline-none transition-colors',
        grouped
          ? 'rounded-none border-0 bg-transparent px-4 py-[14px]'
          : 'rounded-xl border p-4 border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
        'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
      )}
      aria-label={t(workLouderCopyKey(model, 'openAria'))}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <CodexMicroGlyph />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]">
          {t(workLouderCopyKey(model, 'title'))}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
          {t(workLouderCopyKey(model, 'entryDescription'))}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <ConnectionStatus
          enabled={enabled}
          present={state?.devicePresent ?? null}
          connectionStatus={state?.connectionStatus}
          loading={loading}
          compact
        />
        <ChevronRight size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      </span>
    </button>
  );
}

export function WorkLouderCodexEntryContainer({
  model = 'codex-micro',
  onOpen,
}: {
  model?: WorkLouderModel;
  onOpen(): void;
}) {
  const { state, loading } = useWorkLouderCodex({ model, watchConnection: true });
  return <WorkLouderCodexEntry model={model} state={state} loading={loading} onOpen={onOpen} />;
}

export function WorkLouderCodexSettings({
  model = 'codex-micro',
  onBack,
}: {
  model?: WorkLouderModel;
  onBack(): void;
}) {
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
  } = useWorkLouderCodex({ model, watchConnection: true });
  const {
    state: guardState,
    loading: guardLoading,
    saving: guardSaving,
    error: guardError,
    setEnabled: setGuardEnabled,
    recover: recoverGuard,
  } = useCodexMicroGuard();
  const { skills, bootstrapped, refresh: refreshSkills } = useSkillhub();
  const [brightnessDraft, setBrightnessDraft] = useState(100);
  const [editingSlot, setEditingSlot] = useState<
    WorkLouderCodexCommandSlot | WorkLouderCreatorProgrammableKey | null
  >(null);
  const [editingKeycapId, setEditingKeycapId] = useState<WorkLouderCodexKeycapId | null>(null);
  const [editingAction, setEditingAction] = useState<WorkLouderCodexAction | null>(null);
  const [editingSeparateMicrophoneKeys, setEditingSeparateMicrophoneKeys] = useState(false);
  const [keycapQuery, setKeycapQuery] = useState('');
  const [editingPart, setEditingPart] = useState<WorkLouderCodexEditableKey | null>(null);
  const [pressedParts, setPressedParts] = useState<ReadonlySet<WorkLouderCodexPreviewPart>>(
    () => new Set(),
  );
  const [encoderTurns, setEncoderTurns] = useState(0);
  const [analogStick, setAnalogStick] = useState<{ angle: number; distance: number } | null>(null);
  const settings = state?.settings ?? createWorkLouderCodexDefaultSettings(model);
  const enabledSkills = useMemo(
    () => skills.filter((skill) => skill.kind === 'skill' && !skill.parseError),
    [skills],
  );
  const isDefault =
    state !== null && workLouderCodexSettingsMatchRestoreDefaults(state.settings, model);
  const isDefaultLayout =
    JSON.stringify(settings.layout) ===
    JSON.stringify(createWorkLouderCodexDefaultSettings(model).layout);

  useEffect(() => {
    if (state) setBrightnessDraft(state.settings.lightingBrightness);
  }, [state?.settings.lightingBrightness]);

  useEffect(() => {
    if (!bootstrapped) void refreshSkills();
  }, [bootstrapped, refreshSkills]);

  useEffect(() => {
    const api = window.electronAPI?.workLouderCodex;
    void api?.setLayoutPreviewActive?.(true, model);
    return () => {
      void api?.setLayoutPreviewActive?.(false, model);
    };
  }, [model]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.workLouderCodex?.onPreviewInput?.((input) => {
      applyPreviewInput(input, setPressedParts, setEncoderTurns, setAnalogStick);
    });
    return () => unsubscribe?.();
  }, []);

  const commitBrightness = (): void => {
    if (!state || brightnessDraft === state.settings.lightingBrightness) return;
    void setSettings({ lightingBrightness: brightnessDraft });
  };

  const patchLayout = (update: (layout: WorkLouderCodexLayout) => void): void => {
    const layout = cloneWorkLouderCodexLayout(settings.layout);
    update(layout);
    void setSettings({ layout });
  };

  const layoutMerges = workLouderLayoutMerges(settings.layout);

  const applyCommandKeycap = (
    layout: WorkLouderCodexLayout,
    slot: string,
    keycapId: WorkLouderCodexKeycapId,
  ): void => {
    const current = creatorCommandAssignment(layout, slot as WorkLouderCreatorProgrammableKey);
    layout.slots[slot as WorkLouderCodexCommandSlot] = { ...current, keycapId };
    if (slot === 'ACT10') {
      layout.slots.ACT10_ACT11 = { ...layout.slots.ACT10 };
    }
  };

  /**
   * Every part of the board is configured by clicking it. A command key opens
   * the keycap library; the other parts open a small editor of their own. That
   * is why the panel below carries no per-key rows.
   */
  const setCreatorTaskKey = (key: WorkLouderCreatorProgrammableKey, isTask: boolean): void => {
    patchLayout((layout) => {
      const selected = new Set(normalizeWorkLouderCreatorTaskKeys(layout.taskKeys));
      if (isTask) selected.add(key);
      else selected.delete(key);
      layout.taskKeys = workLouderTaskKeysForLayout({
        ...layout,
        taskKeys: WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.filter((item) => selected.has(item)),
      });
    });
    if (isTask) {
      closeKeycapEditor();
      setEditingPart(key);
      return;
    }
    const assignment = creatorCommandAssignment(settings.layout, key);
    setEditingPart(null);
    setEditingSlot(key);
    setEditingKeycapId(assignment.keycapId);
    setEditingAction(assignment.action);
    setEditingSeparateMicrophoneKeys(settings.layout.separateMicrophoneKeys);
    setKeycapQuery('');
  };

  const creatorKeyRoleRow = (key: WorkLouderCreatorProgrammableKey, isTask: boolean): ReactNode => (
    <>
      <SettingsRow
        label={t('settings.shortcuts.workLouderCodex.agentKeys.role.label')}
        description={t('settings.shortcuts.workLouderCodex.agentKeys.role.description')}
        control={
          <CreatorKeyRoleChoice
            isTask={isTask}
            disabled={!state}
            taskLabel={t('settings.shortcuts.workLouderCodex.agentKeys.role.task')}
            actionLabel={t('settings.shortcuts.workLouderCodex.agentKeys.role.action')}
            ariaLabel={t('settings.shortcuts.workLouderCodex.agentKeys.role.label')}
            onChange={(next) => setCreatorTaskKey(key, next)}
          />
        }
      />
      {isTask ? (
        <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
          {t('settings.shortcuts.workLouderCodex.agentKeys.taskHint')}
        </p>
      ) : null}
    </>
  );

  const editingProgrammableActionKey =
    editingSlot !== null && isWorkLouderCreatorProgrammableKey(editingSlot);
  const editingProgrammableTaskKey =
    editingPart !== null && isWorkLouderCreatorProgrammableKey(editingPart);
  const editingTaskIndex =
    editingProgrammableTaskKey && isWorkLouderCreatorProgrammableKey(editingPart)
      ? normalizeWorkLouderCreatorTaskKeys(settings.layout.taskKeys).indexOf(editingPart)
      : -1;

  const openPartEditor = (key: WorkLouderCodexEditableKey): void => {
    if (isWorkLouderCreatorProgrammableKey(key)) {
      if (isCreatorTaskKey(settings.layout, key)) {
        setEditingPart(key);
        return;
      }
      const assignment = creatorCommandAssignment(settings.layout, key);
      setEditingSlot(key);
      setEditingKeycapId(assignment.keycapId);
      setEditingAction(assignment.action);
      setEditingSeparateMicrophoneKeys(settings.layout.separateMicrophoneKeys);
      setKeycapQuery('');
      return;
    }
    if (key.startsWith('ACT')) {
      const slot = key as WorkLouderCodexCommandSlot;
      setEditingSlot(slot);
      setEditingKeycapId(settings.layout.slots[slot].keycapId);
      setEditingAction(settings.layout.slots[slot].action);
      setEditingSeparateMicrophoneKeys(settings.layout.separateMicrophoneKeys);
      setKeycapQuery('');
      return;
    }
    // A task key is only its own thing under "custom"; otherwise all six follow
    // the shared rule and there is nothing per-key to edit.
    if (key.startsWith('AG') && settings.agentSource !== 'custom') return;
    setEditingPart(key);
  };

  const closeKeycapEditor = (): void => {
    setEditingSlot(null);
    setEditingKeycapId(null);
    setEditingAction(null);
    setEditingSeparateMicrophoneKeys(false);
    setKeycapQuery('');
  };

  const saveKeycapEditor = (): void => {
    if (!editingSlot || !editingKeycapId) return;
    const slot = editingSlot;
    patchLayout((layout) => {
      const merged = workLouderMergeForKey(workLouderLayoutMerges(layout), slot)?.origin === slot;
      let keycapId = canonicalizeWorkLouderCodexKeycapId(editingKeycapId);
      if (keycapId !== 'MIC' && merged !== isWorkLouderCodexDoubleKeycap(keycapId)) {
        keycapId = merged ? 'EMPT5' : 'EMPT1';
      }
      const action = editingAction;
      applyCommandKeycap(layout, slot, keycapId);
      layout.slots[slot as WorkLouderCodexCommandSlot] = {
        ...creatorCommandAssignment(layout, slot as WorkLouderCreatorProgrammableKey),
        keycapId,
        action,
      };
      if (slot === 'ACT10') {
        layout.slots.ACT10_ACT11 = { ...layout.slots.ACT10 };
      }
      layout.taskKeys = workLouderTaskKeysForLayout(layout);
    });
    closeKeycapEditor();
  };

  const mergeEditingKey = (
    origin: WorkLouderCreatorProgrammableKey,
    direction: WorkLouderMergeDirection,
  ): void => {
    const previousAction = creatorCommandAssignment(settings.layout, origin).action;
    patchLayout((layout) => {
      layout.merges = addWorkLouderMerge(workLouderLayoutMerges(layout), origin, direction);
      layout.separateMicrophoneKeys = workLouderMicrophoneKeysSeparate(layout.merges);
      const assignment = creatorCommandAssignment(layout, origin);
      const nextKeycap = isWorkLouderCodexMicrophoneKeycap(assignment.keycapId)
        ? 'MIC'
        : isWorkLouderCodexDoubleKeycap(assignment.keycapId)
          ? assignment.keycapId
          : 'EMPT5';
      layout.slots[origin] = { ...assignment, keycapId: nextKeycap };
      layout.taskKeys = workLouderTaskKeysForLayout(layout);
    });
    setEditingPart(null);
    setEditingSlot(origin);
    setEditingKeycapId(
      isWorkLouderCodexMicrophoneKeycap(creatorCommandAssignment(settings.layout, origin).keycapId)
        ? 'MIC'
        : 'EMPT5',
    );
    setEditingAction(previousAction);
    setKeycapQuery('');
  };

  const splitEditingKey = (key: WorkLouderCreatorProgrammableKey): void => {
    const previous = creatorCommandAssignment(settings.layout, key);
    const wasMic = isWorkLouderCodexMicrophoneKeycap(previous.keycapId);
    patchLayout((layout) => {
      layout.merges = removeWorkLouderMerge(workLouderLayoutMerges(layout), key);
      layout.separateMicrophoneKeys = workLouderMicrophoneKeysSeparate(layout.merges);
      const assignment = creatorCommandAssignment(layout, key);
      if (isWorkLouderCodexDoubleKeycap(assignment.keycapId) && !wasMic) {
        layout.slots[key] = { ...assignment, keycapId: 'EMPT1' };
      }
      layout.taskKeys = workLouderTaskKeysForLayout(layout);
    });
    setEditingPart(null);
    setEditingSlot(key);
    setEditingKeycapId(wasMic ? 'MIC' : 'EMPT1');
    setEditingAction(previous.action);
  };

  const hintFor = (key: WorkLouderCodexEditableKey): WorkLouderCodexKeyHint | null => {
    if (isWorkLouderCreatorProgrammableKey(key) && isCreatorTaskKey(settings.layout, key)) {
      const index = normalizeWorkLouderCreatorTaskKeys(settings.layout.taskKeys).indexOf(key);
      const slot = state?.agentSlots[index];
      const custom = settings.agentSource === 'custom';
      return {
        legend: key,
        name: custom
          ? index >= 0 && index < settings.customAgentKeys.length
            ? (actionLabel(settings.customAgentKeys[index] ?? null, t, state) ??
              t('settings.shortcuts.workLouderCodex.agentKeys.newTask'))
            : slot?.title || t('settings.shortcuts.workLouderCodex.agentKeys.newTask')
          : slot?.title || t('settings.shortcuts.workLouderCodex.agentKeys.newTask'),
        description: custom
          ? t('settings.shortcuts.workLouderCodex.agentKeys.customDescription')
          : t(
              `settings.shortcuts.workLouderCodex.agentKeys.source.options.${settings.agentSource}`,
            ),
      };
    }
    if (key === 'analog') {
      return {
        legend: t('settings.shortcuts.workLouderCodex.layout.keyboard.analogStick'),
        name: t('settings.shortcuts.workLouderCodex.analog.description'),
      };
    }
    if (key === 'encoder') {
      return {
        legend: t('settings.shortcuts.workLouderCodex.layout.keyboard.encoder'),
        name: t(
          `settings.shortcuts.workLouderCodex.encoder.mode.options.${settings.layout.encoderMode}`,
        ),
        description: t('settings.shortcuts.workLouderCodex.encoder.mode.description'),
      };
    }
    const assignment = isWorkLouderCreatorProgrammableKey(key)
      ? creatorCommandAssignment(settings.layout, key)
      : settings.layout.slots[key as WorkLouderCodexCommandSlot];
    const action =
      assignment.action ?? WORKLOUDER_CODEX_KEYCAP_ACTIONS[assignment.keycapId] ?? null;
    if (isWorkLouderCodexMicrophoneKeycap(assignment.keycapId)) {
      return {
        legend: assignment.keycapId,
        name: t('settings.shortcuts.workLouderCodex.actions.voice'),
        description: t('settings.shortcuts.workLouderCodex.microphone.separate.description'),
      };
    }
    if (action) {
      return {
        legend: blankKeycapLegend(assignment.keycapId, t),
        name:
          actionLabel(action, t, state) ??
          t('settings.shortcuts.workLouderCodex.commandKeys.builtIn'),
        description:
          action.type === 'command'
            ? workLouderCodexCommandDescription(t, action.commandId)
            : undefined,
      };
    }
    return {
      legend: blankKeycapLegend(assignment.keycapId, t),
      name: t('settings.shortcuts.workLouderCodex.commandKeys.unmapped'),
    };
  };

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
            {t(workLouderCopyKey(model, 'title'))}
          </h2>
        </div>
        <SettingsResetButton
          label={t('settings.shortcuts.reset')}
          disabled={!state || saving || isDefault}
          onClick={() => void resetSettings()}
        />
      </div>

      <SettingsCard className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('settings.shortcuts.workLouderCodex.connection.toggle.label')}
            </p>
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.deviceEnabled}
                disabled={!state || saving}
                onCheckedChange={(checked) => void setSettings({ deviceEnabled: checked })}
                aria-label={t(workLouderCopyKey(model, 'connection.toggle.aria'))}
              />
              <ConnectionStatus
                enabled={settings.deviceEnabled}
                present={state?.devicePresent ?? null}
                connectionStatus={state?.connectionStatus}
                loading={loading}
              />
            </div>
          </div>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {settings.deviceEnabled
              ? connectionDescription(t, model, state)
              : presenceDescription(t, model)}
          </p>
          {((settings.deviceEnabled && state?.connectionStatus === 'connected') ||
            state?.devicePresent === true) &&
            state?.device.deviceType && (
              <div className="flex flex-wrap gap-2 pt-1">
                <DeviceChip icon={<Keyboard size={12} />}>
                  {state.device.deviceType === 'creator-micro-2'
                    ? 'Creator Micro 2'
                    : 'Codex Micro'}
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
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-13 font-medium text-[var(--text-primary)]">
              {t('settings.shortcuts.workLouderCodex.layout.keyboard.title')}
            </h3>
            <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
              {t('settings.shortcuts.workLouderCodex.layout.keyboard.description')}
            </p>
          </div>
          <SettingsResetButton
            label={t('settings.shortcuts.workLouderCodex.layout.reset.button')}
            title={t('settings.shortcuts.workLouderCodex.layout.reset.description')}
            disabled={!state || saving || isDefaultLayout}
            onClick={() =>
              void setSettings({
                layout: cloneWorkLouderCodexLayout(
                  createWorkLouderCodexDefaultSettings(model).layout,
                ),
              })
            }
          />
        </div>
        <div className="flex justify-center">
          <WorkLouderCodexKeyboardLayout
            layout={settings.layout}
            agentSlots={state?.agentSlots ?? []}
            disabled={!state || saving}
            model={model}
            labels={{
              analogStick: t('settings.shortcuts.workLouderCodex.layout.keyboard.analogStick'),
              encoder: t('settings.shortcuts.workLouderCodex.layout.keyboard.encoder'),
              indicator: t('settings.shortcuts.workLouderCodex.layout.keyboard.indicator'),
            }}
            hintFor={hintFor}
            canEdit={(key) =>
              key === 'analog' ||
              key === 'encoder' ||
              key === 'ACT10_ACT11' ||
              isWorkLouderCreatorProgrammableKey(key)
            }
            onEditKeycap={openPartEditor}
            pressedParts={pressedParts}
            encoderTurns={encoderTurns}
            analogStick={analogStick}
          />
        </div>
      </SettingsCard>

      {/* Task keys follow one shared assignment rule. Picking "custom" is what
          makes them individually clickable. */}
      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.agentKeys.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.agentKeys.source.label')}
          description={t(
            `settings.shortcuts.workLouderCodex.agentKeys.source.descriptions.${settings.agentSource}`,
          )}
          control={
            <SelectControl
              value={settings.agentSource}
              disabled={!state || saving}
              ariaLabel={t('settings.shortcuts.workLouderCodex.agentKeys.source.label')}
              onChange={(value) =>
                void setSettings({ agentSource: value as WorkLouderCodexAgentSource })
              }
              options={WORKLOUDER_CODEX_AGENT_SOURCES.map((source) => ({
                value: source,
                label: t(`settings.shortcuts.workLouderCodex.agentKeys.source.options.${source}`),
              }))}
            />
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
        {normalizeWorkLouderCreatorTaskKeys(settings.layout.taskKeys).length >
          WORKLOUDER_CODEX_AGENT_SLOT_COUNT && (
          <>
            <SettingsDivider />
            <p className="px-1 py-2 text-12 leading-[1.45] text-[var(--text-secondary)]">
              {t('settings.shortcuts.workLouderCodex.agentKeys.lightingLimit')}
            </p>
          </>
        )}
      </SettingsGroup>

      <WorkLouderCodexKeycapPicker
        open={editingSlot !== null}
        slot={editingSlot}
        double={Boolean(
          editingSlot && workLouderMergeForKey(layoutMerges, editingSlot)?.origin === editingSlot,
        )}
        selectedKeycapId={editingKeycapId}
        query={keycapQuery}
        onQueryChange={setKeycapQuery}
        onOpenChange={(open) => {
          if (!open) closeKeycapEditor();
        }}
        onSelect={setEditingKeycapId}
        onCancel={closeKeycapEditor}
        onSave={saveKeycapEditor}
        header={
          editingProgrammableActionKey &&
          editingSlot &&
          isWorkLouderCreatorProgrammableKey(editingSlot)
            ? creatorKeyRoleRow(editingSlot, false)
            : undefined
        }
        copy={{
          title: t(
            editingProgrammableActionKey
              ? 'settings.shortcuts.workLouderCodex.layout.editor.keyTitle'
              : 'settings.shortcuts.workLouderCodex.layout.editor.title',
          ),
          description: t(
            editingProgrammableActionKey
              ? 'settings.shortcuts.workLouderCodex.layout.editor.keyDescription'
              : 'settings.shortcuts.workLouderCodex.layout.editor.description',
          ),
          searchPlaceholder: t(
            'settings.shortcuts.workLouderCodex.layout.editor.searchPlaceholder',
          ),
          close: t('settings.shortcuts.workLouderCodex.layout.editor.close'),
          cancel: t('settings.shortcuts.workLouderCodex.layout.editor.cancel'),
          save: t('settings.shortcuts.workLouderCodex.layout.editor.save'),
          blank: t('settings.shortcuts.workLouderCodex.layout.editor.blank'),
        }}
      >
        <div className="flex flex-col gap-3">
          <SettingsRow
            label={t('settings.shortcuts.workLouderCodex.layout.editor.assignedShortcut')}
            description={t('settings.shortcuts.workLouderCodex.commandKeys.builtInDescription')}
            control={
              <ActionSelect
                action={editingAction}
                state={state}
                skills={enabledSkills}
                disabled={!state || saving || !editingSlot}
                allowVoice
                emptyLabel={t('settings.shortcuts.workLouderCodex.commandKeys.builtIn')}
                onChange={setEditingAction}
              />
            }
          />
          {editingSlot && isWorkLouderCreatorProgrammableKey(editingSlot) && (
            <>
              <SettingsDivider />
              <KeyMergeControls
                origin={editingSlot}
                merges={layoutMerges}
                disabled={!state || saving}
                onMerge={(direction) => mergeEditingKey(editingSlot, direction)}
                onSplit={() => splitEditingKey(editingSlot)}
              />
            </>
          )}
        </div>
      </WorkLouderCodexKeycapPicker>

      {/* Task keys follow the shared order; custom source is the only per-key task pick. */}
      <WorkLouderCodexPartEditor
        open={Boolean(
          editingPart &&
          (editingPart.startsWith('AG') || isWorkLouderCreatorProgrammableKey(editingPart)),
        )}
        onOpenChange={(open) => {
          if (!open) setEditingPart(null);
        }}
        onConfirm={() => {
          if (editingPart && isWorkLouderCreatorProgrammableKey(editingPart)) {
            patchLayout((layout) => {
              const selected = new Set(normalizeWorkLouderCreatorTaskKeys(layout.taskKeys));
              selected.add(editingPart);
              layout.taskKeys = workLouderTaskKeysForLayout({
                ...layout,
                taskKeys: WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.filter((item) => selected.has(item)),
              });
            });
          }
        }}
        title={
          editingProgrammableTaskKey
            ? t('settings.shortcuts.workLouderCodex.layout.editor.keyTitle')
            : (editingPart ?? '')
        }
        description={
          editingProgrammableTaskKey
            ? t('settings.shortcuts.workLouderCodex.layout.editor.keyDescription')
            : t('settings.shortcuts.workLouderCodex.agentKeys.customDescription')
        }
        closeLabel={t('settings.shortcuts.workLouderCodex.layout.editor.done')}
      >
        {editingPart &&
          (editingPart.startsWith('AG') || isWorkLouderCreatorProgrammableKey(editingPart)) && (
            <div className="flex flex-col gap-3">
              {editingProgrammableTaskKey && isWorkLouderCreatorProgrammableKey(editingPart) && (
                <>
                  {creatorKeyRoleRow(editingPart, true)}
                  {editingTaskIndex >= WORKLOUDER_CODEX_AGENT_SLOT_COUNT && (
                    <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
                      {t('settings.shortcuts.workLouderCodex.agentKeys.unlitKey')}
                    </p>
                  )}
                </>
              )}
              {isWorkLouderCreatorProgrammableKey(editingPart) && (
                <KeyMergeControls
                  origin={editingPart}
                  merges={layoutMerges}
                  disabled={!state || saving}
                  onMerge={(direction) => mergeEditingKey(editingPart, direction)}
                  onSplit={() => splitEditingKey(editingPart)}
                />
              )}
              {settings.agentSource === 'custom' &&
                editingTaskIndex >= 0 &&
                editingTaskIndex < WORKLOUDER_CODEX_AGENT_SLOT_COUNT && (
                  <SettingsRow
                    label={t('settings.shortcuts.workLouderCodex.agentKeys.source.options.custom')}
                    description={t(
                      'settings.shortcuts.workLouderCodex.agentKeys.customDescription',
                    )}
                    control={
                      <ActionSelect
                        action={settings.customAgentKeys[editingTaskIndex] ?? null}
                        state={state}
                        skills={enabledSkills}
                        disabled={!state || saving}
                        emptyLabel={t('settings.shortcuts.workLouderCodex.agentKeys.newTask')}
                        allowTasks
                        allowKeycaps
                        onChange={(action) => {
                          if (
                            editingTaskIndex < 0 ||
                            editingTaskIndex >= settings.customAgentKeys.length
                          ) {
                            return;
                          }
                          const customAgentKeys = settings.customAgentKeys.map((item) =>
                            item ? { ...item } : null,
                          );
                          customAgentKeys[editingTaskIndex] = action;
                          void setSettings({ customAgentKeys });
                        }}
                      />
                    }
                  />
                )}
            </div>
          )}
      </WorkLouderCodexPartEditor>

      <WorkLouderCodexPartEditor
        open={editingPart === 'analog'}
        onOpenChange={(open) => {
          if (!open) setEditingPart(null);
        }}
        title={t('settings.shortcuts.workLouderCodex.analog.title')}
        description={t('settings.shortcuts.workLouderCodex.analog.description')}
        closeLabel={t('settings.shortcuts.workLouderCodex.layout.editor.done')}
      >
        <div className="flex flex-col gap-3">
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
        </div>
      </WorkLouderCodexPartEditor>

      <WorkLouderCodexPartEditor
        open={editingPart === 'encoder'}
        onOpenChange={(open) => {
          if (!open) setEditingPart(null);
        }}
        title={t('settings.shortcuts.workLouderCodex.encoder.title')}
        description={t('settings.shortcuts.workLouderCodex.encoder.mode.description')}
        closeLabel={t('settings.shortcuts.workLouderCodex.layout.editor.done')}
      >
        <div className="flex flex-col gap-3">
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
                options={WORKLOUDER_CODEX_ENCODER_MODES.map((mode) => ({
                  value: mode,
                  label: t(`settings.shortcuts.workLouderCodex.encoder.mode.options.${mode}`),
                }))}
              />
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
        </div>
      </WorkLouderCodexPartEditor>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-4 py-3 text-12 text-[var(--error-fg)]">
          <span>{t(workLouderCopyKey(model, `errors.${error}`))}</span>
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

      {state?.device.inputMonitoringPermission === 'denied' && (
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
              options={WORKLOUDER_CODEX_AUTO_DIM_OPTIONS.map((option) => ({
                value: option,
                label: t(`settings.shortcuts.workLouderCodex.lighting.autoDim.options.${option}`),
              }))}
            />
          }
        />
      </SettingsGroup>

      {/* Both keyboards share the same Codex service and machine-local guard. */}
      <SettingsGroup title={t('settings.shortcuts.workLouderCodex.codexGuard.title')}>
        <SettingsRow
          label={t('settings.shortcuts.workLouderCodex.codexGuard.label')}
          description={t(
            `settings.shortcuts.workLouderCodex.codexGuard.descriptions.${guardDescriptionKey(
              guardState?.status,
              guardError,
            )}`,
          )}
          control={
            <div className="flex items-center justify-end gap-2">
              {guardState?.enabled &&
                guardState.restartRequired &&
                !guardError &&
                (guardState.status === 'protecting' || guardState.status === 'intercepted') && (
                  <span className="text-12 text-[var(--text-secondary)]">
                    {t('settings.shortcuts.workLouderCodex.codexGuard.restartRequired')}
                  </span>
                )}
              {guardState?.status === 'recovery-required' ? (
                <SettingsSecondaryButton disabled={guardSaving} onClick={() => void recoverGuard()}>
                  {t('settings.shortcuts.workLouderCodex.codexGuard.recover')}
                </SettingsSecondaryButton>
              ) : (
                <Switch
                  checked={guardState?.enabled ?? false}
                  disabled={guardLoading || guardSaving || !guardState || !guardState.supported}
                  onCheckedChange={(checked) => void setGuardEnabled(checked)}
                  aria-label={t('settings.shortcuts.workLouderCodex.codexGuard.aria')}
                />
              )}
            </div>
          }
        />
      </SettingsGroup>
    </div>
  );
}

function KeyMergeControls({
  origin,
  merges,
  disabled,
  onMerge,
  onSplit,
}: {
  origin: WorkLouderCreatorProgrammableKey;
  merges: ReturnType<typeof workLouderLayoutMerges>;
  disabled: boolean;
  onMerge(direction: WorkLouderMergeDirection): void;
  onSplit(): void;
}) {
  const { t } = useTranslation();
  const current = workLouderMergeForKey(merges, origin);
  if (current?.origin === origin) {
    return (
      <SettingsRow
        label={t('settings.shortcuts.workLouderCodex.layout.merge.split')}
        description={t('settings.shortcuts.workLouderCodex.layout.merge.splitDescription')}
        control={
          <button
            type="button"
            disabled={disabled}
            onClick={onSplit}
            className="inline-flex h-8 shrink-0 items-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-12 font-medium text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('settings.shortcuts.workLouderCodex.layout.merge.split')}
          </button>
        }
      />
    );
  }
  const directions = workLouderAvailableMergeDirections(merges, origin);
  if (directions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {directions.map((direction) => (
        <SettingsRow
          key={direction}
          label={t(`settings.shortcuts.workLouderCodex.layout.merge.${direction}`)}
          description={t(`settings.shortcuts.workLouderCodex.layout.merge.${direction}Description`)}
          control={
            <button
              type="button"
              disabled={disabled}
              onClick={() => onMerge(direction)}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-12 font-medium text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t(`settings.shortcuts.workLouderCodex.layout.merge.${direction}`)}
            </button>
          }
        />
      ))}
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
  allowVoice = false,
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
  /** Only physical keys can hold-to-talk; stick, encoder, and task editors omit it. */
  allowVoice?: boolean;
  onChange(action: WorkLouderCodexAction | null): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const groups: SelectOptionGroup[] = [
    {
      options: [
        { value: 'none', label: emptyLabel },
        // Hold-to-talk voice on a physical key — how blank-cap boards bind it.
        ...(allowVoice
          ? [{ value: 'voice', label: t('settings.shortcuts.workLouderCodex.actions.voice') }]
          : []),
      ],
    },
  ];
  if (allowTasks && state && state.taskOptions.length > 0) {
    groups.push({
      label: t('settings.shortcuts.workLouderCodex.actions.tasks'),
      options: state.taskOptions.map((task) => ({
        value: `task:${task.id}`,
        label: task.title || t('ccAgent.common.unnamedSession'),
      })),
    });
  }
  groups.push({
    label: t('settings.shortcuts.workLouderCodex.actions.commands'),
    options: WORKLOUDER_CODEX_COMMAND_IDS.map((commandId) => ({
      value: `command:${commandId}`,
      label: workLouderCodexCommandName(t, commandId),
    })),
  });
  if (allowKeycaps) {
    groups.push({
      label: t('settings.shortcuts.workLouderCodex.actions.keycaps'),
      options: WORKLOUDER_CODEX_KEYCAP_IDS.filter(
        (keycapId) => WORKLOUDER_CODEX_KEYCAP_ACTIONS[keycapId],
      ).map((keycapId) => ({
        value: `keycap:${keycapId}`,
        label: keycapId,
      })),
    });
  }
  if (skills.length > 0) {
    groups.push({
      label: t('settings.shortcuts.workLouderCodex.actions.skills'),
      options: skills.map((skill) => ({
        value: `skill:${skill.id}`,
        label: skill.name,
      })),
    });
  }
  return (
    <SelectControl
      value={actionValue(action)}
      disabled={disabled}
      ariaLabel={t('settings.shortcuts.workLouderCodex.actions.choose')}
      onChange={(value) => onChange(parseActionValue(value, state, skills))}
      className={cn('min-w-[190px]', className)}
      groups={groups}
    />
  );
}

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectOptionGroup {
  label?: string;
  options: SelectOption[];
}

function SelectControl({
  value,
  disabled,
  ariaLabel,
  onChange,
  options,
  groups,
  className,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange(value: string): void;
  options?: SelectOption[];
  groups?: SelectOptionGroup[];
  className?: string;
}) {
  const resolvedGroups = groups ?? [{ options: options ?? [] }];
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 min-w-[150px] items-center justify-between gap-2 rounded-full border px-3 text-12',
          'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
          'outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
          'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
          className,
        )}
      >
        <span className="min-w-0 truncate text-left">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <ChevronDown size={14} className="shrink-0 opacity-70" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={4}
          className={cn(
            'z-[10010] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border p-1.5',
            'max-h-[min(15rem,var(--radix-select-content-available-height))]',
            'border-[var(--border-default)] bg-[var(--surface-elevated)]',
          )}
        >
          <Select.ScrollUpButton className="flex h-5 items-center justify-center text-[var(--text-tertiary)]">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport>
            {resolvedGroups.map((group, groupIndex) => (
              <Select.Group key={group.label ?? `group-${groupIndex}`}>
                {group.label && (
                  <Select.Label className="px-2.5 py-1 text-11 text-[var(--text-tertiary)]">
                    {group.label}
                  </Select.Label>
                )}
                {group.options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={cn(
                      'flex w-full cursor-pointer select-none items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-12 outline-none',
                      'text-[var(--text-primary)]',
                      'data-[highlighted]:bg-[var(--surface-hover)]',
                      'data-[state=checked]:font-medium',
                      'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
                    )}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <Select.ItemIndicator>
                        <Check size={14} strokeWidth={2.25} />
                      </Select.ItemIndicator>
                    </span>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="flex h-5 items-center justify-center text-[var(--text-tertiary)]">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/**
 * Restore control for this device page.
 * Always a compact icon+label button at the top-right of the unit it resets
 * (page title or section header). Never a text link, never a standalone card.
 */
function SettingsResetButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 font-medium',
        'border border-[var(--settings-input-border)]',
        'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
        'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <RotateCcw size={13} aria-hidden />
      {label}
    </button>
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

function CreatorKeyRoleChoice({
  isTask,
  disabled,
  taskLabel,
  actionLabel,
  ariaLabel,
  onChange,
}: {
  isTask: boolean;
  disabled: boolean;
  taskLabel: string;
  actionLabel: string;
  ariaLabel: string;
  onChange: (isTask: boolean) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex h-8 items-center rounded-full bg-[var(--surface-chip)] p-0.5"
    >
      {(
        [
          { task: true, label: taskLabel },
          { task: false, label: actionLabel },
        ] as const
      ).map((option) => {
        const selected = option.task === isTask;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || selected}
            onClick={() => onChange(option.task)}
            className={cn(
              'h-full rounded-full px-3 text-12 leading-none',
              selected
                ? 'border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsDivider() {
  return <div className="my-1 h-px bg-[var(--settings-theme-card-border)]" />;
}

function SettingsSecondaryButton({
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'>) {
  return (
    <button
      {...props}
      type="button"
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-12 text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
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
  enabled,
  present = null,
  connectionStatus = null,
  loading,
  compact = false,
}: {
  enabled: boolean;
  present?: boolean | null;
  connectionStatus?: WorkLouderCodexConnectionStatus | null;
  loading: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const key = resolveInputDeviceStatusKey({
    enabled,
    present,
    connectionStatus,
    loading,
  });
  return (
    <InputDeviceConnectionStatus
      label={t(
        `settings.shortcuts.workLouderCodex.connection.status.${inputDeviceStatusLabelKey(key)}`,
      )}
      tone={inputDeviceConnectionTone({ status: key, present })}
      compact={compact}
    />
  );
}

/**
 * Icon for the Codex Micro entry row: the device's own silhouette rather than a
 * generic keyboard. Round controls in the top corners, six task keys, a row of
 * command keys, and the double-width microphone — the same shape as the board
 * on the detail page, reduced to what still reads at 20px.
 *
 * Drawn as SVG so the 4.5-unit keys stay crisp, and in `currentColor` so it
 * picks up the chip's text colour in both themes.
 */
function CodexMicroGlyph() {
  // Four columns of 4.5 with 1 between them, inset half a unit.
  const track = [0.5, 6, 11.5, 17];
  return (
    <svg width={20} height={20} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      {/* Row 1 — encoder, two task keys, analog stick. */}
      <circle cx={2.75} cy={2.75} r={2.25} fill="currentColor" opacity={0.55} />
      <rect x={6} y={0.5} width={4.5} height={4.5} rx={1} fill="currentColor" opacity={0.95} />
      <rect x={11.5} y={0.5} width={4.5} height={4.5} rx={1} fill="currentColor" opacity={0.95} />
      <circle cx={19.25} cy={2.75} r={2.25} fill="currentColor" opacity={0.55} />

      {/* Row 2 — the remaining four task keys, the brightest caps on the board. */}
      {track.map((x) => (
        <rect
          key={`task-${x}`}
          x={x}
          y={6}
          width={4.5}
          height={4.5}
          rx={1}
          fill="currentColor"
          opacity={0.95}
        />
      ))}

      {/* Row 3 — the four command keys. */}
      {track.map((x) => (
        <rect
          key={`command-${x}`}
          x={x}
          y={11.5}
          width={4.5}
          height={4.5}
          rx={1}
          fill="currentColor"
          opacity={0.45}
        />
      ))}

      {/* Row 4 — status lights, the double-width microphone key, Codex. */}
      <circle cx={2.75} cy={19.25} r={1} fill="currentColor" opacity={0.45} />
      <rect x={6} y={17} width={10} height={4.5} rx={1} fill="currentColor" opacity={0.45} />
      <rect x={17} y={17} width={4.5} height={4.5} rx={1} fill="currentColor" opacity={0.45} />
    </svg>
  );
}

function guardDescriptionKey(
  status: import('../../../shared/codexMicroGuard').CodexMicroGuardStatus | undefined,
  requestFailed: boolean,
): string {
  if (requestFailed) return 'error';
  switch (status) {
    case 'unsupported':
      return 'unsupported';
    case 'protecting':
    case 'intercepted':
      return 'disabled';
    case 'recovery-required':
      return 'recovery-required';
    case 'error':
      return 'error';
    case 'disabled':
    case undefined:
      return 'disabled';
  }
}

function connectionDescription(
  t: ReturnType<typeof useTranslation>['t'],
  model: WorkLouderModel,
  state: WorkLouderCodexState | null,
): string {
  const key = state?.connectionReason ?? state?.connectionStatus ?? 'connecting';
  return t(workLouderCopyKey(model, `connection.descriptions.${key}`));
}

function presenceDescription(
  t: ReturnType<typeof useTranslation>['t'],
  model: WorkLouderModel,
): string {
  return t(workLouderCopyKey(model, 'connection.descriptions.disabled'));
}

function workLouderCodexSettingsMatchRestoreDefaults(
  settings: WorkLouderCodexState['settings'],
  model: WorkLouderModel = 'codex-micro',
): boolean {
  const defaults = createWorkLouderCodexDefaultSettings(model);
  return (
    JSON.stringify({ ...settings, deviceEnabled: false }) ===
    JSON.stringify({ ...defaults, deviceEnabled: false })
  );
}

/**
 * Human-readable name for whatever a key is bound to, for the hover tooltip.
 * Returns null when the binding has no name worth showing on its own.
 */
function actionLabel(
  action: WorkLouderCodexAction | null,
  t?: ReturnType<typeof useTranslation>['t'],
  state?: WorkLouderCodexState | null,
): string | null {
  if (!action) return null;
  switch (action.type) {
    case 'command':
      return t ? workLouderCodexCommandName(t, action.commandId) : action.commandId;
    case 'voice':
      return t ? t('settings.shortcuts.workLouderCodex.actions.voice') : 'voice';
    case 'skill':
      return action.name;
    case 'keycap':
      return action.keycapId;
    case 'composer-text':
      return action.text;
    case 'external-url':
      return action.url;
    case 'task':
      return (
        state?.taskOptions.find((task) => task.id === action.sessionId)?.title ?? action.sessionId
      );
  }
}

function actionValue(action: WorkLouderCodexAction | null): string {
  if (!action) return 'none';
  switch (action.type) {
    case 'command':
      return `command:${action.commandId}`;
    case 'voice':
      return 'voice';
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
  if (value === 'voice') return { type: 'voice' };
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

export type { WorkLouderCodexSettingsPatch };
