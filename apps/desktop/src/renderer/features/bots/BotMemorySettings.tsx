import { useMemo, useRef, type MutableRefObject } from 'react';

import {
  MemoryEntriesView,
  type MemoryEntriesSource,
  type MemoryEntriesTexts,
} from '@/components/memory/MemoryEntriesView';
import { Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useBotTranslation } from './botPronounContext';
import { useBotSettingsTarget } from './useBotSettingsTarget';

export interface AboutMeField {
  value: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
  /** IME composition handlers of the settings autosave. */
  composition?: { onCompositionStart: () => void; onCompositionEnd: () => void };
}

/**
 * 伙伴设置里的「记忆」页:开关、「关于我的记忆」与已存记忆(列表 → 详情 → 编辑)。
 * 列表 / 详情 / 编辑与 Cindy 记忆页共用 `MemoryEntriesView`;这里提供伙伴这一份记忆的读写
 * 与伙伴独有的开关、文本框。
 * 返回与离开由上层设置页的返回键驱动:`backRef` 先在页内回退,`leaveRef` 保证离开前落盘。
 */
export function BotMemorySettings({
  botId,
  botName,
  memoryEnabled,
  onMemoryEnabledChange,
  aboutMe,
  backRef,
  leaveRef,
}: {
  botId: string;
  botName: string;
  memoryEnabled: boolean;
  onMemoryEnabledChange: (enabled: boolean) => void;
  /** What the teammate knows about its owner (`userContextSource`): saved with the rest of the settings. */
  aboutMe: AboutMeField;
  backRef: MutableRefObject<(() => Promise<boolean>) | null>;
  leaveRef: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const { t } = useBotTranslation();
  // The teammate's computer serves the memory; the pages never assume it is this one.
  const target = useBotSettingsTarget();
  const targetRef = useRef(target);
  targetRef.current = target;
  const source = useMemo<MemoryEntriesSource>(
    () => ({
      key: botId,
      list: (query) => targetRef.current.memory.list(botId, query),
      read: (filename) => targetRef.current.memory.read(botId, filename),
      update: (input) => targetRef.current.memory.update({ botId, ...input }),
      delete: (input) => targetRef.current.memory.delete({ botId, ...input }),
    }),
    [botId],
  );
  const texts = useMemo<MemoryEntriesTexts>(
    () => ({
      deleteDescription: (title) => t('bots.memory.deleteDescription', { name: botName, title }),
      changed: t('bots.memory.changedTitle', { name: botName }),
    }),
    [botName, t],
  );

  return (
    <MemoryEntriesView
      source={source}
      texts={texts}
      dimmed={!memoryEnabled}
      backRef={backRef}
      leaveRef={leaveRef}
      listHeader={
        <>
          <div className="flex min-h-[52px] items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3">
            <div className="min-w-0">
              <p className="text-14 text-[var(--text-primary)]">{t('bots.memory.enabled')}</p>
              {!memoryEnabled ? (
                <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
                  {t('bots.memory.disabledHint')}
                </p>
              ) : null}
            </div>
            <Switch
              checked={memoryEnabled}
              onCheckedChange={onMemoryEnabledChange}
              aria-label={t('bots.memory.enabled')}
            />
          </div>
          <section aria-label={t('bots.memory.aboutMe')}>
            <h3 className="px-1 pb-2 text-12 font-medium text-[var(--text-secondary)]">
              {t('bots.memory.aboutMe')}
            </h3>
            <Textarea
              aria-label={t('bots.memory.aboutMe')}
              readOnly={aboutMe.readOnly}
              value={aboutMe.value}
              onChange={aboutMe.onChange}
              onBlur={aboutMe.onBlur}
              {...aboutMe.composition}
              rows={4}
              className="min-h-24 resize-none p-3 leading-6 [field-sizing:content]"
            />
          </section>
        </>
      }
    />
  );
}
