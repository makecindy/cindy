import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsField, SettingsPageHeader, SettingsSection } from '@/components/ui/settings-rows';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useUserPrompt } from '@/hooks/useUserPrompt';
import { USER_PROMPT_MAX_LENGTH } from '@/lib/userPrompt.constants';
import { toast } from '@/lib/toast';
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';
import appI18n from 'i18next';

export function UserPromptSection() {
  const { value, setValue } = useUserPrompt();
  // 存在 localStorage：随时可写、同步保存，外部值变化即刷新草稿。
  return (
    <UserPromptEditor
      value={value}
      ready
      unavailable={false}
      customized={value !== ''}
      revision="local"
      ownerKey={`local:${value}`}
      setValue={setValue}
    />
  );
}

/** Personalization page title; the cloud surface shows it alone when the prompt is not reported. */
export function PersonalizationPageTitle() {
  const { t } = useTranslation();
  return <SettingsPageHeader title={t('settings.personalization.title')} />;
}

/** The personalization page as the settings page frames it; another computer's page wraps its editor in it. */
export function PersonalizationPage({
  children,
  headingStatus,
}: {
  children: ReactNode;
  /** Cloud settings: the prompt could not be read; this says so in the page heading. */
  headingStatus?: ReactNode;
}) {
  const { t } = useTranslation();
  return <SettingsSection variant="page" title={t('settings.personalization.title')} action={headingStatus}>{children}</SettingsSection>;
}

export interface UserPromptEditorProps {
  value: string;
  ready: boolean;
  unavailable: boolean;
  customized: boolean;
  revision: string | null;
  ownerKey: string;
  setValue(value: string, revision: string): Promise<void> | void;
  /** Host 正本才有「跟随默认」;本机 localStorage 只有保存。 */
  resetValue?(revision: string): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
}

