import { Camera } from 'lucide-react';
import type { ReactNode } from 'react';

import { Input, Textarea } from '@/components/ui/input';
import { useBotTranslation } from './botPronounContext';
import { BotAvatar } from './BotAvatar';

export interface BotBasicProfileValue {
  name: string;
  description: string;
  avatar: string;
  avatarColor: string;
}

export function BotBasicProfileFields({
  value,
  onChange,
  onChooseAvatar,
  avatarBusy = false,
  autoFocusName = false,
  avatarPreview,
  centeredAvatar = false,
  avatarControl,
  composition,
  onNameBlur,
  onDescriptionBlur,
}: {
  avatarControl?: ReactNode;
  /** IME composition handlers shared by both text fields (see useBotSettingsAutosave). */
  composition?: { onCompositionStart: () => void; onCompositionEnd: () => void };
  onNameBlur?: () => void;
  onDescriptionBlur?: () => void;
  centeredAvatar?: boolean;
  value: BotBasicProfileValue;
  onChange: (next: BotBasicProfileValue, kind: 'text' | 'instant') => void;
  onChooseAvatar?: () => void;
  avatarBusy?: boolean;
  autoFocusName?: boolean;
  /** Unsaved local selection; never persisted as an avatar address. */
  avatarPreview?: string;
}) {
  const { t } = useBotTranslation();
  const update = <K extends keyof BotBasicProfileValue>(
    key: K,
    nextValue: BotBasicProfileValue[K],
    kind: 'text' | 'instant',
  ) => onChange({ ...value, [key]: nextValue }, kind);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className={centeredAvatar ? 'flex flex-col items-center gap-5' : 'flex items-end gap-4'}>
        <div className="shrink-0 pb-0.5">
          {avatarControl ??
            (onChooseAvatar ? (
              <button
                type="button"
                disabled={avatarBusy}
                onClick={onChooseAvatar}
                aria-label={t('bots.profile.changeAvatar')}
                className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait"
              >
                {avatarPreview ? (
                  <img src={avatarPreview} alt="" className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <BotAvatar bot={value} size={centeredAvatar ? 'xl' : 'lg'} />
                )}
                <span className="absolute flex items-center justify-center rounded-full bg-[var(--surface-elevated)] text-[var(--text-secondary)] border border-[var(--border-default)] -bottom-1 -right-1 h-6 w-6">
                  <Camera size={12} aria-hidden="true" />
                </span>
              </button>
            ) : (
              <BotAvatar bot={value} size="xl" />
            ))}
        </div>

        <label className="flex w-full min-w-0 flex-1 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
          {t('bots.nameLabel')}
          <Input
            autoFocus={autoFocusName}
            ariaLabel={t('bots.nameLabel')}
            value={value.name}
            onChange={(next) => update('name', next, 'text')}
            onBlur={onNameBlur}
            {...composition}
            placeholder={t('bots.roster.customNamePlaceholder')}
            className="min-w-0"
            required
          />
        </label>
      </div>

      <label className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
        {t('bots.profile.summary')}
        <Textarea
          aria-label={t('bots.profile.summary')}
          value={value.description}
          onChange={(next) => update('description', next, 'text')}
          onBlur={onDescriptionBlur}
          {...composition}
          placeholder={t('bots.profile.summaryPlaceholder')}
          rows={3}
          className="min-h-24 min-w-0 resize-none py-2.5 text-14 leading-6 [field-sizing:content]"
        />
      </label>
    </div>
  );
}
