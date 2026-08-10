import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, Copy, Keyboard, Loader2, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import { SUPPORTED_LOCALES } from '@/i18n';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import { dictionaryTermKey } from '@cindy/voice-input-core';
import {
  MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS,
  MAX_VOICE_INPUT_DICTIONARY_CSV_BYTES,
  getVoiceInputSettings,
  mergeVoiceInputDictionaryCsvTerms,
  normalizeVoiceInputDictionaryEntryText,
  parseVoiceInputDictionaryCsv,
  suspendVoiceInputGlobalShortcut,
  syncVoiceInputGlobalShortcut,
  useVoiceInputSettings,
  type VoiceInputDictionaryEntry,
  type VoiceInputDictionaryEntrySource,
  type VoiceInputLanguage,
} from '@/hooks/useVoiceInputSettings';
import { getComposerSendShortcutPreference } from '@/hooks/useComposerSendShortcutPreference';
import { useVoiceInputModelSelection } from '@/hooks/useVoiceInputModelSelection';
import { useVoiceInputUsageStats } from '@/hooks/useVoiceInputUsageStats';
import { useVoiceInputHistory } from '@/hooks/useVoiceInputHistory';
import { getAppShortcutCombos, getAppShortcutOverrides } from '@/lib/appShortcutStore';
import { toast } from '@/lib/toast';
import {
  APP_SHORTCUT_DEFINITIONS,
  getAppShortcutDefinition,
  type AppShortcutId,
} from '../../../shared/appShortcuts';
import {
  findVoiceInputAppShortcutConflict,
  type AppShortcutComboEntry,
} from '@/voice-input/appShortcutConflict';
import { findComposerVoiceInputConflict } from '@/voice-input/composerVoiceInputConflict';
import { shouldShowInputMonitoringBadge } from '@/voice-input/inputMonitoringBadge';
import {
  createVoiceInputModifierShortcut,
  createVoiceInputShortcutFromEvent,
  createVoiceInputShortcutFromMacNativeKeys,
  formatVoiceInputShortcut,
  getVoiceInputBareModifierCodeFromEvent,
  isBarePrintableVoiceInputShortcut,
  isStandaloneVoiceInputShortcutAllowed,
  isSystemReservedVoiceInputShortcut,
  isVoiceInputShortcutRelease,
  voiceInputShortcutNeedsMacNativeListener,
  type VoiceInputShortcut,
} from '@/voice-input/shortcut';
import { requestRendererMicrophonePermission } from '@/voice-input/startGuards';
import {
  canReuseVoiceInputCustomAsrCredential,
  MAX_CUSTOM_ASR_API_KEY_CHARS,
  MAX_CUSTOM_ASR_MODEL_CHARS,
  MAX_CUSTOM_ASR_WEBSOCKET_URL_CHARS,
  validateVoiceInputCustomAsrWebsocketUrl,
} from '../../../shared/voiceInputCustomAsr';
import type { VoiceInputConnectionTestFailureReason } from '../../../shared/voiceInputConnectionTest';

const log = createLogger('VoiceInputSection');
const LANGUAGE_OPTIONS: ReadonlyArray<VoiceInputLanguage> = ['auto', ...SUPPORTED_LOCALES];
const AUTO_MICROPHONE_VALUE = '__auto__';
const DICTIONARY_FILTERS = ['all', 'automatic', 'manual'] as const;

type DictionaryFilter = (typeof DICTIONARY_FILTERS)[number];
type VoiceInputSystemPermissions = ReturnType<typeof window.electronAPI.voiceInput.getSystemPermissionsCached>;
type VoiceInputPermissionSnapshot = VoiceInputSystemPermissions['microphone'];
type VoiceInputPermissionKind = 'microphone' | 'inputMonitoring' | 'accessibility';
type VoiceInputConnectionTestViewState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'success' }
  | { status: 'error'; reason: VoiceInputConnectionTestFailureReason };

const VOICE_INPUT_CONNECTION_TEST_FAILURE_KEYS: Record<
  VoiceInputConnectionTestFailureReason,
  string
> = {
  'credentials-missing': 'settings.voiceInput.serviceSource.connectionTest.failure.credentialsMissing',
  'authentication-failed': 'settings.voiceInput.serviceSource.connectionTest.failure.authenticationFailed',
  'route-unavailable': 'settings.voiceInput.serviceSource.connectionTest.failure.routeUnavailable',
  timeout: 'settings.voiceInput.serviceSource.connectionTest.failure.timeout',
  network: 'settings.voiceInput.serviceSource.connectionTest.failure.network',
  'service-error': 'settings.voiceInput.serviceSource.connectionTest.failure.serviceError',
  'unsupported-provider': 'settings.voiceInput.serviceSource.connectionTest.failure.unsupportedProvider',
};

interface VoiceInputSelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface VoiceInputSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<VoiceInputSelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  icon?: ReactNode;
}

interface VoiceInputCardProps {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

interface VoiceInputInlineSettingRowProps {
  label: ReactNode;
  labelAction?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

interface VoiceInputCollapsibleTextareaProps {
  id: string;
  label: ReactNode;
  hint: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  rows: number;
  ariaLabel: string;
  placeholder: string;
  editLabel: string;
  collapseLabel: string;
  className?: string;
}

function deviceLabel(device: MediaDeviceInfo, unnamedLabel: string): string {
  return device.label.trim() || unnamedLabel;
}

function formatAudioDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.round(totalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '$0.00';
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

function dictionaryEntryMatches(
  entry: VoiceInputDictionaryEntry,
  filter: DictionaryFilter,
  query: string,
): boolean {
  if (filter !== 'all' && entry.source !== filter) return false;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return entry.text.toLocaleLowerCase().includes(normalizedQuery);
}

function dictionarySourceIcon(source: VoiceInputDictionaryEntrySource): ReactNode {
  if (source === 'automatic') return <Sparkles size={14} />;
  return <Keyboard size={14} />;
}

function formatHistoryTime(createdAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(createdAt));
  } catch {
    return new Date(createdAt).toLocaleString();
  }
}

function VoiceInputSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  icon,
}: VoiceInputSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'group flex min-h-[44px] w-full items-center justify-between gap-2.5 rounded-[14px] px-3.5',
            'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
            'text-left text-[var(--settings-input-text)] shadow-[var(--shadow-menu)]',
            'outline-none transition-colors',
            open
              ? 'border-[var(--settings-section-title)]'
              : 'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {icon ? <span className="shrink-0 text-[var(--settings-section-sublabel)]">{icon}</span> : null}
            <span className="flex min-w-0 flex-col gap-0.5 py-1.5">
              <span className="truncate text-14 font-medium leading-[1.25]">
                {selectedOption?.label}
              </span>
              {selectedOption?.description ? (
                <span className="truncate text-12 leading-[1.25] text-[var(--settings-section-sublabel)] opacity-75">
                  {selectedOption.description}
                </span>
              ) : null}
            </span>
          </span>
          <ChevronDown
            size={18}
            className={cn(
              'shrink-0 text-[var(--settings-section-title)] transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          'w-[var(--radix-popover-trigger-width)] min-w-[260px] rounded-[16px] p-2',
          'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
          'shadow-[var(--shadow-menu)]',
          'max-h-[360px] overflow-y-auto',
        )}
      >
        <div className="flex flex-col gap-1" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-[12px] px-3.5 py-2.5 text-left',
                  'outline-none transition-colors',
                  'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:bg-[var(--settings-menu-bg-hover)]',
                  selected && 'bg-[var(--settings-menu-bg-selected)]',
                  option.disabled && 'cursor-not-allowed opacity-55',
                )}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-15 font-medium leading-[1.25] text-[var(--settings-section-title)]">
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="truncate text-13 leading-[1.25] text-[var(--settings-section-sublabel)]">
                      {option.description}
                    </span>
                  ) : null}
                </span>

                {selected ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)]">
                    <Check size={13} strokeWidth={3} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function VoiceInputCard({ title, action, children }: VoiceInputCardProps) {
  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-xl p-4',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          className="text-13 font-medium text-[var(--settings-section-sublabel)]"
          style={{ letterSpacing: '0.12px' }}
        >
          {title}
        </h3>
        {action}
      </div>

      {children}
    </section>
  );
}

