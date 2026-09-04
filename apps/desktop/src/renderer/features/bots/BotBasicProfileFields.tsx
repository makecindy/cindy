import { useBotTranslation } from './botPronounContext';
import { BOT_AVATAR_HUES, BotAvatar, botAvatarHueToken, type BotAvatarHue } from './BotAvatar';
import { cn } from '@/lib/utils';

const AVATAR_GLYPHS = ['', '🧭', '🛠️', '✦', '🤖', '📡', '☄️'] as const;

export interface BotBasicProfileValue {
  name: string;
  description: string;
  avatar: string;
  avatarColor: string;
}

export function BotBasicProfileFields({
  value,
  onChange,
  autoFocusName = false,
}: {
  value: BotBasicProfileValue;
  onChange: (next: BotBasicProfileValue, kind: 'text' | 'instant') => void;
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
      <div className="flex min-w-0 items-start gap-4">
        <BotAvatar bot={value} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="text-12 text-[var(--text-secondary)]">{t('bots.profile.avatar')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {AVATAR_GLYPHS.map((glyph) => (
              <button
                key={glyph || 'initial'}
                type="button"
                onClick={() => update('avatar', glyph, 'instant')}
                className={cn(
                  'flex h-9 min-w-9 items-center justify-center rounded-lg border px-2 text-16 transition-colors',
                  value.avatar === glyph
                    ? 'border-[var(--accent-cta-bg)] bg-[var(--surface-hover)]'
                    : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                )}
                aria-label={
                  glyph ? t('bots.chooseAvatar', { avatar: glyph }) : t('bots.profile.useInitial')
                }
              >
                {glyph || t('bots.profile.initial')}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {BOT_AVATAR_HUES.map((hue) => (
              <button
                key={hue}
                type="button"
                onClick={() => update('avatarColor', hue, 'instant')}
                className={cn(
                  'h-6 w-6 rounded-full border border-[var(--border-default)]',
                  value.avatarColor === hue &&
                    'ring-2 ring-[var(--focus-ring)] ring-offset-2 ring-offset-[var(--surface-elevated)]',
                )}
                style={{ backgroundColor: botAvatarHueToken(hue as BotAvatarHue) }}
                aria-label={t('bots.chooseAvatarColor', { color: hue })}
              />
            ))}
          </div>
        </div>
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
        <input
          aria-label={t('bots.profile.summary')}
          value={value.description}
          onChange={(event) => update('description', event.target.value, 'text')}
          placeholder={t('bots.profile.summaryPlaceholder')}
          className="h-10 min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
        />
        <span className="text-11 leading-4 text-[var(--text-tertiary)]">
          {t('bots.profile.summaryHint')}
        </span>
      </label>
    </div>
  );
}
