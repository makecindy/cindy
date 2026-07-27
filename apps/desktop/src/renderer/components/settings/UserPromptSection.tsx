import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useUserPrompt } from '@/hooks/useUserPrompt';
import { USER_PROMPT_MAX_LENGTH } from '@/lib/userPrompt.constants';
import { toast } from '@/lib/toast';

export function UserPromptSection() {
  const { value, setValue } = useUserPrompt();
  const { t } = useTranslation();

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
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.personalization.title')}
      </h2>

      <div
        className={cn(
          'flex flex-col gap-[14px] rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.personalization.subtitle')}
          </p>
          <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.personalization.description')}
          </p>
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('settings.personalization.placeholder')}
          aria-label={t('settings.personalization.ariaLabel')}
          rows={7}
          className={cn(
            'min-h-[160px] w-full resize-y rounded-xl',
            'p-4',
            'bg-[var(--settings-input-bg)]',
            'border border-[var(--settings-input-border)]',
            'text-13 leading-[1.6] text-[var(--settings-input-text)]',
            'placeholder:font-normal placeholder:text-[var(--settings-input-placeholder)] placeholder:opacity-45',
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

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-full px-[18px]',
              'bg-[var(--settings-btn-primary-bg)]',
              'border border-[var(--settings-btn-primary-border)]',
              'text-13 font-medium text-[var(--settings-btn-primary-text)]',
              'hover:bg-[var(--settings-btn-primary-hover-bg)]',
              'transition-colors',
              !canSave && 'cursor-not-allowed opacity-40',
            )}
          >
            {t('settings.personalization.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