function VoiceInputInlineSettingRow({
  label,
  labelAction,
  hint,
  children,
  className,
}: VoiceInputInlineSettingRowProps) {
  return (
    <div
      className={cn(
        'grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <p
            className="min-w-0 text-13 font-medium text-[var(--settings-section-title)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {label}
          </p>
          {labelAction ? <div className="shrink-0">{labelAction}</div> : null}
        </div>
        {hint ? (
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {hint}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 sm:w-full sm:justify-self-end">{children}</div>
    </div>
  );
}

/**
 * "服务来源" card: managed Cindy voice service (default) vs the user's own
 * credentials (BYOK). BYOK reveals ASR / refiner provider pickers and a
 * credential-readiness notice; the reset action clears the user override so
 * the selection re-follows the product default (never a snapshot).
 */
function VoiceInputServiceSourceCard() {
  const { t } = useTranslation();
  const { mode: appMode } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    ready,
    selection,
    asrProfiles,
    refinerProfiles,
    readiness,
    customAsrApiKeyConfigured,
    saving,
    setServiceMode,
    setAsrProvider,
    setRefinerProvider,
    setRefinerFallbackProvider,
    saveCustomAsr,
    clearCustomAsrApiKey,
    resetToDefault,
  } = useVoiceInputModelSelection();
  const [customAsrProtocol, setCustomAsrProtocol] = useState<'openai-realtime' | 'qwen-realtime'>('openai-realtime');
  const [customAsrWebsocketUrl, setCustomAsrWebsocketUrl] = useState('');
  const [customAsrModel, setCustomAsrModel] = useState('');
  const [customAsrApiKey, setCustomAsrApiKey] = useState('');
  const [connectionTest, setConnectionTest] = useState<VoiceInputConnectionTestViewState>({ status: 'idle' });
  const connectionTestRequestRef = useRef(0);
  const customAsrFormDirtyRef = useRef(false);

  const localMode = appMode === 'local';
  const serviceMode: VoiceInputServiceModeData = localMode
    ? 'byok'
    : (selection?.serviceMode ?? 'cindy');
  const byok = serviceMode === 'byok';
  const customAsrSelected = selection?.asrProvider === 'custom-realtime-asr';
  const customAsrHasUnsavedChanges = customAsrSelected && (
    !selection?.customAsr
    || customAsrProtocol !== selection.customAsr.protocol
    || customAsrWebsocketUrl.trim() !== selection.customAsr.websocketUrl
    || customAsrModel.trim() !== selection.customAsr.model
    || Boolean(customAsrApiKey.trim())
  );

  useEffect(() => {
    if (customAsrSelected && customAsrFormDirtyRef.current) return;
    customAsrFormDirtyRef.current = false;
    if (!selection?.customAsr) {
      setCustomAsrProtocol('openai-realtime');
      setCustomAsrWebsocketUrl('');
      setCustomAsrModel('');
      setCustomAsrApiKey('');
      return;
    }
    setCustomAsrProtocol(selection.customAsr.protocol);
    setCustomAsrWebsocketUrl(selection.customAsr.websocketUrl);
    setCustomAsrModel(selection.customAsr.model);
    setCustomAsrApiKey('');
  }, [customAsrSelected, selection?.customAsr]);

  useEffect(() => {
    connectionTestRequestRef.current += 1;
    setConnectionTest({ status: 'idle' });
  }, [
    serviceMode,
    selection?.asrProvider,
    selection?.customAsr?.model,
    selection?.customAsr?.protocol,
    selection?.customAsr?.websocketUrl,
    customAsrApiKeyConfigured,
    customAsrProtocol,
    customAsrWebsocketUrl,
    customAsrModel,
    customAsrApiKey,
  ]);

  const openProvidersTab = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'providers');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const modeOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<VoiceInputServiceModeData>>>(() => {
    const byokOption: VoiceInputSelectOption<VoiceInputServiceModeData> = {
      value: 'byok',
      label: t('settings.voiceInput.serviceSource.options.byok'),
      description: t('settings.voiceInput.serviceSource.optionDescriptions.byok'),
    };
    if (localMode) return [byokOption];
    return [
      {
        value: 'cindy',
        label: t('settings.voiceInput.serviceSource.options.cindy'),
        description: t('settings.voiceInput.serviceSource.optionDescriptions.cindy'),
      },
      byokOption,
    ];
  }, [localMode, t]);

  const credentialSourceLabel = useCallback((profile: { id: string; auth: 'api-key' | 'codex' }): string => {
    if (profile.auth === 'codex') return t('settings.voiceInput.serviceSource.credential.codexLogin');
    if (profile.id.startsWith('elevenlabs')) return t('settings.voiceInput.serviceSource.credential.elevenlabsKey');
    return t('settings.voiceInput.serviceSource.credential.gatewayKey');
  }, [t]);

  const asrOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<string>>>(() => (
    asrProfiles
      // The batch profile only serves the mobile/remote file-relay path; it is
      // not a valid inline dictation choice.
      .filter((profile) => profile.mode !== 'batch-http')
      .map((profile) => ({
        value: profile.id,
        label: profile.id === 'custom-realtime-asr'
          ? t('settings.voiceInput.serviceSource.customAsr.optionLabel')
          : profile.model,
        description: profile.id === 'custom-realtime-asr'
          ? t('settings.voiceInput.serviceSource.customAsr.optionDescription')
          : profile.id === 'openai-realtime-whisper'
            ? t('settings.voiceInput.serviceSource.credential.codexRealtimeUnsupported')
            : credentialSourceLabel(profile),
        disabled: profile.id === 'openai-realtime-whisper',
      }))
  ), [asrProfiles, credentialSourceLabel, t]);

  const refinerOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<string>>>(() => (
    refinerProfiles.map((profile) => ({
      value: profile.id,
      label: profile.model,
      description: credentialSourceLabel(profile),
    }))
  ), [refinerProfiles, credentialSourceLabel]);

  // Explicit BYOK fallback (opt-in): "none" keeps the primary running alone,
  // mirroring the single-credential reality of most BYOK setups.
  const refinerFallbackValue = selection?.refinerProviderChain?.[1] ?? '';
  const refinerFallbackOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<string>>>(() => ([
    {
      value: '',
      label: t('settings.voiceInput.serviceSource.refinerFallback.none'),
      description: t('settings.voiceInput.serviceSource.refinerFallback.noneDescription'),
    },
    ...refinerProfiles
      .filter((profile) => profile.id !== selection?.refinerProvider)
      .map((profile) => ({
        value: profile.id,
        label: profile.model,
        description: credentialSourceLabel(profile),
      })),
  ]), [refinerProfiles, selection?.refinerProvider, credentialSourceLabel, t]);

  // BYOK credential problems map to i18n by credential source instead of the
  // raw main-process message (which is an untranslated profile constant).
  const byokCredentialErrorText = useMemo(() => {
    if (!byok || !readiness || readiness.ok) return null;
    if (readiness.failureReason === 'custom-asr-config-missing') {
      return t('settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing');
    }
    if (readiness.failureReason === 'custom-asr-key-missing') {
      return t('settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing');
    }
    if (readiness.failureReason === 'codex-realtime-unsupported') {
      return t('settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported');
    }
    if (readiness.auth === 'codex') return t('settings.voiceInput.serviceSource.credentialError.codexMissing');
    if (readiness.provider.startsWith('elevenlabs')) {
      return t('settings.voiceInput.serviceSource.credentialError.elevenlabsMissing');
    }
    return t('settings.voiceInput.serviceSource.credentialError.gatewayMissing');
  }, [byok, readiness, t]);

  const customAsrUrlValidationError = validateVoiceInputCustomAsrWebsocketUrl(customAsrWebsocketUrl);
  const customAsrUrlInvalid = Boolean(customAsrWebsocketUrl.trim() && customAsrUrlValidationError);
  const customAsrEndpointRequiresNewKey = customAsrApiKeyConfigured
    && customAsrUrlValidationError === null
    && !canReuseVoiceInputCustomAsrCredential(
      selection?.customAsr?.websocketUrl,
      customAsrWebsocketUrl,
    );
  const customAsrCanSave = customAsrUrlValidationError === null
    && Boolean(customAsrModel.trim())
    && (!customAsrEndpointRequiresNewKey || Boolean(customAsrApiKey.trim()));
  const credentialRecoveryInVoiceSettings = customAsrSelected
    || readiness?.failureReason === 'codex-realtime-unsupported';

  const handleSaveCustomAsr = useCallback(async () => {
    const saved = await saveCustomAsr({
      protocol: customAsrProtocol,
      websocketUrl: customAsrWebsocketUrl,
      model: customAsrModel,
    }, customAsrApiKey);
    if (saved) {
      customAsrFormDirtyRef.current = false;
      setCustomAsrApiKey('');
    }
  }, [
    customAsrApiKey,
    customAsrModel,
    customAsrProtocol,
    customAsrWebsocketUrl,
    saveCustomAsr,
  ]);

  const handleTestConnection = useCallback(async () => {
    const requestId = connectionTestRequestRef.current + 1;
    connectionTestRequestRef.current = requestId;
    setConnectionTest({ status: 'testing' });
    try {
      const result = await window.electronAPI.voiceInput.testConnection();
      if (connectionTestRequestRef.current !== requestId) return;
      setConnectionTest(result.ok
        ? { status: 'success' }
        : { status: 'error', reason: result.reason });
    } catch {
      if (connectionTestRequestRef.current !== requestId) return;
      setConnectionTest({ status: 'error', reason: 'service-error' });
    }
  }, []);

  const connectionTestBusy = connectionTest.status === 'testing';
  const connectionTestDisabled = saving || connectionTestBusy || customAsrHasUnsavedChanges;

  const customized = !localMode && Boolean(selection?.serviceModeConfigured);

  return (
    <VoiceInputCard
      title={t('settings.voiceInput.sections.serviceSource')}
      action={customized ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => void resetToDefault()}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-12',
            'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
            'text-[var(--settings-section-sublabel)] outline-none transition-colors',
            'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
            saving && 'cursor-not-allowed opacity-55',
          )}
        >
          <RotateCcw size={12} />
          {t('settings.voiceInput.serviceSource.reset')}
        </button>
      ) : undefined}
    >
      <VoiceInputInlineSettingRow
        label={t('settings.voiceInput.serviceSource.label')}
        hint={t(localMode
          ? 'settings.voiceInput.serviceSource.localHint'
          : 'settings.voiceInput.serviceSource.hint')}
      >
        <VoiceInputSelect
          value={serviceMode}
          options={modeOptions}
          onChange={(value) => void setServiceMode(value)}
          ariaLabel={t('settings.voiceInput.serviceSource.ariaLabel')}
        />
      </VoiceInputInlineSettingRow>

      {ready && byok ? (
        <>
          <VoiceInputInlineSettingRow
            label={t('settings.voiceInput.serviceSource.asr.label')}
            labelAction={(
              <button
                type="button"
                disabled={connectionTestDisabled}
                onClick={() => void handleTestConnection()}
                title={customAsrHasUnsavedChanges
                  ? t('settings.voiceInput.serviceSource.connectionTest.saveBeforeTest')
                  : undefined}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-12 outline-none transition-colors',
                  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                  'text-[var(--settings-section-sublabel)]',
                  'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
                  connectionTestDisabled && 'cursor-not-allowed opacity-55',
                )}
              >
                {connectionTestBusy ? (
                  <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden>
                    <Loader2 size={12} />
                  </span>
                ) : null}
                {t(connectionTestBusy
                  ? 'settings.voiceInput.serviceSource.connectionTest.testing'
                  : 'settings.voiceInput.serviceSource.connectionTest.action')}
              </button>
            )}
            hint={t('settings.voiceInput.serviceSource.asr.hint')}
          >
            <VoiceInputSelect
              value={selection?.asrProvider ?? ''}
              options={asrOptions}
              onChange={(value) => void setAsrProvider(value)}
              ariaLabel={t('settings.voiceInput.serviceSource.asr.ariaLabel')}
            />
          </VoiceInputInlineSettingRow>

          {connectionTest.status !== 'idle' ? (
            <div
              role={connectionTest.status === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={cn(
                'flex items-center gap-2 rounded-[10px] border px-3 py-2 text-12 leading-[1.4]',
                connectionTest.status === 'error'
                  ? 'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg)]'
                  : 'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-section-sublabel)]',
              )}
            >
              {connectionTest.status === 'success' ? <Check size={13} aria-hidden /> : null}
              {connectionTest.status === 'testing' ? (
                <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden>
                  <Loader2 size={13} />
                </span>
              ) : null}
              <span>
                {connectionTest.status === 'testing'
                  ? t('settings.voiceInput.serviceSource.connectionTest.testingStatus')
                  : connectionTest.status === 'success'
                    ? t('settings.voiceInput.serviceSource.connectionTest.success')
                    : t(VOICE_INPUT_CONNECTION_TEST_FAILURE_KEYS[connectionTest.reason])}
              </span>
            </div>
          ) : null}

          {customAsrSelected ? (
            <div className="flex flex-col gap-3 rounded-[12px] border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-3.5">
              <p className="text-12 leading-[1.45] text-[var(--settings-section-sublabel)]">
                {t('settings.voiceInput.serviceSource.customAsr.notice')}
              </p>

              <VoiceInputInlineSettingRow
                label={t('settings.voiceInput.serviceSource.customAsr.protocol.label')}
                hint={t('settings.voiceInput.serviceSource.customAsr.protocol.hint')}
              >
                <VoiceInputSelect
                  value={customAsrProtocol}
                  options={[
                    {
                      value: 'openai-realtime',
                      label: t('settings.voiceInput.serviceSource.customAsr.protocol.openai'),
                    },
                    {
                      value: 'qwen-realtime',
                      label: t('settings.voiceInput.serviceSource.customAsr.protocol.qwen'),
                    },
                  ]}
                  onChange={(value) => {
                    customAsrFormDirtyRef.current = true;
                    setCustomAsrProtocol(value);
                  }}
                  ariaLabel={t('settings.voiceInput.serviceSource.customAsr.protocol.ariaLabel')}
                />
              </VoiceInputInlineSettingRow>

              <VoiceInputInlineSettingRow
                label={t('settings.voiceInput.serviceSource.customAsr.websocketUrl.label')}
                hint={t('settings.voiceInput.serviceSource.customAsr.websocketUrl.hint')}
              >
                <input
                  type="url"
                  value={customAsrWebsocketUrl}
                  onChange={(event) => {
                    customAsrFormDirtyRef.current = true;
                    setCustomAsrWebsocketUrl(event.target.value);
                  }}
                  placeholder={t('settings.voiceInput.serviceSource.customAsr.websocketUrl.placeholder')}
                  maxLength={MAX_CUSTOM_ASR_WEBSOCKET_URL_CHARS}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(
                    'h-9 w-full rounded-full border px-3 text-13 outline-none transition-colors',
                    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                    'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-55',
                    'focus:border-[var(--settings-input-border-focus)]',
                  )}
                />
              </VoiceInputInlineSettingRow>
              {customAsrUrlInvalid ? (
                <p
                  role="alert"
                  className="rounded-[10px] border border-[var(--error-border)] bg-[var(--error-bg)] px-3 py-2 text-12 leading-[1.4] text-[var(--error-fg)]"
                >
                  {t('settings.voiceInput.serviceSource.customAsr.websocketUrl.invalid')}
                </p>
              ) : null}

              <VoiceInputInlineSettingRow
                label={t('settings.voiceInput.serviceSource.customAsr.model.label')}
                hint={t('settings.voiceInput.serviceSource.customAsr.model.hint')}
              >
                <input
                  type="text"
                  value={customAsrModel}
                  onChange={(event) => {
                    customAsrFormDirtyRef.current = true;
                    setCustomAsrModel(event.target.value);
                  }}
                  placeholder={t('settings.voiceInput.serviceSource.customAsr.model.placeholder')}
                  maxLength={MAX_CUSTOM_ASR_MODEL_CHARS}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(
                    'h-9 w-full rounded-full border px-3 text-13 outline-none transition-colors',
                    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                    'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-55',
                    'focus:border-[var(--settings-input-border-focus)]',
                  )}
                />
              </VoiceInputInlineSettingRow>

              <VoiceInputInlineSettingRow
                label={t('settings.voiceInput.serviceSource.customAsr.apiKey.label')}
                hint={t(customAsrEndpointRequiresNewKey
                  ? 'settings.voiceInput.serviceSource.customAsr.apiKey.endpointChangedHint'
                  : customAsrApiKeyConfigured
                    ? 'settings.voiceInput.serviceSource.customAsr.apiKey.savedHint'
                    : 'settings.voiceInput.serviceSource.customAsr.apiKey.hint')}
              >
                <input
                  type="password"
                  value={customAsrApiKey}
                  onChange={(event) => {
                    customAsrFormDirtyRef.current = true;
                    setCustomAsrApiKey(event.target.value);
                  }}
                  placeholder={t(customAsrEndpointRequiresNewKey
                    ? 'settings.voiceInput.serviceSource.customAsr.apiKey.placeholder'
                    : customAsrApiKeyConfigured
                      ? 'settings.voiceInput.serviceSource.customAsr.apiKey.savedPlaceholder'
                      : 'settings.voiceInput.serviceSource.customAsr.apiKey.placeholder')}
                  maxLength={MAX_CUSTOM_ASR_API_KEY_CHARS}
                  spellCheck={false}
                  autoComplete="new-password"
                  className={cn(
                    'h-9 w-full rounded-full border px-3 text-13 outline-none transition-colors',
                    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                    'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-55',
                    'focus:border-[var(--settings-input-border-focus)]',
                  )}
                />
              </VoiceInputInlineSettingRow>

              <div className="flex flex-wrap justify-end gap-2">
                {customAsrApiKeyConfigured ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void clearCustomAsrApiKey()}
                    className={cn(
                      'h-8 rounded-full border px-3 text-12 outline-none transition-colors',
                      'border-[var(--settings-input-border)] text-[var(--settings-section-sublabel)]',
                      'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
                      saving && 'cursor-not-allowed opacity-55',
                    )}
                  >
                    {t('settings.voiceInput.serviceSource.customAsr.apiKey.clear')}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={saving || !customAsrCanSave}
                  onClick={() => void handleSaveCustomAsr()}
                  className={cn(
                    'h-8 rounded-full border px-3 text-12 font-medium outline-none transition-colors',
                    'border-[var(--settings-input-border-focus)] bg-[var(--settings-btn-primary-bg)] text-[var(--settings-btn-primary-text)]',
                    'hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--settings-input-border-focus)]',
                    (saving || !customAsrCanSave) && 'cursor-not-allowed opacity-55',
                  )}
                >
                  {t('settings.voiceInput.serviceSource.customAsr.save')}
                </button>
              </div>
            </div>
          ) : null}

          <VoiceInputInlineSettingRow
            label={t('settings.voiceInput.serviceSource.refiner.label')}
            hint={t('settings.voiceInput.serviceSource.refiner.hint')}
          >
            <VoiceInputSelect
              value={selection?.refinerProvider ?? ''}
              options={refinerOptions}
              onChange={(value) => void setRefinerProvider(value)}
              ariaLabel={t('settings.voiceInput.serviceSource.refiner.ariaLabel')}
            />
          </VoiceInputInlineSettingRow>

          <VoiceInputInlineSettingRow
            label={t('settings.voiceInput.serviceSource.refinerFallback.label')}
            hint={t('settings.voiceInput.serviceSource.refinerFallback.hint')}
          >
            <VoiceInputSelect
              value={refinerFallbackValue}
              options={refinerFallbackOptions}
              onChange={(value) => void setRefinerFallbackProvider(value)}
              ariaLabel={t('settings.voiceInput.serviceSource.refinerFallback.ariaLabel')}
            />
          </VoiceInputInlineSettingRow>

          {byokCredentialErrorText ? (
            <div
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 rounded-[12px] px-3.5 py-2.5',
                'border border-[var(--error-border)] bg-[var(--error-bg)]',
              )}
            >
              <p className="min-w-0 text-12 leading-[1.4] text-[var(--error-fg)]">
                {byokCredentialErrorText}
              </p>
              {!credentialRecoveryInVoiceSettings ? <button
                type="button"
                onClick={openProvidersTab}
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 text-12 font-medium',
                  'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                  'text-[var(--settings-section-title)] outline-none transition-colors',
                  'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
                )}
              >
                {t('settings.voiceInput.serviceSource.manageProviders')}
              </button> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </VoiceInputCard>
  );
}

