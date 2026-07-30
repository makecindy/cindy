/**
 * Telegram 个人 bot「回应与引用」设置节(设计 v3 §五点四/五点五)。
 *
 * 三组分段选择: emoji 回应等级 / 群回复引用 / DM 回复引用。
 * 改动即写 main 侧 store(transport 每次使用现读), 无需重启 bot。
 */

import { useEffect, useRef, useState } from 'react';
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


/** 「人格」节: bot 名字 + soul 文本(soul.md 语义), 可一键同步名字到 Telegram 资料页。 */
export function TelegramPersonaSettings() {
  const { t } = useTranslation();
  const [persona, setPersona] = useState<{ botName: string; soul: string } | null>(null);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'failed'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.telegramBot.getPersona().then((value) => {
      if (!cancelled) setPersona(value);
    });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (!persona) return null;

  const save = (next: { botName: string; soul: string }) => {
    setPersona(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 600ms 去抖自动保存 — 无显式保存按钮(设置卡即改即存的通用手感)。
    saveTimer.current = setTimeout(() => {
      void window.electronAPI.telegramBot.setPersona({ botName: next.botName, soul: next.soul });
    }, 600);
  };

  const syncProfile = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSyncState('syncing');
    const result = await window.electronAPI.telegramBot.setPersona({
      botName: persona.botName,
      soul: persona.soul,
      syncProfile: true,
    });
    setSyncState(result.profileSynced ? 'done' : 'failed');
    setTimeout(() => setSyncState('idle'), 2500);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-13 font-medium text-[var(--settings-section-title)]">
        {t('settings.telegramBot.persona.title')}
      </div>
      <label
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.telegramBot.persona.nameLabel')}
      </label>
      <input
        type="text"
        value={persona.botName}
        maxLength={64}
        onChange={(e) => save({ ...persona, botName: e.target.value })}
        placeholder={t('settings.telegramBot.persona.namePlaceholder')}
        spellCheck={false}
        className={cn(
          'h-[42px] w-full rounded-full pl-[14px] pr-[14px]',
          'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
          'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      <label
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.telegramBot.persona.soulLabel')}
      </label>
      <textarea
        value={persona.soul}
        maxLength={4000}
        rows={5}
        onChange={(e) => save({ ...persona, soul: e.target.value })}
        placeholder={t('settings.telegramBot.persona.soulPlaceholder')}
        spellCheck={false}
        className={cn(
          'w-full resize-y rounded-2xl px-[14px] py-[10px]',
          'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
          'text-13 leading-[1.6] text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void syncProfile()}
          disabled={syncState === 'syncing' || !persona.botName.trim()}
          className={cn(
            'h-[32px] rounded-full px-4 text-12 font-medium transition-colors',
            'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
            'text-[var(--settings-btn-secondary-text)]',
            (syncState === 'syncing' || !persona.botName.trim()) && 'cursor-not-allowed opacity-40',
          )}
        >
          {t(`settings.telegramBot.persona.sync.${syncState}`)}
        </button>
        <span className="text-11 text-[var(--settings-section-desc)] opacity-80">
          {t('settings.telegramBot.persona.syncHint')}
        </span>
      </div>
    </div>
  );
}
