import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  BatteryCharging,
  Bluetooth,
  Gamepad2,
  RotateCcw,
  Usb,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';

import { Switch } from '@/components/ui/switch';
import { useXboxGamepad } from '@/hooks/useXboxGamepad';
import { useSkillhub } from '@/features/skillhub/hooks/useSkillhub';
import { cn } from '@/lib/utils';
import {
  InputDeviceConnectionStatus,
  inputDeviceConnectionTone,
  inputDeviceStatusLabelKey,
  resolveInputDeviceStatusKey,
} from './InputDeviceConnectionStatus';
import {
  workLouderCodexCommandDescription,
  workLouderCodexCommandName,
} from './workLouderCodexCommandCopy';
import {
  XboxGamepadLayout,
  type XboxGamepadEditablePart,
  type XboxGamepadKeyHint,
} from './XboxGamepadLayout';
import { INPUT_DEVICE_COMMAND_IDS, type InputDeviceCommandId } from '../../../shared/inputDevices';
import {
  cloneXboxGamepadLayout,
  createXboxGamepadDefaultLayout,
  createXboxGamepadDefaultSettings,
  XBOX_GAMEPAD_STICK_DIRECTIONS,
  type XboxGamepadBinding,
  type XboxGamepadButtonId,
  type XboxGamepadConnectionStatus,
  type XboxGamepadDeviceInfo,
  type XboxGamepadLayout as XboxGamepadLayoutModel,
  type XboxGamepadPreviewInput,
  type XboxGamepadSettings as XboxGamepadSettingsModel,
  type XboxGamepadState,
  type XboxGamepadStickId,
  type XboxGamepadStickMode,
} from '../../../shared/xboxGamepad';

