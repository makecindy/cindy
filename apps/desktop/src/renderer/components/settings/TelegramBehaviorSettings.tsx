/**
 * Telegram 个人 bot「回应与引用」设置节(设计 v3 §五点四/五点五)。
 *
 * 三组分段选择: emoji 回应等级 / 群回复引用 / DM 回复引用。
 * 改动即写 main 侧 store(transport 每次使用现读), 无需重启 bot。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { contactsService } from '@/lib/contactsService';
import { cn } from '@/lib/utils';
import type {
  TelegramHookBehavior,
  TelegramHookGroupActivationMode,
  TelegramHookKnownGroup,
} from '../../../shared/hookControlIpc';

type Behavior = TelegramHookBehavior;
type SettingsSource = 'personal' | 'official';

function i18nRoot(source: SettingsSource): string {
  return source === 'official' ? 'settings.remoteControl.hook.telegram' : 'settings.telegramBot';
}

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
      <div
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
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

export function TelegramBehaviorSettings({ source = 'personal' }: { source?: SettingsSource }) {
  const { t } = useTranslation();
  const [behavior, setBehavior] = useState<Behavior | null>(null);
  const root = i18nRoot(source);

  useEffect(() => {
    let cancelled = false;
    const load =
      source === 'official'
        ? window.electronAPI.hookControl.getTelegramBehavior().then((value) => value.behavior)
        : window.electronAPI.telegramBot.getBehavior();
    void load.then((value) => {
      if (!cancelled) setBehavior(value);
    });
    const unsubscribe =
      source === 'official'
        ? window.electronAPI.hookControl.onTelegramBehaviorChanged((value) => {
            if (!cancelled) setBehavior(value);
          })
        : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [source]);

  if (!behavior) return null;

  const patch = (partial: Partial<Behavior>) => {
    // 乐观更新; main 侧 store 白名单校验后回真值。
    setBehavior({ ...behavior, ...partial });
    const save =
      source === 'official'
        ? window.electronAPI.hookControl
            .setTelegramBehavior(partial)
            .then((value) => value.behavior)
        : window.electronAPI.telegramBot.setBehavior(partial);
    void save.then(setBehavior);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-13 font-medium text-[var(--settings-section-title)]">
        {t(`${root}.behavior.title`)}
      </div>
      <SegmentedRow
        label={t(`${root}.behavior.emojiLabel`)}
        hint={t(`${root}.behavior.emojiHint.${behavior.emojiReactions}`)}
        options={EMOJI_OPTIONS}
        value={behavior.emojiReactions}
        optionLabel={(o) => t(`${root}.behavior.emojiOption.${o}`)}
        onChange={(emojiReactions) => patch({ emojiReactions })}
      />
      <SegmentedRow
        label={t(`${root}.behavior.groupQuoteLabel`)}
        hint={t(`${root}.behavior.groupQuoteHint.${behavior.replyQuoteGroup}`)}
        options={GROUP_QUOTE_OPTIONS}
        value={behavior.replyQuoteGroup}
        optionLabel={(o) => t(`${root}.behavior.quoteOption.${o}`)}
        onChange={(replyQuoteGroup) => patch({ replyQuoteGroup })}
      />
      <SegmentedRow
        label={t(`${root}.behavior.dmQuoteLabel`)}
        hint={t(`${root}.behavior.dmQuoteHint.${behavior.replyQuoteDm}`)}
        options={DM_QUOTE_OPTIONS}
        value={behavior.replyQuoteDm}
        optionLabel={(o) => t(`${root}.behavior.quoteOption.${o}`)}
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
  // 去抖窗口内未落盘的最新编辑 — 卸载时 flush, 600ms 内关面板不丢内容。
  const pendingSave = useRef<{ botName: string; soul: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.telegramBot.getPersona().then((value) => {
      if (!cancelled) setPersona(value);
    });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingSave.current) {
        const flush = pendingSave.current;
        pendingSave.current = null;
        void window.electronAPI.telegramBot.setPersona(flush);
      }
    };
  }, []);

  if (!persona) return null;

  const save = (next: { botName: string; soul: string }) => {
    setPersona(next);
    pendingSave.current = { botName: next.botName, soul: next.soul };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 600ms 去抖自动保存 — 无显式保存按钮(设置卡即改即存的通用手感)。
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null;
      void window.electronAPI.telegramBot.setPersona({ botName: next.botName, soul: next.soul });
    }, 600);
  };

  const syncProfile = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 本次调用带的就是最新值, 去抖窗口的待存内容随之落盘。
    pendingSave.current = null;
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

/**
 * 智能通讯录接线状态引导(Chris 2026-07-30: 通讯录关着时自动记人静默失效,
 * 没有任何引导 — 在群聊节明示状态, 关着给一键开启)。
 */
