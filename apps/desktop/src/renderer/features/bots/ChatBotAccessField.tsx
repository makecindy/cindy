import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { chatErrorKey } from './ChatServerControls';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;

/** The same owner-only grant editor in group settings and companion settings. */
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
  async function change(access: 'none' | 'chat' | 'tools') {
    if (saving.current || disabled || !member.isOwned || !member.actorId || member.accessRevision === undefined) return;
    saving.current = true;
    setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    try {
      if (access === 'tools' && !(await confirm({
        presentation: 'standard', title: t(key('authorizeTitle'), { name: member.name }),
        description: t(key('toolsHint')), confirmText: t(key('confirm')),
        cancelText: t('bots.cancel'), confirmVariant: 'destructive',
      }))) return;
      if (!current()) return;
      const action: ChatGroupAction = { type: 'botAccess', actorId: member.actorId, access, expectedRevision: member.accessRevision };
      const result = await window.electronAPI.maker.chatServer.manage({ groupId, action });
      if (!current()) return;
      if (!result.ok) setError(t(chatErrorKey(result.errorCode)));
      // A revision conflict also needs the current server value before another edit.
      refreshBotGroups();
    } catch {
      if (current()) setError(t(chatErrorKey('REQUEST_FAILED')));
    } finally {
      saving.current = false;
      if (current()) setBusy(false);
    }
  }
  return <div className="space-y-2">
    <FormField label={t(key('guestAccess'))} hint={t(member.guestAccess === 'none'
      ? key('noneHint') : key(member.guestAccess === 'tools' ? 'toolsHint' : 'chatHint'))}>{props =>
      <Select {...props} label={t(key('guestAccess'))} value={member.guestAccess ?? 'chat'}
        disabled={disabled || busy || !member.isOwned || member.accessRevision === undefined}
        options={['none', 'chat', 'tools'].map(value => ({ value, label: t(key(value)) }))}
        onValueChange={value => void change(value as 'none' | 'chat' | 'tools')} />}
    </FormField>
    {!member.isOwned && <p className="text-12 leading-5 text-[var(--text-secondary)]">{t(key('ownerOnly'))}</p>}
    {error && <p role="alert" className="text-12 leading-5 text-[var(--text-danger)]">{error}</p>}
  </div>;
}
