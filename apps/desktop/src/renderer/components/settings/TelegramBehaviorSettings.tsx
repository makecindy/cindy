/**
 * Telegram 个人 bot「回应与引用」设置节(设计 v3 §五点四/五点五)。
 *
 * 三组分段选择: emoji 回应等级 / 群回复引用 / DM 回复引用。
 * 改动即写 main 侧 store(transport 每次使用现读), 无需重启 bot。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type Behavior = TelegramBotBehavior;

const EMOJI_OPTIONS: Behavior['emojiReactions'][] = ['off', 'minimal', 'expressive'];
const GROUP_QUOTE_OPTIONS: Behavior['replyQuoteGroup'][] = ['off', 'first', 'all'];
const DM_QUOTE_OPTIONS: Behavior['replyQuoteDm'][] = ['off', 'first'];

function SegmentedRow<T extends string>(props: {
  label: string;
  hint: string;
  options: readonly T[];
  value: T;
  optionLabel: (option: T) => string;
  onChange: (option: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-12 font-medium text-[var(--settings-section-desc)]" style={{ letterSpacing: '0.12px' }}>
        {props.label}
      </div>
      <div className="flex gap-1.5">
        {props.options.map((option) => {
          const active = option === props.value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => props.onChange(option)}
              aria-pressed={active}
              className={cn(
                'h-[30px] flex-1 rounded-full border text-12 font-medium transition-colors',
                active
                  ? 'border-[var(--settings-input-border-focus)] bg-[var(--settings-badge-bg)] text-[var(--settings-section-title)]'
                  : 'border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
              )}
            >
              {props.optionLabel(option)}
            </button>
          );
        })}
      </div>
      <div className="text-11 leading-[1.5] text-[var(--settings-section-desc)] opacity-80">
        {props.hint}
      </div>
    </div>
  );
}

export function TelegramBehaviorSettings() {
  const { t } = useTranslation();
  const [behavior, setBehavior] = useState<Behavior | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.telegramBot.getBehavior().then((value) => {
      if (!cancelled) setBehavior(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!behavior) return null;

  const patch = (partial: Partial<Behavior>) => {
    // 乐观更新; main 侧 store 白名单校验后回真值。
    setBehavior({ ...behavior, ...partial });
    void window.electronAPI.telegramBot.setBehavior(partial).then(setBehavior);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-13 font-medium text-[var(--settings-section-title)]">
        {t('settings.telegramBot.behavior.title')}
      </div>
      <SegmentedRow
        label={t('settings.telegramBot.behavior.emojiLabel')}
        hint={t(`settings.telegramBot.behavior.emojiHint.${behavior.emojiReactions}`)}
        options={EMOJI_OPTIONS}
        value={behavior.emojiReactions}
        optionLabel={(o) => t(`settings.telegramBot.behavior.emojiOption.${o}`)}
        onChange={(emojiReactions) => patch({ emojiReactions })}
      />
      <SegmentedRow
        label={t('settings.telegramBot.behavior.groupQuoteLabel')}
        hint={t(`settings.telegramBot.behavior.groupQuoteHint.${behavior.replyQuoteGroup}`)}
        options={GROUP_QUOTE_OPTIONS}
        value={behavior.replyQuoteGroup}
        optionLabel={(o) => t(`settings.telegramBot.behavior.quoteOption.${o}`)}
        onChange={(replyQuoteGroup) => patch({ replyQuoteGroup })}
      />
      <SegmentedRow
        label={t('settings.telegramBot.behavior.dmQuoteLabel')}
        hint={t(`settings.telegramBot.behavior.dmQuoteHint.${behavior.replyQuoteDm}`)}
        options={DM_QUOTE_OPTIONS}
        value={behavior.replyQuoteDm}
        optionLabel={(o) => t(`settings.telegramBot.behavior.quoteOption.${o}`)}
        onChange={(replyQuoteDm) => patch({ replyQuoteDm })}
      />
    </div>
  );
}