function ContactsAutoRegisterHint({ root }: { root: string }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void contactsService
      .settingsGet()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch(() => {
        /* 通讯录服务不可用时不渲染引导 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled === null) return null;
  if (enabled) {
    return (
      <div className="text-11 leading-[1.5] text-[var(--settings-section-desc)] opacity-80">
        {t(`${root}.groups.contactsOn`)}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-11 leading-[1.5] text-[var(--settings-section-desc)]">
        {t(`${root}.groups.contactsOff`)}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void contactsService
            .settingsSet(true)
            .then(() => setEnabled(true))
            .catch(() => {
              /* 失败保持关闭态, 用户可去通讯录设置页重试 */
            })
            .finally(() => setBusy(false));
        }}
        className={cn(
          'h-[26px] shrink-0 rounded-full border px-3 text-11 font-medium transition-colors',
          'border-[var(--settings-input-border-focus)] bg-[var(--settings-badge-bg)] text-[var(--settings-section-title)]',
          busy && 'cursor-not-allowed opacity-40',
        )}
      >
        {t(`${root}.groups.contactsEnable`)}
      </button>
    </div>
  );
}

/** 「群聊」节: bot 进过的群逐行切换参与模式(仅@ / 全响应·自主判断)。 */
export function TelegramGroupActivationSettings({
  source = 'personal',
}: {
  source?: SettingsSource;
}) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<TelegramHookKnownGroup[] | null>(null);
  const root = i18nRoot(source);

  useEffect(() => {
    let cancelled = false;
    const load =
      source === 'official'
        ? window.electronAPI.hookControl.listTelegramGroups()
        : window.electronAPI.telegramBot.listGroups();
    void load.then((result) => {
      if (!cancelled) setGroups(result.groups);
    });
    const unsubscribe =
      source === 'official'
        ? window.electronAPI.hookControl.onTelegramBehaviorChanged((behavior) => {
            if (cancelled) return;
            setGroups(
              (current) =>
                current?.map((group) => ({
                  ...group,
                  activation:
                    behavior.groupActivation[group.chatId] === 'always' ? 'always' : 'mention',
                })) ?? null,
            );
          })
        : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [source]);

  if (!groups) return null;

  const setMode = (chatId: string, mode: TelegramHookGroupActivationMode) => {
    setGroups(groups.map((g) => (g.chatId === chatId ? { ...g, activation: mode } : g)));
    if (source === 'official') {
      void window.electronAPI.hookControl.setTelegramGroupActivation(chatId, mode);
    } else {
      void window.electronAPI.telegramBot.setGroupActivation({ chatId, mode });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-13 font-medium text-[var(--settings-section-title)]">
        {t(`${root}.groups.title`)}
      </div>
      <div className="text-11 leading-[1.5] text-[var(--settings-section-desc)] opacity-80">
        {t(`${root}.groups.hint`)}
      </div>
      <ContactsAutoRegisterHint root={root} />
      {groups.length === 0 ? (
        <div className="text-12 text-[var(--settings-section-desc)]">
          {t(`${root}.groups.empty`)}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.chatId} className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-12 font-medium text-[var(--settings-section-title)]">
                {group.chatName || group.chatId}
              </div>
              <div className="text-11 text-[var(--settings-section-desc)] opacity-70">
                {group.chatId}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {(['mention', 'always'] as const).map((mode) => {
                const active = group.activation === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setMode(group.chatId, mode)}
                    aria-pressed={active}
                    className={cn(
                      'h-[28px] rounded-full border px-3 text-11 font-medium transition-colors',
                      active
                        ? 'border-[var(--settings-input-border-focus)] bg-[var(--settings-badge-bg)] text-[var(--settings-section-title)]'
                        : 'border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)]',
                    )}
                  >
                    {t(`${root}.groups.mode.${mode}`)}
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
