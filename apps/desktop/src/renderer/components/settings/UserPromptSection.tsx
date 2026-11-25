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

  const length = draft.value.length;
  const overLimit = length > USER_PROMPT_MAX_LENGTH;
  const dirty = draft.value !== value;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const conflicted = dirty && draft.revision !== revision;
  const canSave = ready && dirty && !overLimit && !saving && !conflicted;

  const handleSave = useCallback(async () => {
    if (!canSave || !draft.revision) return;
    setSaving(true);
    try {
      await setValue(draft.value, draft.revision);
      toast.success(t('settings.personalization.toast.saved'));
    } catch {
      toast.error(t('hostSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [canSave, draft, setValue, t]);

  const handleReset = useCallback(async () => {
    if (!resetValue || !ready || !revision || saving) return;
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
  }, [ready, revision, saving, resetValue, ownerKey, t]);

  const counter = `${length.toLocaleString(appI18n.language)} / ${USER_PROMPT_MAX_LENGTH.toLocaleString(appI18n.language)}`;

  return (
    <SettingsCard>
      {/* 名称/说明在输入框上方, 与输入框同属一项 */}
      <SettingsField title={setting.title} hint={setting.description}>
        <textarea {...setting.anchorProps} {...setting.controlProps}
          value={draft.ownerKey === ownerKey ? draft.value : value}
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
          rows={7}
          className={cn(
            'min-h-[160px] w-full resize-y rounded-lg',
            'p-4',
            'bg-[var(--settings-input-bg)]',
            'border border-[var(--settings-input-border)]',
            'text-13 leading-[1.6] text-[var(--settings-input-text)]',
            'placeholder:font-normal placeholder:text-[var(--settings-input-placeholder)]',
            'outline-none focus:border-[var(--settings-input-border-focus)]',
            'transition-colors',
          )}
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        />

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
                disabled={!ready || !customized || saving || conflicted}
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
              loading={saving}
            >
              {t('settings.personalization.save')}
            </Button>
          </div>
        </div>
      </SettingsField>
    </SettingsCard>
  );
}
