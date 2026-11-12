import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsField } from '@/components/ui/settings-rows';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useUserPrompt } from '@/hooks/useUserPrompt';
import { USER_PROMPT_MAX_LENGTH } from '@/lib/userPrompt.constants';
import { toast } from '@/lib/toast';

export function UserPromptSection() {
  const { value, setValue } = useUserPrompt();
  const { t } = useTranslation();
  const setting = useSettingDefinition(personalizationDetailsSettings.userInstructions);

  const [draft, setDraft] = useState(value);

  // 外部 storage 变化（其他 window 实例 setValue 触发的 storage event）时刷新草稿。
  // 单 Electron 窗口里几乎不会触发，留作兜底。
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const length = draft.length;
  const overLimit = length > USER_PROMPT_MAX_LENGTH;
  const dirty = draft !== value;
  const canSave = dirty && !overLimit;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    setValue(draft);
    toast.success(t('settings.personalization.toast.saved'));
  }, [canSave, draft, setValue, t]);

  const counter = useMemo(
    () => `${length.toLocaleString()} / ${USER_PROMPT_MAX_LENGTH.toLocaleString()}`,
    [length],
  );

  return (
    <SettingsCard>
      {/* 名称/说明在输入框上方, 与输入框同属一项 */}
      <SettingsField title={setting.title} hint={setting.description}>
        <textarea {...setting.anchorProps} {...setting.controlProps}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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

          <Button {...setting.controlProps}
            variant="cta"
            size="md"
            compact
            type="button"
            onClick={handleSave}
            disabled={!canSave}
          >
            {t('settings.personalization.save')}
          </Button>
        </div>
      </SettingsField>
    </SettingsCard>
  );
}
