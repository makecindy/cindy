import { MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { SettingsSegmentedControl } from '@/components/settings/SettingsSegmentedControl';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import {
  BOT_STYLE_EMOJI_DENSITIES,
  BOT_STYLE_LIMITS,
  BOT_STYLE_REPLY_LENGTHS,
  BOT_STYLE_TONES,
  normalizeBotStyle,
  type BotCommunicationStyle,
  type BotStyleEmojiDensity,
  type BotStyleReplyLength,
  type BotStyleTone,
} from '../../../shared/botStyle';
import { BotSettingsBlock } from './BotSettingsBlock';
import { useBotTranslation } from './botPronounContext';

const FOLLOW_DEFAULT = 'default' as const;

type ToneControl = BotStyleTone | typeof FOLLOW_DEFAULT;
type ReplyLengthControl = BotStyleReplyLength | typeof FOLLOW_DEFAULT;
type EmojiDensityControl = BotStyleEmojiDensity | typeof FOLLOW_DEFAULT;

function StyleRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <p className="text-13 font-medium text-[var(--text-primary)]">{label}</p>
      </div>
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </div>
  );
}

export function BotCommunicationStyleFields({
  value,
  onChange,
}: {
  value: BotCommunicationStyle | undefined;
  onChange: (next: BotCommunicationStyle | undefined, kind: 'text' | 'instant') => void;
}) {
  const { t } = useBotTranslation();
  // 草稿保持原文:normalizeBotStyle 会 trim,打字时空格/换行不能在 onChange 里吃掉。
  const style = value ?? {};
  const hasOverride = Object.keys(style).some((key) => {
    const field = style[key as keyof BotCommunicationStyle];
    return field != null && field !== '';
  });
  const patch = (next: BotCommunicationStyle, kind: 'text' | 'instant') => {
    onChange(kind === 'instant' ? (normalizeBotStyle(next) ?? undefined) : next, kind);
  };
  const commitTrimmed = (next: BotCommunicationStyle = style) => {
    onChange(normalizeBotStyle(next), 'text');
  };
  const restoreDefault = () => {
    if (!hasOverride) return;
    // Empty object / undefined both normalize to unset; autosave sends style: null.
    onChange(undefined, 'instant');
  };

  return (
    <BotSettingsBlock
      icon={MessageCircle}
      title={t('bots.profile.style.title')}
      hint={t('bots.profile.style.hint')}
      testId="bot-communication-style"
      action={
        <button
          type="button"
          disabled={!hasOverride}
          onClick={restoreDefault}
          className="h-8 rounded-full px-3 text-12 text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40"
        >
          {t('bots.profile.style.restoreDefault')}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('bots.profile.style.tone')} hint={t('bots.profile.style.toneHint')}>
          {(control) => (
            <div className="min-w-0 overflow-x-auto">
              <SettingsSegmentedControl<ToneControl>
                id={control.id}
                aria-label={t('bots.profile.style.tone')}
                aria-describedby={control['aria-describedby']}
                value={style.tone ?? FOLLOW_DEFAULT}
                onValueChange={(tone) => {
                  if (tone === FOLLOW_DEFAULT) {
                    const next = { ...style };
                    delete next.tone;
                    delete next.customTone;
                    patch(next, 'instant');
                    return;
                  }
                  patch({ ...style, tone }, 'instant');
                }}
                options={[
                  { value: FOLLOW_DEFAULT, label: t('bots.profile.style.tones.followDefault') },
                  ...BOT_STYLE_TONES.map((tone) => ({
                    value: tone,
                    label: t(`bots.profile.style.tones.${tone}`),
                  })),
                ]}
              />
            </div>
          )}
        </FormField>
        {style.tone === 'custom' ? (
          <FormField label={t('bots.profile.style.customTone')}>
            {(control) => (
              <Textarea
                {...control}
                aria-label={t('bots.profile.style.customTone')}
                value={style.customTone ?? ''}
                maxLength={BOT_STYLE_LIMITS.customTone}
                rows={3}
                onChange={(text) => patch({ ...style, customTone: text }, 'text')}
                onBlur={(event) => commitTrimmed({ ...style, customTone: event.currentTarget.value })}
              />
            )}
          </FormField>
        ) : null}

        <FormField label={t('bots.profile.style.addressUserAs')}>
          {(control) => (
            <SettingsTextInput
              {...control}
              ariaLabel={t('bots.profile.style.addressUserAs')}
              value={style.addressUserAs ?? ''}
              maxLength={BOT_STYLE_LIMITS.addressUserAs}
              size="lg"
              className="w-full"
              onChange={(text) => patch({ ...style, addressUserAs: text }, 'text')}
              onBlur={(event) => commitTrimmed({ ...style, addressUserAs: event.currentTarget.value })}
            />
          )}
        </FormField>
        <FormField label={t('bots.profile.style.selfName')}>
          {(control) => (
            <SettingsTextInput
              {...control}
              ariaLabel={t('bots.profile.style.selfName')}
              value={style.selfName ?? ''}
              maxLength={BOT_STYLE_LIMITS.selfName}
              size="lg"
              className="w-full"
              onChange={(text) => patch({ ...style, selfName: text }, 'text')}
              onBlur={(event) => commitTrimmed({ ...style, selfName: event.currentTarget.value })}
            />
          )}
        </FormField>

        <StyleRow label={t('bots.profile.style.replyLength')}>
          <SettingsSegmentedControl<ReplyLengthControl>
            aria-label={t('bots.profile.style.replyLength')}
            value={style.replyLength ?? FOLLOW_DEFAULT}
            onValueChange={(replyLength) => {
              if (replyLength === FOLLOW_DEFAULT) {
                const next = { ...style };
                delete next.replyLength;
                patch(next, 'instant');
                return;
              }
              patch({ ...style, replyLength }, 'instant');
            }}
            options={[
              { value: FOLLOW_DEFAULT, label: t('bots.profile.style.replyLengths.followDefault') },
              ...BOT_STYLE_REPLY_LENGTHS.map((item) => ({
                value: item,
                label: t(`bots.profile.style.replyLengths.${item}`),
              })),
            ]}
          />
        </StyleRow>
        <StyleRow label={t('bots.profile.style.emojiDensity')}>
          <SettingsSegmentedControl<EmojiDensityControl>
            aria-label={t('bots.profile.style.emojiDensity')}
            value={style.emojiDensity ?? FOLLOW_DEFAULT}
            onValueChange={(emojiDensity) => {
              if (emojiDensity === FOLLOW_DEFAULT) {
                const next = { ...style };
                delete next.emojiDensity;
                patch(next, 'instant');
                return;
              }
              patch({ ...style, emojiDensity }, 'instant');
            }}
            options={[
              { value: FOLLOW_DEFAULT, label: t('bots.profile.style.emojiDensities.followDefault') },
              ...BOT_STYLE_EMOJI_DENSITIES.map((item) => ({
                value: item,
                label: t(`bots.profile.style.emojiDensities.${item}`),
              })),
            ]}
          />
        </StyleRow>

        <FormField
          label={t('bots.profile.style.bannedPhrases')}
          hint={t('bots.profile.style.bannedPhrasesHint')}
        >
          {(control) => (
            <Textarea
              {...control}
              aria-label={t('bots.profile.style.bannedPhrases')}
              value={style.bannedPhrases ?? ''}
              maxLength={BOT_STYLE_LIMITS.bannedPhrases}
              rows={3}
              onChange={(text) => patch({ ...style, bannedPhrases: text }, 'text')}
              onBlur={(event) => commitTrimmed({ ...style, bannedPhrases: event.currentTarget.value })}
            />
          )}
        </FormField>
        <FormField label={t('bots.profile.style.languageHabits')}>
          {(control) => (
            <Textarea
              {...control}
              aria-label={t('bots.profile.style.languageHabits')}
              value={style.languageHabits ?? ''}
              maxLength={BOT_STYLE_LIMITS.languageHabits}
              rows={4}
              onChange={(text) => patch({ ...style, languageHabits: text }, 'text')}
              onBlur={(event) => commitTrimmed({ ...style, languageHabits: event.currentTarget.value })}
            />
          )}
        </FormField>
      </div>
    </BotSettingsBlock>
  );
}
