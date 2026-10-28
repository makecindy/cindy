import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Crown, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ProfileEditDialog } from '@/components/settings/ProfileEditDialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { ChatBotAccessField } from './ChatBotAccessField';
import { useBotProfiles } from './botStore';
import { BotAvatar } from './BotAvatar';
import { chatErrorKey } from './ChatServerControls';
import { refreshBotGroups } from './botGroupStore';
import { chatGroupMembership } from '@cindy/maker-shared/botGroupPresentation';
import { BOT_GROUP_SETTINGS_PARAM } from './botGroupPresentation';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
/** Labels shared with the local group settings, so both read the same. */
const shared = (name: string) => `bots.groupChat.settings.${name}`;
const REPLY_MODE_LABELS = { all: shared('replyModeAll'), mentioned: shared('replyModeMentioned') } as const;
const SPEAKING_MODE_LABELS = { auto: shared('speakingModeAuto'), sequential: shared('speakingModeSequential') } as const;
const api = () => window.electronAPI.maker.chatServer;

/** Shared group identity and companion grants are server-authoritative. */
export function ChatGroupSettings({ group }: { group: BotGroupSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm } = useConfirmDialog();
  const profiles = useBotProfiles();
  const companions = group.members.filter(member => member.actorKind === 'bot');
  const membership = chatGroupMembership(group);
  const { self: me } = membership;
  const owner = membership.owner && !group.dissolvedAt;
  const manager = membership.manager && !group.dissolvedAt;
  const canLeave = membership.canLeave && !group.dissolvedAt;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const soleOwner = me?.role === 'owner' && group.members.length === 1;
  const groupValues = { name: group.name, topic: group.topic ?? '', description: group.description ?? '',
    replyMode: group.replyMode, speakingMode: group.speakingMode, expectedRevision: group.revision! };
  // A draft owns its fields and base revision together; a clean form reads one live snapshot.
  const [draft, setDraft] = useState<(typeof groupValues & { saved?: boolean }) | null>(null);
  const awaitingSnapshot = !!draft?.saved && group.revision! <= draft.expectedRevision;
  const { name, topic, description, replyMode, speakingMode, expectedRevision } =
    draft && (!draft.saved || awaitingSnapshot) ? draft : groupValues;
  const editGroup = (change: Partial<Omit<typeof groupValues, 'expectedRevision'>>) => {
    setDraft(current => ({ ...((current?.saved ? null : current) ?? groupValues), ...change }));
  };
  useEffect(() => {
    if (draft?.saved && group.revision! > draft.expectedRevision) {
      setDraft(current => current === draft ? null : current);
    }
  }, [draft, group.revision]);
  const [nickname, setNickname] = useState(me?.nickname ?? '');
  const [editingProfile, setEditingProfile] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bots, setBots] = useState<Array<{ actorId: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const nicknameDirty = useRef(false);
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
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner)) return false;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); if (result.errorCode === 'REVISION_CONFLICT' && action.type !== 'hide') refreshBotGroups(); return false; }
      refreshBotGroups();
      if (exit) navigate('/bots');
      return true;
    } catch { if (mounted.current && isDataOwnerGenerationCurrent(owner)) setError(t(chatErrorKey('REQUEST_FAILED'))); return false; }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirmed(action: ChatGroupAction, title: string, note: string, exit = false, confirmText = t(key('confirm'))) {
    const owner = getDataOwnerGeneration();
    if (await confirm({ presentation: 'standard', title, description: note, confirmText,
      cancelText: t('bots.cancel'), confirmVariant: 'destructive' }) && mounted.current && isDataOwnerGenerationCurrent(owner)) await mutate(action, exit);
  }
  const profileOpenChange = useCallback((open: boolean) => setEditingProfile(open), []);
  const avatarEditor = useMemo(() => ({
    title: t(key('groupAvatar')),
    hint: t(key('groupAvatarHint')),
    getState: async () => ({ name: me?.name ?? '', avatarUrl: me?.groupAvatar ?? null, defaultAvatarUrl: me?.defaultAvatarUrl ?? null }),
    save: async (avatar: Parameters<Window['electronAPI']['profileUpdate']>[0]['avatar']) => {
      if (!me?.actorId) throw new Error('MEMBER_NOT_FOUND');
      const generation = getDataOwnerGeneration();
      const result = await api().manage({ groupId: group.id, action: { type: 'avatar', actorId: me.actorId, avatar } });
      if (!mounted.current || !isDataOwnerGenerationCurrent(generation)) throw new Error('OWNER_CHANGED');
      if (!result.ok) throw new Error(result.errorCode);
      refreshBotGroups();
    },
  }), [group.id, me?.actorId, me?.name, me?.groupAvatar, me?.defaultAvatarUrl, t]);
  async function updateWorkSettings(input: { organizerBotId?: string; projectDir?: string | null; autoContinue?: boolean }) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const generation = getDataOwnerGeneration();
    try {
      const result = await window.electronAPI.maker.updateBotGroup({ groupId: group.id, ...input });
      if (!isDataOwnerGenerationCurrent(generation)) return;
      if (!result.ok) setError(t('autoContinue' in input ? 'bots.groupChat.settings.autoContinueSaveFailed' : 'bots.groupChat.settings.projectDirSaveFailed'));
      else refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(generation)) setError(t(chatErrorKey('REQUEST_FAILED'))); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
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
        // The write is already committed. Retry the projection read, never the old CAS.
        if (awaitingSnapshot) { refreshBotGroups(); return; }
        void mutate({ type: 'update', name, topic, description, responseMode: replyMode, speakingMode,
          expectedRevision }).then(ok => {
            if (ok) setDraft({ name, topic, description, replyMode, speakingMode, expectedRevision, saved: true });
          });
      }}>
        <FormField label={t(key('name'))}>{props => <Input {...props} value={name} maxLength={40} required disabled={!manager || busy || awaitingSnapshot}
          onChange={name => editGroup({ name })} />}</FormField>
        <FormField label={t(key('topic'))}>{props => <Input {...props} value={topic} maxLength={250} disabled={!manager || busy || awaitingSnapshot}
          onChange={topic => editGroup({ topic })} />}</FormField>
        <FormField label={t(key('description'))}>{props => <Input {...props} value={description} maxLength={2000} disabled={!manager || busy || awaitingSnapshot}
          onChange={description => editGroup({ description })} />}</FormField>
        {/* Whether unaddressed messages wake anyone; independent of the order teammates answer in. */}
        <FormField label={t(shared('replyMode'))}>{props => <Select {...props} label={t(shared('replyMode'))} value={replyMode}
          disabled={!manager || busy || awaitingSnapshot} options={(['all', 'mentioned'] as const).map(value => ({ value, label: t(REPLY_MODE_LABELS[value]) }))}
          onValueChange={value => editGroup({ replyMode: value as typeof replyMode })} />}</FormField>
        {/* Single-speaker servers always answer one teammate at a time, so there is no speaking mode. */}
        {group.singleSpeaker ? null : <FormField label={t(shared('speakingMode'))}>{props => <Select {...props} label={t(shared('speakingMode'))} value={speakingMode}
          disabled={!manager || busy || awaitingSnapshot} options={(['auto', 'sequential'] as const).map(value => ({ value, label: t(SPEAKING_MODE_LABELS[value]) }))}
          onValueChange={value => editGroup({ speakingMode: value as typeof speakingMode })} />}</FormField>}
        {manager && <Button type="submit" size="sm" variant="secondary" disabled={busy || !name.trim()}>{t(key('save'))}</Button>}
      </form>
      {/* The organizer arranges a 分工 whose steps are not written out; a 分工 works in the project folder. */}
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
        {/* Kept on this computer like the project folder; only 分工 you start follow it (§7.4). */}
        {group.autoContinue !== undefined && <FormField label={t('bots.groupChat.settings.handoff')} hint={t('bots.groupChat.settings.autoContinueNote')}>{() =>
          <label className="flex w-fit cursor-pointer items-center gap-2.5 text-13 leading-5 text-[var(--text-primary)]">
            <Switch data-testid="bot-group-auto-continue" checked={group.autoContinue === true} disabled={busy}
              onCheckedChange={autoContinue => void updateWorkSettings({ autoContinue })} />
            <span className="min-w-0">{t('bots.groupChat.plan.autoContinue')}</span>
          </label>}</FormField>}
      </section>
      <section className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-14 font-medium text-[var(--text-primary)]">{t(key('myProfile'))}</h3>
          {group.supportsMemberAvatar && <Button size="sm" variant="secondary" disabled={busy || !me || !!group.dissolvedAt} onClick={() => setEditingProfile(true)}>{t(key('groupAvatar'))}</Button>}
        </div>
        <form className="flex items-end gap-2" onSubmit={event => {
          event.preventDefault();
          void mutate({ type: 'nickname', actorId: me!.actorId!, nickname: nickname.trim() || null }).then(ok => { if (ok) nicknameDirty.current = false; });
        }}>
          <FormField className="min-w-0 flex-1" label={t(key('nickname'))} hint={t(key('nicknameHint'))}>{props =>
            <Input {...props} value={nickname} maxLength={40} placeholder={me?.displayName} disabled={busy || !!group.dissolvedAt} onChange={event => { nicknameDirty.current = true; setNickname(event); }} />}</FormField>
          <Button className="mb-6" type="submit" size="sm" variant="secondary" disabled={busy || !me || !!group.dissolvedAt}>{t(key('save'))}</Button>
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
          <ChatBotAccessField groupId={group.id} member={member} disabled={busy || !!group.dissolvedAt} />
          {member.isOwned && profiles.some(bot => bot.id === member.botId) && <div className="space-y-2">
            <Button size="sm" variant="secondary" onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete(BOT_GROUP_SETTINGS_PARAM);
              next.set('settings', '1');
              next.set('settingsPage', 'capabilities');
              next.set('settingsBot', member.botId);
              setSearchParams(next);
            }}>
              {t(key('configureCapabilities'))}
            </Button>
            <p className="text-12 leading-5 text-[var(--text-secondary)]">{t(key('capabilityScope'), { name: member.name })}</p>
          </div>}
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
              {owner && member.actorKind === 'human' && member.role !== 'owner' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmed({ type: 'transfer', actorId }, t(key('transferTitle'), { name: member.name }), t(key('transferHint')))}>{t(key('transfer'))}</Button>}
              {manageable && <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate({ type: 'member', actorId, action: 'role', role: member.role === 'admin' ? 'member' : 'admin' })}>
                  {t(key(member.role === 'admin' ? 'removeAdmin' : 'makeAdmin'))}</Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmed({ type: 'member', actorId, action: 'remove' }, t(key('removeTitle'), { name: member.name }), t(key('removeHint')))}>{t(shared('remove'))}</Button>
              </div>}
            </div>}
          </div>;
        })}
        {!group.dissolvedAt && addable.length > 0 && <Select label={t(key('addCompanion'))} value="" disabled={busy}
          options={addable.map(bot => ({ value: bot.actorId, label: bot.name }))}
          onValueChange={actorId => void mutate({ type: 'member', actorId, action: 'invite' })} />}
      </section>
      {group.dissolvedAt && <p className="text-13 text-[var(--text-secondary)]">{t('bots.groupChat.lifecycle.dissolved')}</p>}
      <div className="space-y-3 border-t border-[var(--border-default)] pt-5">
        {soleOwner && !group.archived && !group.dissolvedAt && <p className="text-13 text-[var(--text-secondary)]">{t(key('soleOwnerHint'))}</p>}
        <div className="flex flex-wrap gap-2">
          {canLeave && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void confirmed({ type: 'member', actorId: me!.actorId!, action: 'leave' }, t(key('leave')), t(key('leaveHint')), true)}>{t(key('leave'))}</Button>}
          {manager && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void confirmed({ type: 'archive', archived: !group.archived, expectedRevision: group.revision! }, t(key(group.archived ? 'unarchive' : 'archive')), t(key(group.archived ? 'unarchiveHint' : 'archiveHint')), false, t(key(group.archived ? 'unarchive' : 'archive')))}>{t(key(group.archived ? 'unarchive' : 'archive'))}</Button>}
          {owner && <Button variant="secondary" size="sm" disabled={busy || group.supportsDissolve !== true}
            onClick={() => void confirmed({ type: 'dissolve', expectedRevision: group.revision! }, t('bots.groupChat.lifecycle.dissolve'), t('bots.groupChat.lifecycle.dissolveNote'))}>{t('bots.groupChat.lifecycle.dissolve')}</Button>}
          <Button variant="secondary" size="sm" disabled={busy || group.supportsListRemoval !== true}
            onClick={() => void confirmed({ type: 'hide' }, t('bots.groupChat.lifecycle.hide'), t('bots.groupChat.lifecycle.hideNote'), true)}>{t('bots.groupChat.lifecycle.hide')}</Button>
          {((owner && !group.supportsDissolve) || !group.supportsListRemoval) && <p className="w-full text-12 text-[var(--text-secondary)]">{t('bots.groupChat.lifecycle.unavailable')}</p>}
        </div>
      </div>
    </div>
    <ProfileEditDialog key={group.id} open={editingProfile} onOpenChange={profileOpenChange} avatarEditor={avatarEditor} />
  </div>;
}