function VoiceInputPermissionBadge({
  label,
  granted,
  onGrant,
  tooltip,
}: {
  label: string;
  granted: boolean;
  onGrant: () => void;
  tooltip?: ReactNode;
}) {
  const { t } = useTranslation();
  const labelText = granted
    ? t('settings.voiceInput.permissions.granted')
    : t('settings.voiceInput.permissions.grant');
  const className = cn(
    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full text-11 font-medium leading-none transition-colors',
    granted
      ? 'border border-transparent bg-transparent px-0 text-[var(--settings-section-sublabel)]'
      : 'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)] px-2 text-[var(--settings-btn-secondary-text)]',
    granted ? 'hover:text-[var(--settings-section-title)]' : null,
    !granted ? 'hover:bg-[var(--settings-btn-secondary-hover-bg)]' : null,
  );
  const children = granted ? (
    <>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]">
        <Check size={10} strokeWidth={2.4} className="text-emerald-600 dark:text-emerald-300" />
      </span>
      {labelText}
    </>
  ) : (
    labelText
  );
  const content = (
    <button
      type="button"
      onClick={onGrant}
      aria-label={`${label}: ${labelText}`}
      className={className}
    >
      {children}
    </button>
  );

  if (!tooltip) return content;

  return (
    <Tip
      text={tooltip}
      side="top"
      contentClassName="max-w-[320px] break-normal text-left"
    >
      <span className="inline-flex">{content}</span>
    </Tip>
  );
}

function normalizeVoiceInputSystemPermissions(
  raw: Partial<VoiceInputSystemPermissions> | null | undefined,
): VoiceInputSystemPermissions {
  const notRequired: VoiceInputPermissionSnapshot = { ok: true, status: 'not-required' };
  const unknown = (error: string): VoiceInputPermissionSnapshot => ({
    ok: false,
    status: 'unknown',
    error,
  });

  return {
    microphone: raw?.microphone ?? unknown('Microphone permission status is unavailable.'),
    inputMonitoring: raw?.inputMonitoring ?? (
      window.electronAPI.platform === 'darwin'
        ? unknown('Input Monitoring permission status is unavailable.')
        : notRequired
    ),
    accessibility: raw?.accessibility ?? (
      window.electronAPI.platform === 'darwin'
        ? unknown('Accessibility permission status is unavailable.')
        : notRequired
    ),
  };
}

function VoiceInputCollapsibleTextarea({
  id,
  label,
  hint,
  expanded,
  onExpandedChange,
  value,
  onChange,
  maxLength,
  rows,
  ariaLabel,
  placeholder,
  editLabel,
  collapseLabel,
  className,
}: VoiceInputCollapsibleTextareaProps) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-title)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {label}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {hint}
          </p>
        </div>

        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => onExpandedChange(!expanded)}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors',
            'border border-[var(--settings-btn-secondary-border)]',
            'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
            'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
          )}
        >
          <span>{expanded ? collapseLabel : editLabel}</span>
          <ChevronDown
            size={14}
            className={cn('transition-transform', expanded && 'rotate-180')}
          />
        </button>
      </div>

      {expanded ? (
        <textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          maxLength={maxLength}
          rows={rows}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className={cn(
            'mt-4 min-h-[128px] w-full resize-y rounded-[14px] px-4 py-3',
            'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
            'text-13 leading-[1.45] text-[var(--settings-input-text)]',
            'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-45',
            'outline-none transition-colors',
            'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
          )}
        />
      ) : null}
    </div>
  );
}