/** Shared native control; the cloud surface supplies its own scoped adapter. */
export function UserPromptEditor({
  value,
  ready,
  unavailable,
  customized,
  revision,
  ownerKey,
  setValue,
  resetValue,
  onDirtyChange,
}: UserPromptEditorProps) {
  const { t } = useTranslation();
  const setting = useSettingDefinition(personalizationDetailsSettings.userInstructions);

  const [draft, setDraft] = useState({ value, revision, ownerKey });
  const previousValue = useRef(value);
  const [saving, setSaving] = useState(false);
  const [stoppingVoice, setStoppingVoice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const savingRef = useRef(false);

  // 同 owner 的外部修改不吞掉正在编辑的草稿；其旧 revision 会阻止覆盖。
  useEffect(() => {
    const previous = previousValue.current;
    previousValue.current = value;
    setDraft((current) =>
      current.ownerKey !== ownerKey || current.value === previous
        ? { value, revision, ownerKey }
        : current,
    );
  }, [value, revision, ownerKey]);

  const currentValue = draft.ownerKey === ownerKey ? draft.value : value;
  const voice = useFieldVoiceInput({
    draftKey: `user-prompt:${ownerKey}`,
    inputRef: textareaRef,
    value: currentValue,
    onChange: (next) =>
      setDraft((current) => ({
        value: next,
        revision: current.value === value ? revision : current.revision,
        ownerKey,
      })),
    disabled: !ready || saving,
  });

  const length = voice.displayText.length;
  const overLimit = length > USER_PROMPT_MAX_LENGTH;
  const dirty = voice.displayText !== value;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const conflicted = dirty && draft.revision !== revision;
  const busy = saving || stoppingVoice;
  const canSave = ready && dirty && !overLimit && !busy && !conflicted;

  const handleSave = useCallback(async () => {
    if (!canSave || !draft.revision || savingRef.current) return;
    savingRef.current = true;
    let finalValue = currentValue;
    if (voice.isBusy) {
      setStoppingVoice(true);
      try {
        const stoppedValue = await voice.stop();
        if (stoppedValue === null) {
          savingRef.current = false;
          return;
        }
        finalValue = stoppedValue;
      } finally {
        setStoppingVoice(false);
      }
      if (finalValue.length > USER_PROMPT_MAX_LENGTH || finalValue === value) {
        savingRef.current = false;
        return;
      }
    }
    setSaving(true);
    try {
      await setValue(finalValue, draft.revision);
      toast.success(t('settings.personalization.toast.saved'));
    } catch {
      toast.error(t('hostSettings.saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [canSave, currentValue, draft.revision, setValue, t, value, voice.isBusy, voice.stop]);

  const handleReset = useCallback(async () => {
    if (!resetValue || !ready || !revision || busy) return;
    if (voice.isBusy) void voice.cancel();
    setSaving(true);
    try {
      await resetValue(revision);
      setDraft({ value: '', revision: null, ownerKey });
      toast.success(t('settings.personalization.toast.saved'));
    } catch {
      toast.error(t('hostSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [ready, revision, busy, resetValue, ownerKey, t, voice.cancel, voice.isBusy]);

  const counter = `${length.toLocaleString(appI18n.language)} / ${USER_PROMPT_MAX_LENGTH.toLocaleString(appI18n.language)}`;

  return (
    <SettingsCard>
      {/* 名称/说明在输入框上方, 与输入框同属一项 */}
      <SettingsField title={setting.title} hint={setting.description}>
        <div
          className={cn(
            'flex flex-col rounded-lg',
            'bg-[var(--settings-input-bg)]',
            'border border-[var(--settings-input-border)]',
            'focus-within:border-[var(--settings-input-border-focus)]',
            'transition-colors',
          )}
        >
          <textarea {...setting.anchorProps} {...setting.controlProps}
            ref={textareaRef}
            value={voice.displayText}
            readOnly={voice.isBusy}
            disabled={!ready || saving}
            onChange={(e) =>
              setDraft((current) => ({
                value: e.target.value,
                revision: current.value === value ? revision : current.revision,
                ownerKey,
              }))
            }
            placeholder={t('settings.personalization.placeholder')}
            aria-label={t('settings.personalization.ariaLabel')}
            rows={6}
            className={cn(
              'min-h-[132px] w-full resize-y bg-transparent',
              'px-4 pt-3.5 pb-1',
              'text-13 leading-[1.6] text-[var(--settings-input-text)]',
              'placeholder:font-normal placeholder:text-[var(--settings-input-placeholder)]',
              'outline-none',
            )}
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          />
          <div className="flex items-center justify-end px-2.5 pb-2.5 pt-1">
            <VoiceInputButton {...voice.buttonProps} testId="user-prompt-voice" tipSide="top" />
          </div>
        </div>
        <FieldVoiceInputNotice error={voice.lastError} speakerFiltered={voice.speakerFiltered} />

        {(unavailable || conflicted) && (
          <p role="status" className="text-13 text-[var(--settings-section-desc)]">
            {t(unavailable ? 'hostSettings.loadFailed' : 'hostSettings.changed')}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              'text-12 tabular-nums',
              overLimit
                ? 'text-[var(--settings-error-text)]'
                : 'text-[var(--settings-source-meta)]',
            )}
            style={{ letterSpacing: '0.12px' }}
            aria-live="polite"
          >
            {counter}
            {overLimit ? t('settings.personalization.overLimit') : ''}
          </p>

          <div className="flex items-center gap-2">
            {resetValue && (
              <Button data-settings-search-action="Reset the custom instructions of the Host this page edits"
                variant="secondary"
                onClick={handleReset}
                disabled={!ready || !customized || busy || conflicted}
              >
                {t('hostSettings.reset')}
              </Button>
            )}
            <Button {...setting.controlProps}
              variant="cta"
              size="md"
              compact
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              loading={busy}
            >
              {t('settings.personalization.save')}
            </Button>
          </div>
        </div>
      </SettingsField>
    </SettingsCard>
  );
}
