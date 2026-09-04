import { Camera } from 'lucide-react';

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
}: {
  value: BotBasicProfileValue;
  onChange: (next: BotBasicProfileValue, kind: 'text' | 'instant') => void;
  onChooseAvatar?: () => void;
  avatarBusy?: boolean;
  autoFocusName?: boolean;
}) {
  const { t } = useBotTranslation();
  const update = <K extends keyof BotBasicProfileValue>(
    key: K,
    nextValue: BotBasicProfileValue[K],
    kind: 'text' | 'instant',
  ) => onChange({ ...value, [key]: nextValue }, kind);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex justify-center">
        {onChooseAvatar ? (
          <button
            type="button"
            disabled={avatarBusy}
            onClick={onChooseAvatar}
            aria-label={t('bots.profile.changeAvatar')}
            className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait"
          >
            <BotAvatar bot={value} size="xl" />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--overlay-modal)] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Camera size={18} aria-hidden="true" />
            </span>
          </button>
        ) : (
          <BotAvatar bot={value} size="xl" />
        )}
      </div>

      <label className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
        {t('bots.nameLabel')}
        <input
          autoFocus={autoFocusName}
          aria-label={t('bots.nameLabel')}
          value={value.name}
          onChange={(event) => update('name', event.target.value, 'text')}
          placeholder={t('bots.roster.customNamePlaceholder')}
          className="h-10 min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
          required
        />
      </label>

      <label className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
        {t('bots.profile.summary')}
        <textarea
          aria-label={t('bots.profile.summary')}
          value={value.description}
          onChange={(event) => update('description', event.target.value, 'text')}
          placeholder={t('bots.profile.summaryPlaceholder')}
          rows={4}
          className="min-h-28 min-w-0 resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5 text-14 leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
        />
      </label>
    </div>
  );
}
