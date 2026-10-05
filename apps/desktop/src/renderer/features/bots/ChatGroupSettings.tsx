import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Crown, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ProfileEditDialog } from '@/components/settings/ProfileEditDialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { ChatBotAccessField } from './ChatBotAccessField';
import { useBotProfiles } from './botStore';
import { BotAvatar } from './BotAvatar';
import { chatErrorKey } from './ChatServerControls';
import { refreshBotGroups } from './botGroupStore';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
const api = () => window.electronAPI.maker.chatServer;

/** Shared group identity and companion grants are server-authoritative. */
export function ChatGroupSettings({ group }: { group: BotGroupSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const profiles = useBotProfiles();
  const companions = group.members.filter(member => member.actorKind === 'bot');
  const me = group.members.find(m => m.isSelf);
  const owner = group.members.some(m => m.isOwned && m.role === 'owner');
  const manager = owner || group.members.some(m => m.isOwned && m.role === 'admin');
  const [name, setName] = useState(group.name);
  const [topic, setTopic] = useState(group.topic ?? '');
  const [description, setDescription] = useState(group.description ?? '');
  const [replyMode, setReplyMode] = useState(group.replyMode);
  const [speakingMode, setSpeakingMode] = useState(group.speakingMode);
  const [nickname, setNickname] = useState(me?.nickname ?? '');
  const [editingProfile, setEditingProfile] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bots, setBots] = useState<Array<{ actorId: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const dirty = useRef(false);
  const draftRevision = useRef(group.revision!);
  const editGroup = () => { if (!dirty.current) draftRevision.current = group.revision!; dirty.current = true; };
  const nicknameDirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) { setName(group.name); setTopic(group.topic ?? ''); setDescription(group.description ?? ''); setReplyMode(group.replyMode); setSpeakingMode(group.speakingMode); }
  }, [group.name, group.topic, group.description, group.replyMode, group.speakingMode]);
  useEffect(() => { if (!nicknameDirty.current) setNickname(me?.nickname ?? ''); }, [me?.nickname]);
  useEffect(() => {
    let stale = false;
    void api().ownedBots().then(result => { if (!stale && result.ok) setBots(result.bots); }).catch(() => undefined);
    return () => { stale = true; };
  }, [group.id]);
  async function mutate(action: ChatGroupAction, exit = false) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    try {
      const result = await api().manage({ groupId: group.id, action });
      if (!isDataOwnerGenerationCurrent(owner)) return false;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return false; }
      refreshBotGroups();
      if (exit) navigate('/bots');
      return true;
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError(t(chatErrorKey('REQUEST_FAILED'))); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function confirmed(action: ChatGroupAction, title: string, note: string, exit = false) {
    const owner = getDataOwnerGeneration();
    if (await confirm({ presentation: 'standard', title, description: note, confirmText: t(key('confirm')),
      cancelText: t('bots.cancel'), confirmVariant: 'destructive' }) && isDataOwnerGenerationCurrent(owner)) await mutate(action, exit);
  }
  const profileOpenChange = useCallback((open: boolean) => {
    setEditingProfile(open);
    if (!open) {
      const owner = getDataOwnerGeneration();
      void api().refreshProfile().then(result => {
        if (!isDataOwnerGenerationCurrent(owner)) return;
        if (!result.ok) setError(t(chatErrorKey(result.errorCode)));
        else refreshBotGroups();
      }).catch(() => { if (isDataOwnerGenerationCurrent(owner)) setError(t(chatErrorKey('REQUEST_FAILED'))); });
    }
  }, [t]);
  async function updateWorkSettings(input: { organizerBotId?: string; projectDir?: string | null }) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const generation = getDataOwnerGeneration();
    try {
      const result = await window.electronAPI.maker.updateBotGroup({ groupId: group.id, ...input });
      if (!isDataOwnerGenerationCurrent(generation)) return;
      if (!result.ok) setError(t('bots.groupChat.settings.projectDirSaveFailed'));
      else refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(generation)) setError(t(chatErrorKey('REQUEST_FAILED'))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function chooseProjectDir() {
    const generation = getDataOwnerGeneration();
    try {
      const result = await window.electronAPI.dialog.showOpenDirectory(group.projectDir ? { defaultPath: group.projectDir } : undefined);
      if (result.success && result.path && isDataOwnerGenerationCurrent(generation)) await updateWorkSettings({ projectDir: result.path });
    } catch { if (isDataOwnerGenerationCurrent(generation)) setError(t('bots.groupChat.settings.projectDirSaveFailed')); }
  }
  const addable = bots.filter(b => !group.members.some(m => m.actorId === b.actorId));
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="space-y-6 p-5">
      {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
      <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        void mutate({ type: 'update', name, topic, description, responseMode: replyMode, speakingMode, expectedRevision: draftRevision.current }).then(ok => { if (ok) dirty.current = false; });
      }}>
        <FormField label={t(key('name'))}>{props => <Input {...props} value={name} maxLength={40} required disabled={!manager || busy}
          onChange={event => { editGroup(); setName(event); }} />}</FormField>
        <FormField label={t(key('topic'))}>{props => <Input {...props} value={topic} maxLength={250} disabled={!manager || busy}
          onChange={event => { editGroup(); setTopic(event); }} />}</FormField>
        <FormField label={t(key('description'))}>{props => <Input {...props} value={description} maxLength={2000} disabled={!manager || busy}
          onChange={event => { editGroup(); setDescription(event); }} />}</FormField>
        <FormField label={t(key('replyMode'))}>{props => <Select {...props} label={t(key('replyMode'))} value={replyMode}
          disabled={!manager || busy} options={['all', 'mentioned'].map(value => ({ value, label: t(key(value)) }))}
          onValueChange={value => { editGroup(); setReplyMode(value as typeof replyMode); }} />}</FormField>
        <FormField label={t(key('speakingMode'))}>{props => <Select {...props} label={t(key('speakingMode'))} value={speakingMode}
          disabled={!manager || busy} options={['auto', 'sequential'].map(value => ({ value, label: t(key(value)) }))}
          onValueChange={value => { editGroup(); setSpeakingMode(value as typeof speakingMode); }} />}</FormField>
        {manager && <Button type="submit" size="sm" variant="secondary" disabled={busy || !name.trim()}>{t(key('save'))}</Button>}
      </form>
      <section className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <FormField label={t('bots.groupChat.organizer')} hint={t('bots.groupChat.settings.organizerNote')}>{props =>
          <Select {...props} label={t('bots.groupChat.organizer')} value={group.organizerBotId ?? ''}
            disabled={!manager || busy} options={companions.filter(m => m.status === 'active').map(m => ({ value: m.botId, label: m.name }))}
            onValueChange={organizerBotId => void updateWorkSettings({ organizerBotId })} />}</FormField>
        <FormField label={t('bots.groupChat.settings.projectDir')} hint={t('bots.groupChat.settings.projectDirNote')}>{() =>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-secondary)]" title={group.projectDir ?? undefined}>{group.projectDir ?? t('bots.groupChat.settings.projectDirNone')}</span>
            {group.projectDir && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void updateWorkSettings({ projectDir: null })}>{t('bots.groupChat.settings.projectDirClear')}</Button>}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void chooseProjectDir()}>{t('bots.groupChat.settings.projectDirChoose')}</Button>
          </div>}</FormField>
      </section>
      <section className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-14 font-medium text-[var(--text-primary)]">{t(key('myProfile'))}</h3>
          <Button size="sm" variant="secondary" onClick={() => setEditingProfile(true)}>{t(key('editProfile'))}</Button>
        </div>
        <form className="flex items-end gap-2" onSubmit={event => {
          event.preventDefault();
          void mutate({ type: 'nickname', actorId: me!.actorId!, nickname: nickname.trim() || null }).then(ok => { if (ok) nicknameDirty.current = false; });
        }}>
          <FormField className="min-w-0 flex-1" label={t(key('nickname'))} hint={t(key('nicknameHint'))}>{props =>
            <Input {...props} value={nickname} maxLength={40} placeholder={me?.displayName} disabled={busy} onChange={event => { nicknameDirty.current = true; setNickname(event); }} />}</FormField>
          <Button className="mb-6" type="submit" size="sm" variant="secondary" disabled={busy || !me}>{t(key('save'))}</Button>
        </form>
      </section>
      {companions.length > 0 && <section className="space-y-4 border-t border-[var(--border-default)] pt-5">
        <h3 className="text-14 font-medium text-[var(--text-primary)]">{t(key('companionPermissions'))}</h3>
        {companions.map(member => <div key={member.actorId} className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
          <div className="flex items-center gap-3">
            <BotAvatar bot={member} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-13 font-medium text-[var(--text-primary)]">{member.name}</p>
              <p className="text-12 text-[var(--text-secondary)]">{t(key('companionOf'), { name: member.ownerName })}</p>
            </div>
          </div>
          <ChatBotAccessField groupId={group.id} member={member} disabled={busy} />
          {member.isOwned && profiles.some(bot => bot.id === member.botId) && <Button size="sm" variant="secondary"
            onClick={() => navigate(`/bots/${encodeURIComponent(member.botId)}?settings=1&settingsPage=capabilities`)}>
            {t(key('configureCapabilities'))}
          </Button>}
        </div>)}
      </section>}
      <section className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <h3 className="text-14 font-medium text-[var(--text-primary)]">{t(key('members'), { count: group.members.length })}</h3>
        {group.members.map(member => {
          const actorId = member.actorId!;
          const open = expanded === actorId;
          const manageable = manager && !member.isSelf && (owner || member.role !== 'owner');
          return <div key={actorId} className="space-y-3">
            <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-lg p-1 text-left hover:bg-[var(--surface-hover)]"
              aria-expanded={open} onClick={() => setExpanded(open ? null : actorId)}>
              <BotAvatar bot={member} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-13 text-[var(--text-primary)]"><span className="truncate">{member.name}</span>
                  {member.role === 'owner' && <Crown size={13} aria-label={t(key('owner'))} />}
                  {member.role === 'admin' && <Shield size={13} aria-label={t(key('admin'))} />}
                </span>
                <span className="block truncate text-12 text-[var(--text-tertiary)]">{member.actorKind === 'bot'
                  ? t(key('companionOf'), { name: member.ownerName }) : t(key(member.role ?? 'member'))}</span>
              </span>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {open && <div className="space-y-3 pl-11 pb-2">
              {member.nickname && member.nickname !== member.displayName && <p className="text-12 text-[var(--text-secondary)]">{member.displayName}</p>}
              {owner && member.role !== 'owner' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmed({ type: 'transfer', actorId }, t(key('transferTitle'), { name: member.name }), t(key('transferHint')))}>{t(key('transfer'))}</Button>}
              {manageable && <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate({ type: 'member', actorId, action: 'role', role: member.role === 'admin' ? 'member' : 'admin' })}>
                  {t(key(member.role === 'admin' ? 'removeAdmin' : 'makeAdmin'))}</Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmed({ type: 'member', actorId, action: 'remove' }, t(key('removeTitle'), { name: member.name }), t(key('removeHint')))}>{t(key('remove'))}</Button>
              </div>}
            </div>}
          </div>;
        })}
        {addable.length > 0 && <Select label={t(key('addCompanion'))} value="" disabled={busy}
          options={addable.map(bot => ({ value: bot.actorId, label: bot.name }))}
          onValueChange={actorId => void mutate({ type: 'member', actorId, action: 'invite' })} />}
      </section>
      <div className="flex flex-wrap gap-2 border-t border-[var(--border-default)] pt-5">
        <Button variant="secondary" size="sm" disabled={busy || !me} onClick={() => void confirmed({ type: 'member', actorId: me!.actorId!, action: 'leave' }, t(key('leave')), t(key('leaveHint')), true)}>{t(key('leave'))}</Button>
        {manager && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void confirmed({ type: 'archive', archived: !group.archived, expectedRevision: group.revision! }, t(key(group.archived ? 'unarchive' : 'archive')), t(key(group.archived ? 'unarchiveHint' : 'archiveHint')))}>{t(key(group.archived ? 'unarchive' : 'archive'))}</Button>}
      </div>
    </div>
    <ProfileEditDialog open={editingProfile} onOpenChange={profileOpenChange} />
  </div>;
}
