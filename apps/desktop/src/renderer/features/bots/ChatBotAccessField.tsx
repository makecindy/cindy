import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import type { BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { chatErrorKey } from './ChatServerControls';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
type Access = 'none' | 'chat' | 'tools';
const OPTIONS: ReadonlyArray<{ value: Access; title: string; hint: string }> = [
  { value: 'none', title: 'accessNoneTitle', hint: 'accessNoneHint' },
  { value: 'chat', title: 'accessChatTitle', hint: 'accessChatHint' },
  { value: 'tools', title: 'accessToolsTitle', hint: 'accessToolsHint' },
];

/**
 * How other members may use your teammate here: three choices, each saying what it allows.
 * Only the teammate's owner changes it; opening tools and private info asks first.
 */
export function ChatBotAccessField({ groupId, member, disabled = false }: {
  groupId: string;
  member: BotGroupSummary['members'][number];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = member.guestAccess ?? 'chat';
  const locked = disabled || busy || !member.isOwned || member.accessRevision === undefined;
  async function change(access: Access) {
    if (access === current || saving.current || disabled || !member.isOwned || !member.actorId || member.accessRevision === undefined) return;
    saving.current = true;
    setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const live = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    try {
      if (access === 'tools' && !(await confirm({
        title: t(key('authorizeTitle'), { name: member.name }),
        description: t(key('toolsHint')), confirmText: t(key('confirm')),
        cancelText: t('bots.cancel'), confirmVariant: 'destructive',
      }))) return;
      if (!live()) return;
      const action: ChatGroupAction = { type: 'botAccess', actorId: member.actorId, access, expectedRevision: member.accessRevision };
      const result = await window.electronAPI.maker.chatServer.manage({ groupId, action });
      if (!live()) return;
      if (!result.ok) setError(t(chatErrorKey(result.errorCode)));
      // A revision conflict also needs the current server value before another edit.
      refreshBotGroups();
    } catch {
      if (live()) setError(t(chatErrorKey('REQUEST_FAILED')));
    } finally {
      saving.current = false;
      if (live()) setBusy(false);
    }
  }
  const question = t(key('accessQuestion'), { name: member.name });
  return <SettingsSection title={question} caption={!member.isOwned ? t(key('ownerOnly')) : undefined}>
    <SettingsCard role="radiogroup" aria-label={question}>
      {OPTIONS.map(option => {
        const selected = current === option.value;
        // Radio rows top-align with a long hint; a locked choice still reads as the current one.
        return <SettingsRow key={option.value} role="radio" aria-checked={selected} disabled={locked}
          className={cn('items-start', locked && selected && 'opacity-100')}
          onClick={() => void change(option.value)}
          lead={<span aria-hidden className={cn('relative mt-px h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] transition-colors duration-[var(--motion-fast)]',
            selected ? 'border-[var(--switch-track-on)] after:absolute after:inset-[3px] after:rounded-full after:bg-[var(--switch-track-on)]' : 'border-[var(--text-tertiary)]')} />}
          title={t(key(option.title))}
          tag={option.value === 'chat' ? t(key('defaultTag')) : undefined}
          hint={t(key(option.hint), { name: member.name })} />;
      })}
    </SettingsCard>
    {error && <p role="alert" className="mt-2 text-12 leading-[1.42] text-[var(--text-danger)]">{error}</p>}
  </SettingsSection>;
}