export function VoiceInputSection() {
  const { t, i18n } = useTranslation();
  const supportsGlobalShortcutSetting = window.electronAPI.platform !== 'linux';
  const supportsSystemAudioMuteSetting =
    window.electronAPI.platform === 'darwin' || window.electronAPI.platform === 'win32';
  const {
    settings,
    setLanguage,
    setMicrophoneDeviceId,
    setMuteSystemAudio,
    setPlayInteractionSound,
    setFastActivationEnabled,
    setRefinementEnabled,
    setRefinementInstructions,
    setAutoDictionaryEnabled,
    setDictionarySyncEnabled,
    addDictionaryEntry: addDictionarySettingEntry,
    importDictionaryEntries: importDictionarySettingEntries,
    renameDictionaryEntry: renameDictionarySettingEntry,
    deleteDictionaryEntry: deleteDictionarySettingEntry,
    setShortcut,
  } = useVoiceInputSettings();
  const { stats, cost, reset: resetUsageStats } = useVoiceInputUsageStats();
  const { entries: historyEntries, deleteEntry: deleteHistoryEntry } = useVoiceInputHistory();
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [recordingShortcutPreview, setRecordingShortcutPreview] = useState<VoiceInputShortcut | null>(null);
  // 录制期缺监听权限：Fn 类快捷键录不了（Fn 不走 DOM keydown，只能靠原生 listener 上报），
  // 但裸修饰键和普通组合键仍然正常。所以这不是错误，只在提示区说明，不弹 toast。
  const [fnRecordingBlocked, setFnRecordingBlocked] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [refinementRulesExpanded, setRefinementRulesExpanded] = useState(false);
  const [customDictionaryExpanded, setCustomDictionaryExpanded] = useState(false);
  const [dictionaryFilter, setDictionaryFilter] = useState<DictionaryFilter>('all');
  const [dictionarySearchExpanded, setDictionarySearchExpanded] = useState(false);
  const [dictionarySearch, setDictionarySearch] = useState('');
  const [addingDictionaryEntry, setAddingDictionaryEntry] = useState(false);
  const [newDictionaryEntryText, setNewDictionaryEntryText] = useState('');
  const [editingDictionaryEntryId, setEditingDictionaryEntryId] = useState<string | null>(null);
  const [editingDictionaryEntryText, setEditingDictionaryEntryText] = useState('');
  const [permissions, setPermissions] = useState<VoiceInputSystemPermissions>(() =>
    normalizeVoiceInputSystemPermissions(window.electronAPI.voiceInput.getSystemPermissionsCached())
  );
  const lastPermissionRefreshAtRef = useRef(0);
  const permissionRefreshTimerRef = useRef<number | null>(null);
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const dictionaryCsvInputRef = useRef<HTMLInputElement | null>(null);
  const dictionarySearchInputRef = useRef<HTMLInputElement | null>(null);
  const newDictionaryEntryInputRef = useRef<HTMLInputElement | null>(null);
  const editingDictionaryEntryInputRef = useRef<HTMLInputElement | null>(null);
  const pendingModifierShortcutCodeRef = useRef<string | null>(null);
  const pendingKeyboardShortcutRef = useRef<VoiceInputShortcut | null>(null);
  const shortcutSuspendPromiseRef = useRef<Promise<void> | null>(null);
  // 快捷键提交的代次，见 commitRecordedShortcut。
  const shortcutSubmissionRef = useRef(0);
  // 正在飞的那次提交，见 commitRecordedShortcut 与录制 effect 的 cleanup。
  const shortcutCommitPromiseRef = useRef<Promise<void> | null>(null);
  // 录制轮次，见录制 effect 的 cleanup：迟到的恢复不能踩到新一轮的挂起。
  const recordingSessionRef = useRef(0);
  const nativeFnShortcutActiveRef = useRef(false);
  const nativeFnComboSeenRef = useRef(false);
  const externalDictionaryLearningSupported = window.electronAPI.platform === 'darwin';

  const refreshPermissions = useCallback(async () => {
    lastPermissionRefreshAtRef.current = Date.now();
    try {
      setPermissions(normalizeVoiceInputSystemPermissions(await window.electronAPI.voiceInput.getSystemPermissions()));
    } catch {
      setPermissions(normalizeVoiceInputSystemPermissions(window.electronAPI.voiceInput.getSystemPermissionsCached()));
    }
  }, []);

  const schedulePermissionRefresh = useCallback((options?: { immediate?: boolean }) => {
    if (options?.immediate) {
      if (permissionRefreshTimerRef.current !== null) {
        window.clearTimeout(permissionRefreshTimerRef.current);
        permissionRefreshTimerRef.current = null;
      }
      void refreshPermissions();
      return;
    }
    const elapsed = Date.now() - lastPermissionRefreshAtRef.current;
    const delayMs = Math.max(0, 5_000 - elapsed);
    if (permissionRefreshTimerRef.current !== null) {
      window.clearTimeout(permissionRefreshTimerRef.current);
      permissionRefreshTimerRef.current = null;
    }
    if (delayMs === 0) {
      void refreshPermissions();
      return;
    }
    permissionRefreshTimerRef.current = window.setTimeout(() => {
      permissionRefreshTimerRef.current = null;
      void refreshPermissions();
    }, delayMs);
  }, [refreshPermissions]);

  const requestPermission = useCallback(async (kind: VoiceInputPermissionKind) => {
    try {
      if (kind === 'microphone') {
        if (permissions.microphone.ok) {
          await window.electronAPI.voiceInput.openMicrophoneSettings();
        } else {
          const result = await requestRendererMicrophonePermission();
          if (!result.ok) {
            await window.electronAPI.voiceInput.openMicrophoneSettings();
          }
        }
      } else if (kind === 'inputMonitoring') {
        await window.electronAPI.voiceInput.openInputMonitoringSettings();
      } else {
        await window.electronAPI.voiceInput.openAccessibilitySettings();
      }
    } catch {
      toast.error(t('settings.voiceInput.permissions.openFailed'));
    } finally {
      window.setTimeout(() => {
        void refreshPermissions();
      }, 800);
    }
  }, [permissions.microphone.ok, refreshPermissions, t]);

  useEffect(() => {
    void refreshPermissions();
    const handleFocus = () => {
      schedulePermissionRefresh({ immediate: true });
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      if (permissionRefreshTimerRef.current !== null) {
        window.clearTimeout(permissionRefreshTimerRef.current);
        permissionRefreshTimerRef.current = null;
      }
    };
  }, [refreshPermissions, schedulePermissionRefresh]);

  useEffect(() => {
    if (!dictionarySearchExpanded) return;
    dictionarySearchInputRef.current?.focus();
  }, [dictionarySearchExpanded]);

  useEffect(() => {
    if (!addingDictionaryEntry) return;
    newDictionaryEntryInputRef.current?.focus();
  }, [addingDictionaryEntry]);

  useEffect(() => {
    if (!editingDictionaryEntryId) return;
    editingDictionaryEntryInputRef.current?.focus();
  }, [editingDictionaryEntryId]);

  const handleCopyHistoryEntry = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t('settings.voiceInput.history.toast.copied'));
      } catch {
        toast.error(t('settings.voiceInput.history.toast.copyFailed'));
      }
    },
    [t],
  );

  const shortcutLabel = useMemo(() => {
    if (recordingShortcut) {
      return recordingShortcutPreview
        ? formatVoiceInputShortcut(recordingShortcutPreview)
        : t('settings.voiceInput.shortcut.recording');
    }
    return formatVoiceInputShortcut(settings.shortcut) || t('settings.voiceInput.shortcut.none');
  }, [recordingShortcut, recordingShortcutPreview, settings.shortcut, t]);
  const shortcutNeedsKeyboardListenerPermission = useMemo(
    () => voiceInputShortcutNeedsMacNativeListener(settings.shortcut, window.electronAPI.platform),
    [settings.shortcut],
  );
  /**
   * 待授权 = 当前快捷键需要监听权限，且权限**明确**被拒。
   *
   * 只认 denied、不用 !ok：status 为 unknown 时（helper 跑不起来、权限状态压根问不出来）
   * ok 同样是 false，但那是故障而非等授权，挂「授权后生效」会把用户引向错误的下一步。
   * 与 main 侧 classifyMacNativeListenerFailure 的 denied/unknown 分界保持一致。
   */
  const shortcutAwaitingInputMonitoring =
    shortcutNeedsKeyboardListenerPermission && permissions.inputMonitoring.status === 'denied';

  // 只给 startFnKeyCapture 用：它的依赖数组必须为空（见下方说明），但仍要拿到当前语言的
  // 文案。渲染期同步赋值，取到的就是本次渲染的 t，不会滞后一帧。
  const translateRef = useRef(t);
  translateRef.current = t;

  /**
   * 启动录制期的 Fn key capture，并把结果反映到提示区。
   *
   * 单独抽出来，是为了让「权限刚授予」这条路**只重启 capture**、不去重跑整个录制
   * effect：重跑会先跑 cleanup 里的 syncVoiceInputGlobalShortcut(已保存快捷键)，再由
   * setup 重新挂起，两步都是异步的，中间那个窗口里用户按下旧快捷键就会真的触发一次
   * 语音输入——而他本意只是在录新键。
   *
   * 同理，这个 callback 的依赖必须**为空**：录制 effect 依赖它，任何依赖项变化都会
   * 经由它的身份变化把整个录制 effect 重跑一遍，打开上面那段窗口。文案函数 `t` 的
   * 身份随界面语言变化，所以走 ref 取最新值，不进依赖数组。
   */
  const startFnKeyCapture = useCallback(async (isCancelled: () => boolean): Promise<void> => {
    if (window.electronAPI.platform !== 'darwin') return;
    // main 侧那条 IPC 现在会对非应用外壳窗口的 sender 抛（授权闸）。合法路径不会走到，但不接住
    // 就会变成 effect 里的 unhandled rejection —— 收成一次普通失败，走下面既有的分类。
    const result = await window.electronAPI.voiceInput
      .startModifierShortcutRecording()
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        // 归到 'failed'（helper 起不来那档）:被闸拒不是缺权限,不该显示「Fn 需要监听权限」。
        errorCode: 'failed' as const,
      }));
    // 只丢弃迟到的结果，不在这里补发 stop：那条 IPC 按 sender id 记账，而同一个设置页
    // 连续两轮录制用的是同一个 id，第一轮迟到的 stop 会把用户刚开始的第二轮 capture
    // 一起停掉。启动期间的取消由 main 侧 startChildProcess 的代次校验负责——那里才
    // 拿得到 child 与启动状态，renderer 猜不了这个时序。
    if (isCancelled()) return;
    // 被更晚的一轮顶掉：这次调用已经过时，真正的结果由那一轮给出。不能在这里改提示或
    // 弹错误，否则用户刚开始的第二轮录制会莫名收到一条上一轮的报错。
    if (!result.ok && result.errorCode === 'superseded') return;
    // blocked 只表示「确实缺权限」。以前只在成功时清掉，于是缺权限之后再来一次非权限
    // 失败（listener 坏了）会继续挂着「Fn 需要监听权限」，把用户指向错误的原因。
    const permissionBlocked = !result.ok && result.errorCode === 'permission';
    setFnRecordingBlocked(permissionBlocked);
    // 缺权限只挡住 Fn 检测，其它快捷键照录，所以在提示区说明而不是弹错误——
    // 弹错误会让用户以为整个录制坏了，然后放弃。
    if (result.ok || permissionBlocked) return;
    const translate = translateRef.current;
    toast.error(result.errorCode === 'failed'
      ? translate('settings.voiceInput.shortcut.toast.listenerUnavailable')
      : translate('settings.voiceInput.shortcut.toast.recordingFailed', { error: result.error }));
  }, []);

  // 用户去系统设置里打开开关后切回来（window focus 会触发 refreshPermissions），在这里
  // 补一次注册：event tap 跑在独立 helper 子进程里，重新 spawn 就能拿到新授权，不需要
  // 重启 App。少了这步，用户授权完会发现快捷键依然没反应，那个「去授权」入口就等于白点。
  const inputMonitoringGrantedRef = useRef(permissions.inputMonitoring.ok);
  useEffect(() => {
    const granted = permissions.inputMonitoring.ok;
    const justGranted = granted && !inputMonitoringGrantedRef.current;
    inputMonitoringGrantedRef.current = granted;
    if (!justGranted) return;
    if (recordingShortcut) {
      // 录制中：全局快捷键必须一直保持挂起，所以这里只补上之前失败的 Fn capture，
      // 绝不碰挂起状态，也不让录制 effect 重跑（那会产生一段旧快捷键被短暂恢复的
      // 窗口，用户此刻正在按键试录，会真的触发一次语音输入）。
      //
      // 必须带取消守卫：录制随时可能在这次 IPC 返回前结束（或组件卸载）。少了它，
      // 迟到的结果会把只在录制期有意义的提示重新点亮，还会漏掉那个 helper。
      let cancelled = false;
      void startFnKeyCapture(() => cancelled);
      return () => {
        cancelled = true;
      };
    }
    if (!shortcutNeedsKeyboardListenerPermission) return;
    // 授权拿到了 ≠ 快捷键一定起得来：helper 仍可能 spawn 失败、启动超时、起来就退。
    // 那时「待授权」说明会随权限转为已授权而消失，用户看到的是一切正常、按键却没反应。
    // 所以这条路和直接提交那条路一样要把失败说出来（DESIGN.md §11：错误要有下一步）。
    let cancelled = false;
    void (async () => {
      const result = await syncVoiceInputGlobalShortcut(settings.shortcut);
      // 组件卸载 / 权限又变了：迟到的结果不再弹提示。
      if (cancelled || result.ok) return;
      // 'permission' = 权限其实还没到位（比如刚才那次读到的是过期快照）：待授权说明和
      // 徽章都还在，不用再弹一条错误盖在上面。'superseded' 由顶掉它的那一轮负责报。
      if (result.errorCode === 'permission' || result.errorCode === 'superseded') return;
      toast.error(translateRef.current('settings.voiceInput.shortcut.toast.listenerUnavailable'));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    permissions.inputMonitoring.ok,
    recordingShortcut,
    settings.shortcut,
    shortcutNeedsKeyboardListenerPermission,
    startFnKeyCapture,
  ]);

  const showAppShortcutConflict = useCallback(
    (conflictId: AppShortcutId) => {
      const def = getAppShortcutDefinition(conflictId);
      toast.error(t('settings.shortcuts.errors.conflict', {
        name: t(def.labelKey, { defaultValue: def.id }),
      }));
    },
    [t],
  );

  const showComposerVoiceConflict = useCallback(() => {
    toast.error(t('settings.shortcuts.errors.composerVoiceConflict'));
  }, [t]);

  const hasComposerVoiceConflict = useCallback(
    (shortcut: VoiceInputShortcut | null): boolean =>
      findComposerVoiceInputConflict(
        getComposerSendShortcutPreference(),
        shortcut,
        window.electronAPI?.platform,
      ) !== null,
    [],
  );

  const commitRecordedShortcut = useCallback(
    (shortcut: VoiceInputShortcut | null) => {
      // 提交代次。录制框在这次提交 await 期间仍然开着，用户可以再录一个键提交第二次；
      // main 侧的串行队列只保证最终存盘是最后那次，两次的**结果**照旧都会回到这里。
      //
      // 少了这道闸，过时那次的副作用会照常执行：收口录制框、弹它自己的提示，甚至在用户
      // 最新选的快捷键根本不需要监听权限时（比如改成了 F16）弹出 macOS 授权窗。
      const submission = (shortcutSubmissionRef.current += 1);
      const isStaleSubmission = (): boolean => shortcutSubmissionRef.current !== submission;
      const commit = (async () => {
        await shortcutSuspendPromiseRef.current;
        const result = await setShortcut(shortcut);
        if (isStaleSubmission()) return;
        // 被更晚的一轮顶掉：那一轮才决定最终结果，这里静默丢弃，不报错也不收口录制态。
        if (!result.ok && result.errorCode === 'superseded') return;
        if (!result.ok && result.conflict === 'composer-voice-input') {
          showComposerVoiceConflict();
          if (shortcut) setRecordingShortcutPreview(shortcut);
          return;
        }
        if (!result.ok) {
          // 'failed' = 原生 listener 起不来。main 已把细节消毒成固定英文（原文含内部
          // 路径），所以这里改用自带下一步的中文文案，不再把那句英文插进模板。
          toast.error(result.errorCode === 'failed'
            ? t('settings.voiceInput.shortcut.toast.listenerUnavailable')
            : t('settings.voiceInput.shortcut.toast.registrationFailed', { error: result.error }));
          if (shortcut) setRecordingShortcutPreview(shortcut);
          return;
        }
        setRecordingShortcutPreview(null);
        setRecordingShortcut(false);
        // 快捷键已存下来但还缺监听权限：这是用户刚做完的动作，正是请求授权最自然的时机。
        // 只弹系统授权请求，不额外打开「系统设置」面板（那个窗自带跳转按钮）。
        if (result.pendingInputMonitoring) {
          toast.info(t('settings.voiceInput.shortcut.toast.pendingInputMonitoring'));
          try {
            await window.electronAPI.voiceInput.requestInputMonitoringPermission();
          } catch (error) {
            // 请求本身失败不额外打扰用户：权限徽章与行内说明已经把状态和入口摆在那了。
            // 但要留下可诊断的痕迹；main 侧已按 IPC 错误协议消毒过 message。
            log.warn('input monitoring permission request failed:', extractIpcError(error)?.code ?? error);
          }
          schedulePermissionRefresh({ immediate: true });
        }
      })();
      // 录制 effect 的 cleanup 要靠它决定「现在能不能读存盘去恢复注册」：提交还在飞时
      // 存盘里还是旧快捷键，此刻恢复等于在这次提交之后又把旧的注册回去。
      shortcutCommitPromiseRef.current = commit;
      void commit.finally(() => {
        if (shortcutCommitPromiseRef.current === commit) shortcutCommitPromiseRef.current = null;
      });
    },
    [schedulePermissionRefresh, setShortcut, showComposerVoiceConflict, t],
  );

  const getAppShortcutEntries = useCallback((): AppShortcutComboEntry[] => {
    // 未被 override 的让位槽位(switch-session-*,yieldsToUserBindings)不算
    // 占用:语音录制提交后 appShortcutStore 会经 yieldToCombos 压掉该槽位
    // 默认,用户显式录制获胜 —— 与 findAppShortcutConflict 对 app 快捷键
    // 改绑的放行同一规则,否则存量语音绑定能赢、新录制却被卡死。
    const overrides = getAppShortcutOverrides();
    return APP_SHORTCUT_DEFINITIONS.filter(
      (def) => !(def.yieldsToUserBindings && overrides[def.id] === undefined),
    ).map((def) => ({
      id: def.id,
      combos: getAppShortcutCombos(def.id),
    }));
  }, []);

  const handleShortcutKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!recordingShortcut) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        pendingModifierShortcutCodeRef.current = null;
        pendingKeyboardShortcutRef.current = null;
        nativeFnShortcutActiveRef.current = false;
        nativeFnComboSeenRef.current = false;
        setRecordingShortcutPreview(null);
        setRecordingShortcut(false);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        pendingModifierShortcutCodeRef.current = null;
        pendingKeyboardShortcutRef.current = null;
        nativeFnShortcutActiveRef.current = false;
        nativeFnComboSeenRef.current = false;
        setRecordingShortcutPreview(null);
        commitRecordedShortcut(null);
        return;
      }

      if (nativeFnShortcutActiveRef.current || event.nativeEvent.getModifierState?.('Fn')) {
        nativeFnShortcutActiveRef.current = true;
        return;
      }

      const bareModifierCode = getVoiceInputBareModifierCodeFromEvent(event.nativeEvent);
      if (bareModifierCode) {
        // Bare modifier shortcuts are confirmed on keyup so users can keep
        // holding Command/Option/Control and press a normal key to record a
        // regular combination such as Command+1 or Shift+1.
        pendingModifierShortcutCodeRef.current = bareModifierCode;
        pendingKeyboardShortcutRef.current = null;
        setRecordingShortcutPreview(createVoiceInputModifierShortcut(bareModifierCode));
        return;
      }

      const shortcut = createVoiceInputShortcutFromEvent(event.nativeEvent);
      if (!shortcut) return;
      if (!isStandaloneVoiceInputShortcutAllowed(shortcut)) {
        toast.error(
          t(
            isBarePrintableVoiceInputShortcut(shortcut)
              ? 'settings.voiceInput.shortcut.toast.fnUnavailable'
              : 'settings.voiceInput.shortcut.toast.needsModifier',
          ),
        );
        return;
      }
      if (isSystemReservedVoiceInputShortcut(shortcut)) {
        toast.error(t('settings.voiceInput.shortcut.toast.systemReserved'));
        return;
      }
      if (hasComposerVoiceConflict(shortcut)) {
        showComposerVoiceConflict();
        return;
      }
      const conflictId = findVoiceInputAppShortcutConflict(shortcut, getAppShortcutEntries());
      if (conflictId) {
        showAppShortcutConflict(conflictId);
        return;
      }
      pendingModifierShortcutCodeRef.current = null;
      pendingKeyboardShortcutRef.current = shortcut;
      setRecordingShortcutPreview(shortcut);
    },
    [
      commitRecordedShortcut,
      getAppShortcutEntries,
      hasComposerVoiceConflict,
      recordingShortcut,
      showAppShortcutConflict,
      showComposerVoiceConflict,
      t,
    ],
  );

  const handleShortcutKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!recordingShortcut) return;
      event.preventDefault();
      event.stopPropagation();

      const pendingKeyboardShortcut = pendingKeyboardShortcutRef.current;
      if (nativeFnShortcutActiveRef.current || pendingKeyboardShortcut?.modifiers.fn) {
        return;
      }
      if (pendingKeyboardShortcut && isVoiceInputShortcutRelease(event.nativeEvent, pendingKeyboardShortcut)) {
        pendingKeyboardShortcutRef.current = null;
        pendingModifierShortcutCodeRef.current = null;
        nativeFnShortcutActiveRef.current = false;
        nativeFnComboSeenRef.current = false;
        setRecordingShortcutPreview(null);
        commitRecordedShortcut(pendingKeyboardShortcut);
        return;
      }

      const bareModifierCode = getVoiceInputBareModifierCodeFromEvent(event.nativeEvent);
      if (!bareModifierCode || pendingModifierShortcutCodeRef.current !== bareModifierCode) return;

      const shortcut = createVoiceInputModifierShortcut(bareModifierCode);
      if (!shortcut) return;
      pendingModifierShortcutCodeRef.current = null;
      pendingKeyboardShortcutRef.current = null;
      nativeFnShortcutActiveRef.current = false;
      nativeFnComboSeenRef.current = false;
      setRecordingShortcutPreview(null);
      commitRecordedShortcut(shortcut);
    },
    [commitRecordedShortcut, recordingShortcut],
  );

  const handleNativeModifierShortcutKeys = useCallback(
    (payload: { keys: string[] }) => {
      if (!recordingShortcut) return;
      const keys = Array.isArray(payload.keys) ? payload.keys : [];
      const fnDown = keys.includes('Fn');
      const nativeShortcut = createVoiceInputShortcutFromMacNativeKeys(keys);

      if (!fnDown) {
        if (!nativeFnShortcutActiveRef.current) return;
        const shortcut = pendingKeyboardShortcutRef.current ??
          (pendingModifierShortcutCodeRef.current ? createVoiceInputModifierShortcut(pendingModifierShortcutCodeRef.current) : null);
        nativeFnShortcutActiveRef.current = false;
        nativeFnComboSeenRef.current = false;
        pendingModifierShortcutCodeRef.current = null;
        pendingKeyboardShortcutRef.current = null;
        setRecordingShortcutPreview(null);
        if (shortcut) {
          if (hasComposerVoiceConflict(shortcut)) {
            showComposerVoiceConflict();
            return;
          }
          const conflictId = findVoiceInputAppShortcutConflict(shortcut, getAppShortcutEntries());
          if (conflictId) {
            showAppShortcutConflict(conflictId);
            return;
          }
          commitRecordedShortcut(shortcut);
        }
        return;
      }

      nativeFnShortcutActiveRef.current = true;

      if (nativeShortcut?.trigger === 'keyboard') {
        nativeFnComboSeenRef.current = true;
        pendingModifierShortcutCodeRef.current = null;
        pendingKeyboardShortcutRef.current = nativeShortcut;
        setRecordingShortcutPreview(nativeShortcut);
        return;
      }

      if (nativeShortcut?.trigger === 'modifier' && !nativeFnComboSeenRef.current && !pendingKeyboardShortcutRef.current) {
        pendingModifierShortcutCodeRef.current = nativeShortcut.code;
        pendingKeyboardShortcutRef.current = null;
        setRecordingShortcutPreview(nativeShortcut);
        return;
      }

      if (nativeFnComboSeenRef.current && pendingKeyboardShortcutRef.current) {
        setRecordingShortcutPreview(pendingKeyboardShortcutRef.current);
        return;
      }

      nativeFnComboSeenRef.current = true;
      pendingModifierShortcutCodeRef.current = null;
      pendingKeyboardShortcutRef.current = null;
      setRecordingShortcutPreview(null);
    },
    [
      commitRecordedShortcut,
      getAppShortcutEntries,
      hasComposerVoiceConflict,
      recordingShortcut,
      showAppShortcutConflict,
      showComposerVoiceConflict,
    ],
  );

  useEffect(() => {
    if (!recordingShortcut) return;
    shortcutButtonRef.current?.focus();
  }, [recordingShortcut]);

  useEffect(() => {
    if (!recordingShortcut || window.electronAPI.platform !== 'darwin') return;
    const unsubscribe = window.electronAPI.voiceInput.onModifierShortcutKeys(handleNativeModifierShortcutKeys);
    return () => {
      unsubscribe();
      nativeFnShortcutActiveRef.current = false;
      nativeFnComboSeenRef.current = false;
    };
  }, [handleNativeModifierShortcutKeys, recordingShortcut]);

  useEffect(() => {
    if (recordingShortcut) return;
    pendingModifierShortcutCodeRef.current = null;
    pendingKeyboardShortcutRef.current = null;
    nativeFnShortcutActiveRef.current = false;
    nativeFnComboSeenRef.current = false;
    setRecordingShortcutPreview(null);
    setFnRecordingBlocked(false);
  }, [recordingShortcut]);

  useEffect(() => {
    if (!recordingShortcut) return;
    // Suspend the bound global shortcut and app shortcuts while recording.
    // Otherwise pressing an already-owned combo can be intercepted by the
    // OS-level handler, menu accelerator, or renderer capture listener before
    // this settings page receives keydown and can show the conflict message.
    // The cleanup re-syncs the current shortcut value (whatever it is after
    // recording: the new key, unchanged old key on Escape, or null after
    // Backspace clear).
    //
    // 这个 effect **不**依赖监听权限：录制中途授权后只需补一次 Fn capture，那由权限
    // effect 直接调 startFnKeyCapture 完成。若改成让本 effect 重跑，cleanup 会先异步
    // 恢复已保存的全局快捷键、setup 再把它挂起，中间那段窗口里用户按下旧快捷键会真的
    // 触发一次语音输入。
    document.body.dataset.appShortcutRecording = '1';
    window.electronAPI.appShortcuts.setRecording(true);
    // 录制轮次。cleanup 里的恢复是异步的（要等在飞的提交），这期间用户可能已经开始下一轮
    // 录制 —— 那一轮才拥有「挂起」这个状态，上一轮的恢复必须让位，见下。
    const recordingSession = (recordingSessionRef.current += 1);
    let cancelled = false;
    // 显式的「挂起」而不是 sync(null)：main 侧按存盘校验同步请求，而挂起故意与存盘不同。
    const suspendPromise = suspendVoiceInputGlobalShortcut().then(() => {
      if (cancelled) return;
      return startFnKeyCapture(() => cancelled);
    });
    shortcutSuspendPromiseRef.current = suspendPromise;
    return () => {
      cancelled = true;
      shortcutSuspendPromiseRef.current = null;
      delete document.body.dataset.appShortcutRecording;
      window.electronAPI.appShortcuts.setRecording(false);
      // 不分平台都要发：挂起那条 IPC 在 main 侧登记了录制会话（它也不分平台），而这条 stop
      // 是唯一会把它摘掉的。只在 darwin 发的话，Windows 用户按 Esc 取消录制后会话一直挂着，
      // 随后的恢复同步被 main 的「录制中」守卫拒掉 —— 原来的全局快捷键就一直是停用的，直到
      // 这个 renderer 被销毁。stop handler 本身与平台无关（非 darwin 上 key capture 压根没起，
      // stopKeyCapture 是空操作）。
      void window.electronAPI.voiceInput.stopModifierShortcutRecording();
      // 恢复注册必须等在飞的那次提交落地再读存盘。
      //
      // 切走设置 tab 会卸载本组件，cleanup 立刻跑；此刻提交还没存盘，getVoiceInputSettings()
      // 读到的是**旧**快捷键，而它排到 main 队列里又在那次提交之后 —— 结果是存盘和界面都
      // 指向新快捷键，实际生效的却是旧那个，直到下次进这个 tab 才被纠正。
      //
      // 等它落地就能对上：提交成功时读到的是新快捷键（重复注册同一个是幂等的），提交失败时
      // 读到的仍是旧那个，而那正是此时该生效的。所以两条路都不需要额外判断。
      //
      // 而且必须让位给新一轮录制：第一轮提交没落地就结束录制、紧接着开始第二轮时，这条恢复
      // 会经同一条 main 队列排在第二轮的「挂起」之后 —— 把旧快捷键又启用回来，用户在第二轮
      // 按键试录就会真的触发一次语音输入。轮次对不上就直接放弃：那一轮自己会在结束时恢复。
      const restoreRegistration = (): void => {
        if (recordingSessionRef.current !== recordingSession) return;
        void syncVoiceInputGlobalShortcut(getVoiceInputSettings().shortcut);
      };
      const pendingCommit = shortcutCommitPromiseRef.current;
      if (pendingCommit) {
        void pendingCommit.then(restoreRegistration, restoreRegistration);
      } else {
        restoreRegistration();
      }
    };
  }, [recordingShortcut, startFnKeyCapture]);

  // 组件卸载（切走设置 tab、关掉设置页）时作废在飞的提交：代次原先只在下一次提交时才推进，
  // 于是切走之后迟到的结果照样会执行副作用 —— 弹一条已经无处安放的提示，甚至凭一个用户
  // 早已离开的界面上的选择弹出 macOS 授权窗。注册本身由 main 侧负责，不受此影响。
  useEffect(() => () => {
    shortcutSubmissionRef.current += 1;
  }, []);

  useEffect(() => {
    if (!settings.refinementEnabled) {
      setRefinementRulesExpanded(false);
      setCustomDictionaryExpanded(false);
      setDictionarySearchExpanded(false);
      setDictionarySearch('');
      setAddingDictionaryEntry(false);
      setNewDictionaryEntryText('');
      setEditingDictionaryEntryId(null);
      setEditingDictionaryEntryText('');
    }
  }, [settings.refinementEnabled]);

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophones([]);
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === 'audioinput'));
    } catch {
      setMicrophones([]);
    }
  }, []);

  useEffect(() => {
    void refreshMicrophones();
    if (!navigator.mediaDevices?.addEventListener) return;
    navigator.mediaDevices.addEventListener('devicechange', refreshMicrophones);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshMicrophones);
  }, [refreshMicrophones]);

  const selectedMicrophoneMissing = useMemo(() => {
    if (!settings.microphoneDeviceId) return false;
    return !microphones.some((device) => device.deviceId === settings.microphoneDeviceId);
  }, [microphones, settings.microphoneDeviceId]);

  const languageOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<VoiceInputLanguage>>>(
    () =>
      LANGUAGE_OPTIONS.map((language) => ({
        value: language,
        label:
          language === 'auto'
            ? t('settings.voiceInput.language.options.auto')
            : t(`settings.language.options.${language}`),
        description: t(`settings.voiceInput.language.optionDescriptions.${language}`),
      })),
    [t],
  );

  const microphoneOptions = useMemo<ReadonlyArray<VoiceInputSelectOption<string>>>(() => {
    const options: VoiceInputSelectOption<string>[] = [
      {
        value: AUTO_MICROPHONE_VALUE,
        label: t('settings.voiceInput.microphone.options.auto'),
        description: t('settings.voiceInput.microphone.options.autoDetail'),
      },
    ];
    if (selectedMicrophoneMissing && settings.microphoneDeviceId) {
      options.push({
        value: settings.microphoneDeviceId,
        label: t('settings.voiceInput.microphone.options.unavailable'),
        description: t('settings.voiceInput.microphone.options.unavailableDetail'),
      });
    }
    microphones.forEach((device, index) => {
      options.push({
        value: device.deviceId,
        label: deviceLabel(
          device,
          t('settings.voiceInput.microphone.options.unnamed', { index: index + 1 }),
        ),
      });
    });
    return options;
  }, [microphones, selectedMicrophoneMissing, settings.microphoneDeviceId, t]);

  const dictionaryCounts = useMemo(() => {
    const automatic = settings.dictionaryEntries.filter((entry) => entry.source === 'automatic').length;
    const manual = settings.dictionaryEntries.filter((entry) => entry.source === 'manual').length;
    return {
      all: settings.dictionaryEntries.length,
      automatic,
      manual,
    };
  }, [settings.dictionaryEntries]);

  const filteredDictionaryEntries = useMemo(
    () =>
      settings.dictionaryEntries
        .filter((entry) =>
          dictionaryEntryMatches(entry, dictionaryFilter, dictionarySearch),
        )
        .sort((a, b) => {
          if (a.source !== b.source) return a.source === 'manual' ? -1 : 1;
          if (a.source === 'automatic') return b.frequency - a.frequency || b.updatedAt - a.updatedAt;
          return b.updatedAt - a.updatedAt;
        }),
    [dictionaryFilter, dictionarySearch, settings.dictionaryEntries],
  );

  const addDictionaryEntry = useCallback(() => {
    const text = normalizeVoiceInputDictionaryEntryText(newDictionaryEntryText);
    if (!text) return;
    // 等主进程确认写入成功再清草稿关面板:失败时保留用户输入,别让他重打一遍。
    void addDictionarySettingEntry(text).then((ok) => {
      if (!ok) return;
      setNewDictionaryEntryText('');
      setAddingDictionaryEntry(false);
    });
  }, [addDictionarySettingEntry, newDictionaryEntryText]);

  const closeDictionaryEntryDialog = useCallback(() => {
    setAddingDictionaryEntry(false);
    setNewDictionaryEntryText('');
  }, []);

  const importDictionaryCsvFile = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith('.csv')) {
      toast.error(t('settings.voiceInput.refinement.dictionary.csvImport.errors.fileType'));
      return;
    }
    if (file.size > MAX_VOICE_INPUT_DICTIONARY_CSV_BYTES) {
      toast.error(t('settings.voiceInput.refinement.dictionary.csvImport.errors.fileTooLarge'));
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.error(t('settings.voiceInput.refinement.dictionary.csvImport.errors.readFailed'));
      return;
    }

    const parsed = parseVoiceInputDictionaryCsv(text);
    if (!parsed.ok) {
      toast.error(
        t(
          parsed.reason === 'empty'
            ? 'settings.voiceInput.refinement.dictionary.csvImport.errors.empty'
            : 'settings.voiceInput.refinement.dictionary.csvImport.errors.invalidCsv',
          { fileName: file.name },
        ),
      );
      return;
    }

    const merged = mergeVoiceInputDictionaryCsvTerms(settings.dictionaryEntries, parsed.terms);
    if (merged.importedCount === 0) {
      toast.warning(
        t(
          merged.capacitySkippedCount > 0
            ? 'settings.voiceInput.refinement.dictionary.csvImport.errors.capacityFull'
            : 'settings.voiceInput.refinement.dictionary.csvImport.errors.allDuplicate',
        ),
      );
      return;
    }

    // 容量与去重裁决仍由 mergeVoiceInputDictionaryCsvTerms 负责(下面的统计文案依赖
    // 它的计数),但写入只提交「本次真正新增的词条文本」,由主进程按手动词条认领。
    // 去重键必须与同步主键同一套折叠(locale 无关),否则土耳其语这类 locale 下
    // 会出现「明明已存在却被当成新增」或反之,导入结果与实际合并结果对不上。
    const existingKeys = new Set(
      settings.dictionaryEntries.map((entry) => dictionaryTermKey(entry.text)),
    );
    const imported = await importDictionarySettingEntries(
      merged.entries
        .filter((entry) => !existingKeys.has(dictionaryTermKey(entry.text)))
        .map((entry) => entry.text),
    );
    // 写入失败时错误提示已经弹过了,不能再报一次"导入成功"。
    if (!imported) return;
    closeDictionaryEntryDialog();
    const skippedCount =
      parsed.duplicateRowCount +
      parsed.skippedTooLongCount +
      merged.duplicateExistingCount +
      merged.capacitySkippedCount;
    toast.success(
      t(
        skippedCount > 0
          ? 'settings.voiceInput.refinement.dictionary.csvImport.successWithSkipped'
          : 'settings.voiceInput.refinement.dictionary.csvImport.success',
        {
          count: merged.importedCount,
          skipped: skippedCount,
        },
      ),
    );
  }, [
    closeDictionaryEntryDialog,
    importDictionarySettingEntries,
    settings.dictionaryEntries,
    t,
  ]);

  const startEditingDictionaryEntry = useCallback((entry: VoiceInputDictionaryEntry) => {
    setEditingDictionaryEntryId(entry.id);
    setEditingDictionaryEntryText(entry.text);
  }, []);

  const cancelEditingDictionaryEntry = useCallback(() => {
    setEditingDictionaryEntryId(null);
    setEditingDictionaryEntryText('');
  }, []);

  const saveEditingDictionaryEntry = useCallback(() => {
    if (!editingDictionaryEntryId) return;
    const text = normalizeVoiceInputDictionaryEntryText(editingDictionaryEntryText);
    // 清空文本仍然等于删除该词条(与改动前的交互一致)。
    if (!text) {
      void deleteDictionarySettingEntry(editingDictionaryEntryId).then((ok) => {
        if (ok) cancelEditingDictionaryEntry();
      });
      return;
    }
    void renameDictionarySettingEntry(editingDictionaryEntryId, text).then((ok) => {
      if (ok) cancelEditingDictionaryEntry();
    });
  }, [
    cancelEditingDictionaryEntry,
    deleteDictionarySettingEntry,
    editingDictionaryEntryId,
    editingDictionaryEntryText,
    renameDictionarySettingEntry,
  ]);

  const deleteDictionaryEntry = useCallback(
    (entryId: string) => {
      deleteDictionarySettingEntry(entryId);
      if (editingDictionaryEntryId === entryId) {
        cancelEditingDictionaryEntry();
      }
    },
    [
      cancelEditingDictionaryEntry,
      deleteDictionarySettingEntry,
      editingDictionaryEntryId,
    ],
  );

  const toggleDictionarySearch = useCallback(() => {
    if (dictionarySearchExpanded) {
      setDictionarySearch('');
    }
    setDictionarySearchExpanded(!dictionarySearchExpanded);
  }, [dictionarySearchExpanded]);

  const canResetUsageStats = stats.totalAudioMs > 0 || stats.sessionCount > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.voiceInput.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.voiceInput.description')}
        </p>
      </div>

      <VoiceInputServiceSourceCard />

      <VoiceInputCard title={t('settings.voiceInput.sections.basics')}>
        <VoiceInputInlineSettingRow
          label={t('settings.voiceInput.language.label')}
          hint={t('settings.voiceInput.language.hint')}
        >
          <VoiceInputSelect
            value={settings.language}
            options={languageOptions}
            onChange={setLanguage}
            ariaLabel={t('settings.voiceInput.language.ariaLabel')}
          />
        </VoiceInputInlineSettingRow>

        <VoiceInputInlineSettingRow
          label={t('settings.voiceInput.microphone.label')}
          labelAction={
            <VoiceInputPermissionBadge
              label={t('settings.voiceInput.permissions.microphone.label')}
              granted={permissions.microphone.ok}
              onGrant={() => void requestPermission('microphone')}
            />
          }
          hint={t('settings.voiceInput.microphone.hint')}
        >
          <VoiceInputSelect
            value={settings.microphoneDeviceId ?? AUTO_MICROPHONE_VALUE}
            options={microphoneOptions}
            onChange={(value) =>
              setMicrophoneDeviceId(value === AUTO_MICROPHONE_VALUE ? null : value)
            }
            ariaLabel={t('settings.voiceInput.microphone.ariaLabel')}
          />
        </VoiceInputInlineSettingRow>

        <VoiceInputInlineSettingRow
          label={t('settings.voiceInput.shortcut.label')}
          labelAction={
            shouldShowInputMonitoringBadge({
              supportsGlobalShortcut: supportsGlobalShortcutSetting,
              shortcutNeedsPermission: shortcutNeedsKeyboardListenerPermission,
              fnRecordingBlocked,
              permissionStatus: permissions.inputMonitoring.status,
            })
              ? (
                <VoiceInputPermissionBadge
                  label={t('settings.voiceInput.permissions.inputMonitoring.label')}
                  granted={permissions.inputMonitoring.ok}
                  onGrant={() => void requestPermission('inputMonitoring')}
                  tooltip={t('settings.voiceInput.permissions.inputMonitoring.tooltip')}
                />
              )
              : null
          }
          hint={
            supportsGlobalShortcutSetting
              ? (
                <>
                  {t('settings.voiceInput.shortcut.hint')}
                  {/* 录制中缺权限 → 解释 Fn 为什么按了没反应；已保存但待授权 → 解释快捷键
                      为什么不生效。前者是用户当下正在做的事，优先显示。 */}
                  {fnRecordingBlocked ? (
                    <span className="mt-1 block">
                      {t('settings.voiceInput.shortcut.fnNeedsInputMonitoring')}
                    </span>
                  ) : shortcutAwaitingInputMonitoring ? (
                    <span className="mt-1 block">
                      {t('settings.voiceInput.shortcut.awaitingInputMonitoring')}
                    </span>
                  ) : null}
                </>
              )
              : t('settings.voiceInput.shortcut.linuxUnsupported')
          }
        >
          {supportsGlobalShortcutSetting ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:justify-end">
              <button
                ref={shortcutButtonRef}
                type="button"
                onClick={() => setRecordingShortcut(true)}
                onKeyDown={handleShortcutKeyDown}
                onKeyUp={handleShortcutKeyUp}
                className={cn(
                  'flex min-h-[40px] min-w-[180px] flex-1 items-center justify-between gap-2.5 rounded-[14px] px-3.5 sm:flex-none',
                  'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                  'text-left text-[var(--settings-input-text)] outline-none transition-colors',
                  recordingShortcut
                    ? 'border-[var(--settings-section-title)]'
                    : 'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
                )}
                aria-label={t('settings.voiceInput.shortcut.ariaLabel')}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Keyboard size={15} className="shrink-0 text-[var(--settings-section-sublabel)]" />
                  <span className="truncate text-14 font-medium leading-[1.25]">
                    {shortcutLabel}
                  </span>
                </span>
              </button>

              <button
                type="button"
                disabled={!settings.shortcut}
                onClick={() => commitRecordedShortcut(null)}
                className={cn(
                  'h-8 shrink-0 rounded-full px-3 text-12 font-medium transition-colors',
                  'border border-[var(--settings-btn-secondary-border)]',
                  'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                  'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                  'disabled:cursor-not-allowed disabled:opacity-45',
                )}
              >
                {t('settings.voiceInput.shortcut.clear')}
              </button>
            </div>
          ) : (
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.shortcut.linuxUnsupported')}
            </p>
          )}
        </VoiceInputInlineSettingRow>
      </VoiceInputCard>

      <VoiceInputCard title={t('settings.voiceInput.sections.refinement')}>
        <div className="flex items-center justify-between gap-5">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <p
                className="min-w-0 text-13 font-medium text-[var(--settings-section-title)]"
                style={{ letterSpacing: '0.12px' }}
              >
                {t('settings.voiceInput.refinement.enabled.label')}
              </p>
              {permissions.accessibility.status === 'not-required'
                ? null
                : (
                  <VoiceInputPermissionBadge
                    label={t('settings.voiceInput.permissions.accessibility.label')}
                    granted={permissions.accessibility.ok}
                    onGrant={() => void requestPermission('accessibility')}
                    tooltip={t('settings.voiceInput.permissions.accessibility.tooltip')}
                  />
                )}
            </div>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.refinement.enabled.hint')}
            </p>
          </div>

          <Switch
            checked={settings.refinementEnabled}
            onCheckedChange={setRefinementEnabled}
            aria-label={t('settings.voiceInput.refinement.enabled.ariaLabel')}
          />
        </div>

        {settings.refinementEnabled ? (
          <div className="flex flex-col gap-4 border-t border-[var(--settings-theme-card-border)] pt-4">
            <VoiceInputCollapsibleTextarea
              id="voice-input-refinement-instructions"
              label={t('settings.voiceInput.refinement.instructions.label')}
              hint={t('settings.voiceInput.refinement.instructions.hint')}
              expanded={refinementRulesExpanded}
              onExpandedChange={setRefinementRulesExpanded}
              value={settings.refinementInstructions}
              onChange={setRefinementInstructions}
              maxLength={MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS}
              rows={5}
              ariaLabel={t('settings.voiceInput.refinement.instructions.ariaLabel')}
              placeholder={t('settings.voiceInput.refinement.instructions.placeholder')}
              editLabel={t('settings.voiceInput.refinement.instructions.edit')}
              collapseLabel={t('settings.voiceInput.refinement.instructions.collapse')}
            />

            <div className="border-t border-[var(--settings-theme-card-border)] pt-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p
                    className="text-13 font-medium text-[var(--settings-section-title)]"
                    style={{ letterSpacing: '0.12px' }}
                  >
                    {t('settings.voiceInput.refinement.dictionary.label')}
                  </p>
                  <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                    {t('settings.voiceInput.refinement.dictionary.hint')}
                  </p>
                </div>

                <button
                  type="button"
                  aria-expanded={customDictionaryExpanded}
                  aria-controls="voice-input-custom-dictionary"
                  onClick={() => {
                    if (customDictionaryExpanded) {
                      setDictionarySearchExpanded(false);
                      setDictionarySearch('');
                    }
                    setCustomDictionaryExpanded(!customDictionaryExpanded);
                  }}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors',
                    'border border-[var(--settings-btn-secondary-border)]',
                    'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                    'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                  )}
                >
                  <span>
                    {t(
                      customDictionaryExpanded
                        ? 'settings.voiceInput.refinement.instructions.collapse'
                        : 'settings.voiceInput.refinement.instructions.edit',
                    )}
                  </span>
                  <ChevronDown
                    size={14}
                    className={cn('transition-transform', customDictionaryExpanded && 'rotate-180')}
                  />
                </button>
              </div>

              {customDictionaryExpanded ? (
                <div id="voice-input-custom-dictionary" className="mt-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-4 rounded-[12px] border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2.5">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="text-13 font-medium text-[var(--settings-section-title)]">
                        {t('settings.voiceInput.refinement.dictionary.autoLearning.label')}
                      </p>
                      <p className="text-12 leading-[1.35] text-[var(--settings-section-sublabel)] opacity-70">
                        {t('settings.voiceInput.refinement.dictionary.autoLearning.hint')}
                        {!externalDictionaryLearningSupported ? (
                          <span className="mt-1 block">
                            {t('settings.voiceInput.refinement.dictionary.autoLearning.externalAppMacOnly')}
                          </span>
                        ) : null}
                      </p>
                    </div>

                    <Switch
                      checked={settings.autoDictionaryEnabled}
                      onCheckedChange={setAutoDictionaryEnabled}
                      aria-label={t('settings.voiceInput.refinement.dictionary.autoLearning.ariaLabel')}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 rounded-[12px] border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2.5">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="text-13 font-medium text-[var(--settings-section-title)]">
                        {t('settings.voiceInput.refinement.dictionary.deviceSync.label')}
                      </p>
                      <p className="text-12 leading-[1.35] text-[var(--settings-section-sublabel)] opacity-70">
                        {t('settings.voiceInput.refinement.dictionary.deviceSync.hint')}
                      </p>
                    </div>

                    <Switch
                      checked={settings.dictionarySyncEnabled}
                      onCheckedChange={setDictionarySyncEnabled}
                      aria-label={t('settings.voiceInput.refinement.dictionary.deviceSync.ariaLabel')}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex rounded-full bg-[var(--settings-btn-secondary-bg)] p-1">
                      {DICTIONARY_FILTERS.map((filter) => (
                        <button
                          key={filter}
                          type="button"
                          onClick={() => setDictionaryFilter(filter)}
                          className={cn(
                            'flex h-8 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors',
                            dictionaryFilter === filter
                              ? 'bg-[var(--settings-theme-card-bg)] text-[var(--settings-section-title)]'
                              : 'text-[var(--settings-section-sublabel)] hover:text-[var(--settings-section-title)]',
                          )}
                        >
                          {t(`settings.voiceInput.refinement.dictionary.filters.${filter}`)}
                          <span className="text-11 opacity-60">
                            {dictionaryCounts[filter]}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <Tip
                        text={t(
                          dictionarySearchExpanded
                            ? 'settings.voiceInput.refinement.dictionary.closeSearch'
                            : 'settings.voiceInput.refinement.dictionary.searchAriaLabel',
                        )}
                        side="top"
                      >
                        <button
                          type="button"
                          aria-pressed={dictionarySearchExpanded}
                          aria-label={t(
                            dictionarySearchExpanded
                              ? 'settings.voiceInput.refinement.dictionary.closeSearch'
                              : 'settings.voiceInput.refinement.dictionary.searchAriaLabel',
                          )}
                          onClick={toggleDictionarySearch}
                          className={cn(
                            'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                            'border border-[var(--settings-btn-secondary-border)]',
                            dictionarySearchExpanded
                              ? 'bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)]'
                              : 'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)] hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                          )}
                        >
                          <Search size={14} />
                        </button>
                      </Tip>

                      <button
                        type="button"
                        onClick={() => {
                          setAddingDictionaryEntry(true);
                          setNewDictionaryEntryText('');
                        }}
                        className={cn(
                          'flex h-8 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors',
                          'bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)]',
                          'hover:opacity-85',
                        )}
                      >
                        <Plus size={14} />
                        {t('settings.voiceInput.refinement.dictionary.add')}
                      </button>
                    </div>
                  </div>

                  {dictionarySearchExpanded ? (
                    <div className="relative">
                      <Search
                        size={14}
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--settings-section-sublabel)]"
                      />
                      <input
                        ref={dictionarySearchInputRef}
                        value={dictionarySearch}
                        onChange={(event) => setDictionarySearch(event.currentTarget.value)}
                        aria-label={t('settings.voiceInput.refinement.dictionary.searchAriaLabel')}
                        placeholder={t('settings.voiceInput.refinement.dictionary.searchPlaceholder')}
                        className={cn(
                          'h-10 w-full rounded-full pl-9 pr-4',
                          'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                          'text-13 text-[var(--settings-input-text)] outline-none transition-colors',
                          'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-45',
                          'hover:border-[var(--settings-input-border-focus)] focus-visible:border-[var(--settings-input-border-focus)]',
                        )}
                      />
                    </div>
                  ) : null}

                  <Dialog.Root
                    open={addingDictionaryEntry}
                    onOpenChange={(open) => {
                      if (!open) {
                        closeDictionaryEntryDialog();
                        return;
                      }
                      setAddingDictionaryEntry(true);
                    }}
                  >
                    <Dialog.Portal>
                      <Dialog.Overlay
                        className={cn(
                          'fixed inset-0 z-50 bg-[var(--overlay-modal)]',
                          'data-[state=open]:animate-confirm-overlay-in',
                          'data-[state=closed]:animate-confirm-overlay-out',
                        )}
                        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                      />
                      <Dialog.Content
                        className={cn(
                          'fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2',
                          'rounded-[18px] border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
                          'p-5 shadow-[var(--shadow-menu)] outline-none',
                          'data-[state=open]:animate-confirm-content-in',
                          'data-[state=closed]:animate-confirm-content-out',
                        )}
                        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                      >
                        <Dialog.Title className="text-18 font-semibold leading-[1.35] text-[var(--settings-section-title)]">
                          {t('settings.voiceInput.refinement.dictionary.addDialog.title')}
                        </Dialog.Title>
                        <Dialog.Description className="sr-only">
                          {t('settings.voiceInput.refinement.dictionary.addDialog.description')}
                        </Dialog.Description>
                        <input
                          ref={newDictionaryEntryInputRef}
                          value={newDictionaryEntryText}
                          onChange={(event) => setNewDictionaryEntryText(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              addDictionaryEntry();
                            }
                            if (event.key === 'Escape') {
                              closeDictionaryEntryDialog();
                            }
                          }}
                          aria-label={t('settings.voiceInput.refinement.dictionary.newAriaLabel')}
                          placeholder={t('settings.voiceInput.refinement.dictionary.newPlaceholder')}
                          className={cn(
                            'mt-5 h-12 w-full rounded-[12px] px-4',
                            'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                            'text-15 text-[var(--settings-input-text)] outline-none transition-colors',
                            'placeholder:text-[var(--settings-section-sublabel)] placeholder:opacity-60',
                            'hover:border-[var(--settings-input-border-focus)]',
                            'focus-visible:border-[var(--settings-input-border-focus)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                          )}
                        />
                        <input
                          ref={dictionaryCsvInputRef}
                          type="file"
                          accept=".csv,text/csv"
                          className="sr-only"
                          tabIndex={-1}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0] ?? null;
                            event.currentTarget.value = '';
                            void importDictionaryCsvFile(file);
                          }}
                        />
                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                          <Tip text={t('settings.voiceInput.refinement.dictionary.csvImport.tooltip')} side="top">
                            <button
                              type="button"
                              onClick={() => dictionaryCsvInputRef.current?.click()}
                              className={cn(
                                'flex h-9 items-center gap-2 rounded-full px-3 text-13 font-medium transition-colors',
                                'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                              )}
                            >
                              <Upload size={15} />
                              {t('settings.voiceInput.refinement.dictionary.csvImport.label')}
                            </button>
                          </Tip>
                          <div className="flex items-center gap-2">
                            <Dialog.Close asChild>
                              <button
                                type="button"
                                className={cn(
                                  'h-9 rounded-full px-4 text-13 font-medium transition-colors',
                                  'border border-[var(--settings-btn-secondary-border)]',
                                  'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                                  'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                                )}
                              >
                                {t('settings.voiceInput.refinement.dictionary.cancel')}
                              </button>
                            </Dialog.Close>
                            <button
                              type="button"
                              onClick={addDictionaryEntry}
                              disabled={normalizeVoiceInputDictionaryEntryText(newDictionaryEntryText).length === 0}
                              className={cn(
                                'h-9 rounded-full px-4 text-13 font-medium transition-opacity',
                                'bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)]',
                                'hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45',
                              )}
                            >
                              {t('settings.voiceInput.refinement.dictionary.addDialog.submit')}
                            </button>
                          </div>
                        </div>
                      </Dialog.Content>
                    </Dialog.Portal>
                  </Dialog.Root>

                  {filteredDictionaryEntries.length > 0 ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {filteredDictionaryEntries.map((entry) => {
                        const editing = editingDictionaryEntryId === entry.id;
                        return (
                          <div
                            key={entry.id}
                            className={cn(
                              'group min-w-0 rounded-[12px] border border-[var(--settings-input-border)]',
                              'bg-[var(--settings-input-bg)] px-3 py-2.5 transition-colors',
                              'hover:bg-[var(--settings-menu-bg-hover)]',
                            )}
                          >
                            {editing ? (
                              <div className="flex min-w-0 items-center gap-1.5">
                                <input
                                  ref={editingDictionaryEntryInputRef}
                                  value={editingDictionaryEntryText}
                                  onChange={(event) => setEditingDictionaryEntryText(event.currentTarget.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                      event.preventDefault();
                                      saveEditingDictionaryEntry();
                                    }
                                    if (event.key === 'Escape') {
                                      cancelEditingDictionaryEntry();
                                    }
                                  }}
                                  aria-label={t('settings.voiceInput.refinement.dictionary.editAriaLabel')}
                                  className="h-8 min-w-0 flex-1 bg-transparent text-13 text-[var(--settings-input-text)] outline-none"
                                />
                                <Tip text={t('settings.voiceInput.refinement.dictionary.save')} side="top">
                                  <button
                                    type="button"
                                    onClick={saveEditingDictionaryEntry}
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--settings-section-title)] text-[var(--settings-theme-card-bg)] transition-opacity hover:opacity-85"
                                    aria-label={t('settings.voiceInput.refinement.dictionary.save')}
                                  >
                                    <Check size={14} />
                                  </button>
                                </Tip>
                                <Tip text={t('settings.voiceInput.refinement.dictionary.cancel')} side="top">
                                  <button
                                    type="button"
                                    onClick={cancelEditingDictionaryEntry}
                                    className={cn(
                                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
                                      'border border-[var(--settings-btn-secondary-border)]',
                                      'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                                      'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                                    )}
                                    aria-label={t('settings.voiceInput.refinement.dictionary.cancel')}
                                  >
                                    <X size={14} />
                                  </button>
                                </Tip>
                              </div>
                            ) : (
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  role="img"
                                  className={cn(
                                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                                    entry.source === 'automatic'
                                      ? 'text-[var(--settings-section-title)] opacity-70'
                                      : 'text-[var(--settings-section-sublabel)] opacity-45',
                                  )}
                                  aria-label={t(`settings.voiceInput.refinement.dictionary.sources.${entry.source}`)}
                                  title={t(`settings.voiceInput.refinement.dictionary.sources.${entry.source}`)}
                                >
                                  {dictionarySourceIcon(entry.source)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--settings-section-title)]">
                                  {entry.text}
                                </span>
                                <div
                                  className={cn(
                                    'flex shrink-0 items-center gap-1 opacity-0 transition-opacity',
                                    'group-hover:opacity-100 group-focus-within:opacity-100',
                                  )}
                                >
                                  <Tip text={t('settings.voiceInput.refinement.dictionary.edit')} side="top">
                                    <button
                                      type="button"
                                      onClick={() => startEditingDictionaryEntry(entry)}
                                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)] hover:text-[var(--settings-section-title)]"
                                      aria-label={t('settings.voiceInput.refinement.dictionary.edit')}
                                    >
                                      <Pencil size={13} />
                                    </button>
                                  </Tip>
                                  <Tip text={t('settings.voiceInput.refinement.dictionary.delete')} side="top">
                                    <button
                                      type="button"
                                      onClick={() => deleteDictionaryEntry(entry.id)}
                                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)] hover:text-[var(--settings-section-title)]"
                                      aria-label={t('settings.voiceInput.refinement.dictionary.delete')}
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </Tip>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-[12px] border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4 py-3 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                      {t(
                        dictionaryFilter === 'automatic'
                          ? 'settings.voiceInput.refinement.dictionary.emptyAutomatic'
                          : dictionaryFilter === 'manual'
                            ? 'settings.voiceInput.refinement.dictionary.emptyManual'
                            : 'settings.voiceInput.refinement.dictionary.emptyAll',
                      )}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </VoiceInputCard>

      <VoiceInputCard title={t('settings.voiceInput.sections.preferences')}>
        {supportsSystemAudioMuteSetting ? (
          <div className="flex items-center justify-between gap-5">
            <div className="flex min-w-0 flex-col gap-1">
              <p
                className="text-13 font-medium text-[var(--settings-section-title)]"
                style={{ letterSpacing: '0.12px' }}
              >
                {t('settings.voiceInput.muteSystemAudio.label')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.voiceInput.muteSystemAudio.hint')}
              </p>
            </div>

            <Switch
              checked={settings.muteSystemAudio}
              onCheckedChange={setMuteSystemAudio}
              aria-label={t('settings.voiceInput.muteSystemAudio.ariaLabel')}
            />
          </div>
        ) : (
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.voiceInput.muteSystemAudio.linuxUnsupported')}
          </p>
        )}

        <div className={cn(
          'flex items-center justify-between gap-5 pt-4',
          supportsSystemAudioMuteSetting && 'border-t border-[var(--settings-theme-card-border)]',
        )}>
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-title)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.voiceInput.fastActivation.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.fastActivation.hint')}
            </p>
          </div>

          <Switch
            checked={settings.fastActivationEnabled}
            onCheckedChange={setFastActivationEnabled}
            aria-label={t('settings.voiceInput.fastActivation.ariaLabel')}
          />
        </div>

        <div className="flex items-center justify-between gap-5 border-t border-[var(--settings-theme-card-border)] pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-title)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.voiceInput.interactionSound.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.interactionSound.hint')}
            </p>
          </div>

          <Switch
            checked={settings.playInteractionSound}
            onCheckedChange={setPlayInteractionSound}
            aria-label={t('settings.voiceInput.interactionSound.ariaLabel')}
          />
        </div>
      </VoiceInputCard>

      <VoiceInputCard
        title={t('settings.voiceInput.sections.usageData')}
        action={
          <button
            type="button"
            disabled={!canResetUsageStats}
            onClick={resetUsageStats}
            className={cn(
              'h-8 shrink-0 rounded-full px-3 text-12 font-medium transition-colors',
              'border border-[var(--settings-btn-secondary-border)]',
              'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
              'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
              'disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            {t('settings.voiceInput.usage.reset')}
          </button>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-12 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.usage.duration')}
            </dt>
            <dd className="mt-1 truncate text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
              {formatAudioDuration(stats.totalAudioMs)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-12 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.usage.estimatedCost')}
            </dt>
            <dd className="mt-1 truncate text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
              {formatUsd(cost.totalUsd)}
            </dd>
            <dd className="mt-1 truncate text-11 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.usage.costBreakdown', {
                asr: formatUsd(cost.asrUsd),
                refine: formatUsd(cost.refineUsd),
              })}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-12 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.usage.sessions')}
            </dt>
            <dd className="mt-1 truncate text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
              {stats.sessionCount}
            </dd>
            <dd className="mt-1 text-11 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.voiceInput.usage.outcomes', {
                noSpeech: stats.noSpeechSessionCount,
                failed: stats.failedSessionCount,
              })}
            </dd>
          </div>
        </dl>

        <div className="border-t border-[var(--settings-theme-card-border)] pt-4">
          <button
            type="button"
            onClick={() => setHistoryExpanded((prev) => !prev)}
            aria-expanded={historyExpanded}
            aria-controls="voice-input-history-panel"
            title={t(
              historyExpanded
                ? 'settings.voiceInput.historyToggle.hide'
                : 'settings.voiceInput.historyToggle.show',
            )}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-[10px] py-1 text-left',
              'transition-colors hover:opacity-90',
            )}
          >
            <span
              className="text-13 font-medium text-[var(--settings-section-title)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.voiceInput.history.label')}
              <span className="ml-2 text-12 font-normal text-[var(--settings-section-sublabel)] opacity-70">
                ({historyEntries.length})
              </span>
            </span>
            <ChevronDown
              size={16}
              className={cn(
                'shrink-0 text-[var(--settings-section-sublabel)] transition-transform',
                historyExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>

          {historyExpanded ? (
            <div id="voice-input-history-panel" className="mt-3">
              {historyEntries.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {historyEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className={cn(
                        'flex items-start gap-3 rounded-[12px] p-3',
                        'border border-[var(--settings-theme-card-border)]',
                        'bg-[var(--settings-input-bg)]',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="max-h-[92px] overflow-y-auto whitespace-pre-wrap break-words text-13 leading-[1.45] text-[var(--settings-section-title)]">
                          {entry.text}
                        </p>
                        <p className="mt-1 text-11 leading-[1.3] text-[var(--settings-section-sublabel)] opacity-60">
                          {formatHistoryTime(entry.createdAt, i18n.resolvedLanguage ?? i18n.language)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <Tip text={t('settings.voiceInput.history.copy')} side="top">
                          <button
                            type="button"
                            onClick={() => {
                              void handleCopyHistoryEntry(entry.text);
                            }}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-full',
                              'border border-[var(--settings-btn-secondary-border)]',
                              'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                              'transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                            )}
                            aria-label={t('settings.voiceInput.history.copyAria')}
                          >
                            <Copy size={13} />
                          </button>
                        </Tip>
                        <Tip text={t('settings.voiceInput.history.delete')} side="top">
                          <button
                            type="button"
                            onClick={() => deleteHistoryEntry(entry.id)}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-full',
                              'border border-[var(--settings-btn-secondary-border)]',
                              'bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                              'transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                            )}
                            aria-label={t('settings.voiceInput.history.deleteAria')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </Tip>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-[12px] border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] px-4 py-3 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                  {t('settings.voiceInput.history.empty')}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </VoiceInputCard>
    </div>
  );
}
