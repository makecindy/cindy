/**
 * DingTalkPersonaSettings —— 钉钉渠道的「人格」节：名字 + soul（基础人格）。
 *
 * 与个人 Telegram bot 的人格节同一手感：600ms 去抖自动保存，卸载时 flush；
 * 每轮回复都会带上这份人格。机器人应用与钉钉账号两种连接方式共用。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type Persona = { botName: string; soul: string };

export function DingTalkPersonaSettings() {
  const { t } = useTranslation();
  const [persona, setPersona] = useState<Persona | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 去抖窗口内未落盘的最新编辑 —— 卸载时 flush，600ms 内关面板不丢内容。
  const pendingSave = useRef<Persona | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot.getPersona().then((value) => {
      if (!cancelled) setPersona(value);
    });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingSave.current) {
        const flush = pendingSave.current;
        pendingSave.current = null;
        void window.electronAPI.dingtalkBot.setPersona(flush);
      }
    };
  }, []);

  if (!persona) return null;

  const save = (next: Persona) => {
    setPersona(next);
    pendingSave.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null;
      void window.electronAPI.dingtalkBot.setPersona(next);
    }, 600);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.dingtalkBot.persona.title')}
        </div>
        <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
          {t('settings.dingtalkBot.persona.description')}
        </div>
      </div>
      <label
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.dingtalkBot.persona.nameLabel')}
      </label>
      <input
        type="text"
        value={persona.botName}
        maxLength={64}
        onChange={(e) => save({ ...persona, botName: e.target.value })}
        placeholder={t('settings.dingtalkBot.persona.namePlaceholder')}
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
        {t('settings.dingtalkBot.persona.soulLabel')}
      </label>
      <textarea
        value={persona.soul}
        maxLength={4000}
        rows={5}
        onChange={(e) => save({ ...persona, soul: e.target.value })}
        placeholder={t('settings.dingtalkBot.persona.soulPlaceholder')}
        spellCheck={false}
        className={cn(
          'w-full resize-y rounded-2xl px-[14px] py-[10px]',
          'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
          'text-13 leading-[1.6] text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
    </div>
  );
}