function ConnectionBadge({
  state,
  loading,
  compact = false,
}: {
  state: XboxGamepadState | null;
  loading: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const key = resolveInputDeviceStatusKey({
    enabled: state?.settings.deviceEnabled ?? false,
    present: state?.devicePresent,
    connectionStatus: state?.connectionStatus,
    loading,
  });
  return (
    <InputDeviceConnectionStatus
      label={t(
        `settings.shortcuts.xboxGamepad.connection.status.${inputDeviceStatusLabelKey(key)}`,
      )}
      tone={inputDeviceConnectionTone({ status: key, present: state?.devicePresent })}
      compact={compact}
    />
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

function XboxDeviceChips({ device }: { device: XboxGamepadDeviceInfo }) {
  const { t } = useTranslation();
  const label = deviceTitle(device);
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {label && (
        <DeviceChip icon={<Gamepad2 size={12} />}>{label}</DeviceChip>
      )}
      {device.transport === 'usb' && (
        <DeviceChip icon={<Usb size={12} />}>
          {t('settings.shortcuts.xboxGamepad.device.usb')}
        </DeviceChip>
      )}
      {device.transport === 'bluetooth' && (
        <DeviceChip icon={<Bluetooth size={12} />}>
          {t('settings.shortcuts.xboxGamepad.device.bluetooth')}
        </DeviceChip>
      )}
      {device.batteryPercentage !== null && (
        <DeviceChip
          icon={device.batteryState === 'charging' ? <BatteryCharging size={12} /> : undefined}
        >
          {device.batteryState === 'charging'
            ? t('settings.shortcuts.xboxGamepad.device.charging', {
                percent: device.batteryPercentage,
              })
            : t('settings.shortcuts.xboxGamepad.device.battery', {
                percent: device.batteryPercentage,
              })}
        </DeviceChip>
      )}
    </div>
  );
}

function deviceTitle(device: XboxGamepadDeviceInfo): string | null {
  const name = device.name?.trim() ?? '';
  const category = device.category?.trim() ?? '';
  if (name && name.toLowerCase() !== 'controller') return name;
  if (category) return category;
  return name || null;
}

export function XboxGamepadEntry({
  state,
  loading,
  grouped = false,
  onOpen,
}: {
  state: XboxGamepadState | null;
  loading: boolean;
  grouped?: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
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
      aria-label={t('settings.shortcuts.xboxGamepad.openAria')}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <Gamepad2 size={18} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]">
          {t('settings.shortcuts.xboxGamepad.title')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
          {t('settings.shortcuts.xboxGamepad.entryDescription')}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <ConnectionBadge state={state} loading={loading} compact />
        <ChevronRight size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      </span>
    </button>
  );
}

export function XboxGamepadEntryContainer({ onOpen }: { onOpen(): void }) {
  const { state, loading } = useXboxGamepad({ watchConnection: true });
  return <XboxGamepadEntry state={state} loading={loading} onOpen={onOpen} />;
}

function isStickPart(part: XboxGamepadEditablePart): part is XboxGamepadStickId {
  return part === 'left' || part === 'right';
}

function stickClickButton(stick: XboxGamepadStickId): XboxGamepadButtonId {
  return stick === 'left' ? 'ls' : 'rs';
}

export function XboxGamepadSettings({ onBack }: { onBack(): void }) {
  const { t } = useTranslation();
  const { state, loading, saving, error, setSettings, resetSettings, reload } = useXboxGamepad({
    watchConnection: true,
  });
  const { skills, bootstrapped, refresh: refreshSkills } = useSkillhub();
  const [preview, setPreview] = useState<XboxGamepadPreviewInput | null>(null);
  const [editing, setEditing] = useState<XboxGamepadEditablePart | null>(null);
  const settings = resolveXboxGamepadSettings(state?.settings);
  const enabled = settings.deviceEnabled;
  const key = resolveInputDeviceStatusKey({
    enabled,
    present: state?.devicePresent,
    connectionStatus: state?.connectionStatus,
    loading,
  });
  const enabledSkills = useMemo(
    () => skills.filter((skill) => skill.kind === 'skill' && !skill.parseError),
    [skills],
  );
  const isDefault =
    state !== null && xboxGamepadSettingsMatchRestoreDefaults(settings);

  useEffect(() => {
    if (!bootstrapped) void refreshSkills();
  }, [bootstrapped, refreshSkills]);

  useEffect(() => {
    const api = window.electronAPI?.xboxGamepad;
    void api?.setLayoutPreviewActive?.(true);
    return () => {
      void api?.setLayoutPreviewActive?.(false);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.xboxGamepad?.onPreviewInput?.((input) => {
      setPreview(input);
    });
    return () => unsubscribe?.();
  }, []);

  const patchLayout = (update: (layout: XboxGamepadLayoutModel) => void): void => {
    if (!state) return;
    const layout = cloneXboxGamepadLayout(settings.layout);
    update(layout);
    void setSettings({ layout });
  };

  const hintFor = (part: XboxGamepadEditablePart): XboxGamepadKeyHint => {
    if (isStickPart(part)) {
      const stick = settings.layout.sticks[part];
      return {
        legend: t(`settings.shortcuts.xboxGamepad.controls.${part}Stick`),
        name: stick
          ? t(`settings.shortcuts.xboxGamepad.stick.mode.options.${stick.mode}`)
          : undefined,
        description: t('settings.shortcuts.xboxGamepad.layout.clickToEdit'),
      };
    }
    const binding = settings.layout.buttons[part] ?? null;
    return {
      legend: t(`settings.shortcuts.xboxGamepad.controls.${part}`),
      name: bindingLabel(binding, t) ?? t('settings.shortcuts.xboxGamepad.actions.none'),
      description:
        binding?.type === 'command'
          ? workLouderCodexCommandDescription(t, binding.commandId)
          : binding?.type === 'voice'
            ? t('settings.shortcuts.xboxGamepad.actions.voiceDescription')
            : t('settings.shortcuts.xboxGamepad.layout.clickToEdit'),
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
            aria-label={t('settings.shortcuts.xboxGamepad.back')}
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.shortcuts.xboxGamepad.title')}
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

      {error && (
        <div className="flex items-center justify-between gap-3 text-12 text-[var(--error-fg)]">
          <span>{t(`settings.shortcuts.xboxGamepad.errors.${error}`)}</span>
          <button type="button" onClick={() => void reload()} className="underline">
            {t('settings.shortcuts.xboxGamepad.retry')}
          </button>
        </div>
      )}

      <SettingsCard className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('settings.shortcuts.xboxGamepad.connection.toggle.label')}
            </p>
            <div className="flex items-center gap-2">
              <Switch
                checked={enabled}
                disabled={loading || saving || !state}
                onCheckedChange={(next) => {
                  void setSettings({ deviceEnabled: next });
                }}
                aria-label={t('settings.shortcuts.xboxGamepad.connection.toggle.aria')}
              />
              <ConnectionBadge state={state} loading={loading} />
            </div>
          </div>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t(`settings.shortcuts.xboxGamepad.connection.descriptions.${key}`)}
          </p>
          {state?.devicePresent && <XboxDeviceChips device={state.device} />}
        </div>
      </SettingsCard>

      <SettingsCard className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.shortcuts.xboxGamepad.layout.title')}
          </h3>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t('settings.shortcuts.xboxGamepad.layout.description')}
          </p>
        </div>
        <div className="flex justify-center">
          <XboxGamepadLayout
            layout={settings.layout}
            disabled={!state || saving}
            hintFor={hintFor}
            onEdit={setEditing}
            preview={preview}
            labels={{
              leftStick: t('settings.shortcuts.xboxGamepad.controls.leftStick'),
              rightStick: t('settings.shortcuts.xboxGamepad.controls.rightStick'),
            }}
          />
        </div>
      </SettingsCard>

      <XboxGamepadPartEditor
        open={editing !== null && !isStickPart(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing && !isStickPart(editing)
            ? t(`settings.shortcuts.xboxGamepad.controls.${editing}`)
            : t('settings.shortcuts.xboxGamepad.layout.editor.title')
        }
        description={t('settings.shortcuts.xboxGamepad.layout.editor.description')}
        closeLabel={t('settings.shortcuts.xboxGamepad.layout.editor.done')}
      >
        {editing && !isStickPart(editing) && settings && (
          <SettingsRow
            label={t('settings.shortcuts.xboxGamepad.layout.editor.assigned')}
            description={t('settings.shortcuts.xboxGamepad.layout.editor.assignedDescription')}
            control={
              <BindingSelect
                binding={settings.layout.buttons[editing]}
                skills={enabledSkills}
                disabled={!state || saving}
                allowVoice
                onChange={(binding) =>
                  patchLayout((layout) => {
                    layout.buttons[editing] = binding;
                  })
                }
              />
            }
          />
        )}
      </XboxGamepadPartEditor>

      <XboxGamepadPartEditor
        open={editing !== null && isStickPart(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing && isStickPart(editing)
            ? t(`settings.shortcuts.xboxGamepad.controls.${editing}Stick`)
            : t('settings.shortcuts.xboxGamepad.layout.editor.title')
        }
        description={t('settings.shortcuts.xboxGamepad.stick.description')}
        closeLabel={t('settings.shortcuts.xboxGamepad.layout.editor.done')}
      >
        {editing && isStickPart(editing) && settings && (
          <div className="flex flex-col gap-3">
            <SettingsRow
              label={t('settings.shortcuts.xboxGamepad.stick.mode.label')}
              description={t('settings.shortcuts.xboxGamepad.stick.mode.description')}
              control={
                <SelectControl
                  value={settings.layout.sticks[editing].mode}
                  disabled={!state || saving}
                  ariaLabel={t('settings.shortcuts.xboxGamepad.stick.mode.label')}
                  onChange={(value) =>
                    patchLayout((layout) => {
                      layout.sticks[editing].mode = value as XboxGamepadStickMode;
                    })
                  }
                  options={[
                    {
                      value: 'conversation-scroll',
                      label: t('settings.shortcuts.xboxGamepad.stick.mode.options.conversation-scroll'),
                    },
                    {
                      value: 'custom',
                      label: t('settings.shortcuts.xboxGamepad.stick.mode.options.custom'),
                    },
                  ]}
                />
              }
            />
            {settings.layout.sticks[editing].mode === 'custom' &&
              XBOX_GAMEPAD_STICK_DIRECTIONS.map((direction) => (
                <div key={direction}>
                  <SettingsDivider />
                  <SettingsRow
                    label={t(`settings.shortcuts.xboxGamepad.directions.${direction}`)}
                    description={t('settings.shortcuts.xboxGamepad.stick.customDescription')}
                    control={
                      <BindingSelect
                        binding={settings.layout.sticks[editing].directions[direction]}
                        skills={enabledSkills}
                        disabled={!state || saving}
                        onChange={(binding) =>
                          patchLayout((layout) => {
                            layout.sticks[editing].directions[direction] = binding;
                          })
                        }
                      />
                    }
                  />
                </div>
              ))}
            <SettingsDivider />
            <SettingsRow
              label={t(`settings.shortcuts.xboxGamepad.controls.${stickClickButton(editing)}`)}
              description={t('settings.shortcuts.xboxGamepad.layout.editor.assignedDescription')}
              control={
                <BindingSelect
                  binding={settings.layout.buttons[stickClickButton(editing)]}
                  skills={enabledSkills}
                  disabled={!state || saving}
                  allowVoice
                  onChange={(binding) =>
                    patchLayout((layout) => {
                      layout.buttons[stickClickButton(editing)] = binding;
                    })
                  }
                />
              }
            />
          </div>
        )}
      </XboxGamepadPartEditor>

      <SettingsCard className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.shortcuts.xboxGamepad.layout.reset.title')}
          </p>
          <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">
            {t('settings.shortcuts.xboxGamepad.layout.reset.description')}
          </p>
        </div>
        <button
          type="button"
          disabled={!state || saving}
          onClick={() => void resetSettings()}
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-12 text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={13} />
          {t('settings.shortcuts.xboxGamepad.layout.reset.button')}
        </button>
      </SettingsCard>
    </div>
  );
}

function XboxGamepadPartEditor({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[min(700px,calc(100vh-48px))] w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
          <div className="px-6 pb-4 pt-6">
            <Dialog.Title className="text-18 font-medium leading-[1.3]">{title}</Dialog.Title>
            <Dialog.Description className="mt-1 text-13 leading-[1.4] text-[var(--text-secondary)]">
              {description}
            </Dialog.Description>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">{children}</div>
          <div className="flex justify-end border-t border-[var(--border-default)] px-6 py-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg bg-[var(--accent-cta-bg)] px-3 py-2 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            >
              {closeLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BindingSelect({
  binding,
  skills,
  disabled,
  allowVoice = false,
  onChange,
}: {
  binding: XboxGamepadBinding | null;
  skills: Array<{ id: string; name: string }>;
  disabled: boolean;
  allowVoice?: boolean;
  onChange(binding: XboxGamepadBinding | null): void;
}) {
  const { t } = useTranslation();
  const groups: SelectOptionGroup[] = [{ options: [{ value: 'none', label: t('settings.shortcuts.xboxGamepad.actions.none') }] }];
  if (allowVoice) {
    groups.push({
      options: [{ value: 'voice', label: t('settings.shortcuts.xboxGamepad.actions.voice') }],
    });
  }
  groups.push({
    label: t('settings.shortcuts.xboxGamepad.actions.commands'),
    options: INPUT_DEVICE_COMMAND_IDS.map((commandId) => ({
      value: `command:${commandId}`,
      label: workLouderCodexCommandName(t, commandId),
    })),
  });
  if (skills.length > 0) {
    groups.push({
      label: t('settings.shortcuts.xboxGamepad.actions.skills'),
      options: skills.map((skill) => ({
        value: `skill:${skill.id}`,
        label: skill.name,
      })),
    });
  }
  return (
    <SelectControl
      value={bindingValue(binding)}
      disabled={disabled}
      ariaLabel={t('settings.shortcuts.xboxGamepad.actions.choose')}
      onChange={(value) => onChange(parseBindingValue(value, skills))}
      className="min-w-[190px]"
      groups={groups}
    />
  );
}

interface SelectOption {
  value: string;
  label: string;
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
                    className={cn(
                      'flex w-full cursor-pointer select-none items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-12 outline-none',
                      'text-[var(--text-primary)]',
                      'data-[highlighted]:bg-[var(--surface-hover)]',
                      'data-[state=checked]:font-medium',
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

function resolveXboxGamepadSettings(
  settings: XboxGamepadSettingsModel | undefined,
): XboxGamepadSettingsModel {
  if (!settings) return createXboxGamepadDefaultSettings();
  if (settings.layout?.buttons && settings.layout.sticks) return settings;
  return { ...settings, layout: createXboxGamepadDefaultLayout() };
}

function xboxGamepadSettingsMatchRestoreDefaults(settings: XboxGamepadSettingsModel): boolean {
  return (
    JSON.stringify({ ...settings, deviceEnabled: false }) ===
    JSON.stringify({ ...createXboxGamepadDefaultSettings(), deviceEnabled: false })
  );
}

function bindingLabel(
  binding: XboxGamepadBinding | null,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (!binding) return null;
  if (binding.type === 'command') return workLouderCodexCommandName(t, binding.commandId);
  if (binding.type === 'skill') return binding.name;
  return t('settings.shortcuts.xboxGamepad.actions.voice');
}

function bindingValue(binding: XboxGamepadBinding | null): string {
  if (!binding) return 'none';
  if (binding.type === 'command') return `command:${binding.commandId}`;
  if (binding.type === 'skill') return `skill:${binding.skillId}`;
  return 'voice';
}

function parseBindingValue(
  value: string,
  skills: Array<{ id: string; name: string }>,
): XboxGamepadBinding | null {
  if (value === 'none') return null;
  if (value === 'voice') return { type: 'voice' };
  if (value.startsWith('command:')) {
    return { type: 'command', commandId: value.slice(8) as InputDeviceCommandId };
  }
  if (value.startsWith('skill:')) {
    const skillId = value.slice(6);
    const skill = skills.find((item) => item.id === skillId);
    return skill ? { type: 'skill', skillId, name: skill.name } : null;
  }
  return null;
}
