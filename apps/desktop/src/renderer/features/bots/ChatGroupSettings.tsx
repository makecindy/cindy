/**
 * 共享群（Chat Server）的群设置抽屉正文。首页是群身份 + 唯一的「邀请」入口 + 两个标签：
 * 「群设置」先放你自己的（我在本群、我的伙伴），群级默认（接话方式、负责人、分工、
 * 归档与解散）收进只有群主和管理员能进的「群管理」；「成员」是可搜索的成员表。编辑群
 * 资料、本群资料、伙伴在本群的权限都是抽屉里的下一页（`groupSettingsPage`），返回仍落在
 * 原来的标签上。群身份与伙伴授权以服务端为准，项目文件夹和自动交接只存在这台电脑上。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Camera, ChevronDown, Folder, Reply, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ProfileEditDialog } from '@/components/settings/ProfileEditDialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { GroupMaskAvatar, useOpenGroupMask } from './GroupMaskControls';
import { useGroupMask } from './groupMaskPresentation';
import { ChatBotAccessField } from './ChatBotAccessField';
import { ChatGroupInviteMenu } from './ChatGroupInviteMenu';
import { ACCESS_LABELS, ChatGroupMembersTab, type MemberActions } from './ChatGroupMembersTab';
import { SETTINGS_HINT, SettingsCard, SettingsNotice, SettingsRow, SettingsRowIcon, SettingsSection } from './ChatGroupSettingsRows';
import { useBotProfiles } from './botStore';
import { BotAvatar } from './BotAvatar';
import { BotGroupSidebarAvatar } from './BotGroupAvatars';
import { chatErrorKey } from './ChatServerControls';
import { refreshBotGroups } from './botGroupStore';
import { chatGroupMembership } from '@cindy/maker-shared/botGroupPresentation';
import { BOT_GROUP_SETTINGS_PAGE_PARAM, BOT_GROUP_SETTINGS_PARAM, botGroupPathBasename } from './botGroupPresentation';

const key = (name: string) => `bots.groupChat.server.settings.${name}`;
/** Labels shared with the local group settings, so both read the same. */
const shared = (name: string) => `bots.groupChat.settings.${name}`;
const REPLY_MODE_LABELS = { all: shared('replyModeAll'), mentioned: shared('replyModeMentioned') } as const;
const SPEAKING_MODE_LABELS = { auto: shared('speakingModeAuto'), sequential: shared('speakingModeSequential') } as const;
const api = () => window.electronAPI.maker.chatServer;
const COMPANION_PAGE = 'companion:';

export type ChatGroupSettingsPage =
  | { kind: 'manage' | 'edit' | 'profile' }
  | { kind: 'companion'; member: BotGroupMemberView };

/**
 * The page a `groupSettingsPage` value opens, or null when it does not apply to you now
 * (group management for members, a teammate that has left, a dissolved group).
 */
export function resolveChatGroupSettingsPage(group: BotGroupSummary, value: string | null): ChatGroupSettingsPage | null {
  if (!value || !group.serverBacked || group.dissolvedAt) return null;
  const { self, manager } = chatGroupMembership(group);
  if (value === 'manage' || value === 'edit') return manager ? { kind: value } : null;
  if (value === 'profile') return self?.actorId ? { kind: 'profile' } : null;
  if (!value.startsWith(COMPANION_PAGE)) return null;
  const actorId = value.slice(COMPANION_PAGE.length);
  const member = group.members.find(candidate => candidate.actorId === actorId && candidate.actorKind === 'bot' && candidate.isOwned === true);
  return member ? { kind: 'companion', member } : null;
}

export function chatGroupSettingsPageTitle(page: ChatGroupSettingsPage, t: TFunction): string {
  if (page.kind === 'companion') return t(key('companionTitle'), { name: page.member.name });
  return t(key(page.kind === 'manage' ? 'manage' : page.kind === 'edit' ? 'editTitle' : 'myProfile'));
}

/** Shared group identity and companion grants are server-authoritative. */
export function ChatGroupSettings({ group }: { group: BotGroupSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm } = useConfirmDialog();
  const profiles = useBotProfiles();
  const mask = useGroupMask(group.id);
  const openMask = useOpenGroupMask();
  const companions = group.members.filter(member => member.actorKind === 'bot');
  const ownBots = companions.filter(member => member.isOwned === true && !!member.actorId);
  const membership = chatGroupMembership(group);
  const { self: me } = membership;
  const dissolved = !!group.dissolvedAt;
  const owner = membership.owner && !dissolved;
  const manager = membership.manager && !dissolved;
  const canLeave = membership.canLeave && !dissolved;
  const rawPage = searchParams.get(BOT_GROUP_SETTINGS_PAGE_PARAM);
  const page = resolveChatGroupSettingsPage(group, rawPage);
  const pageKey = page ? (page.kind === 'companion' ? `companion:${page.member.actorId}` : page.kind) : 'home';
  const [tab, setTab] = useState<'settings' | 'members'>('settings');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const soleOwner = me?.role === 'owner' && group.members.length === 1;
  const groupValues = { name: group.name, topic: group.topic ?? '', description: group.description ?? '',
    replyMode: group.replyMode, speakingMode: group.speakingMode, expectedRevision: group.revision! };
  // A draft owns its fields and base revision together; a clean form reads one live snapshot.
  const [draft, setDraft] = useState<(typeof groupValues & { saved?: boolean }) | null>(null);
  const awaitingSnapshot = !!draft?.saved && group.revision! <= draft.expectedRevision;
  const editing = draft && (!draft.saved || awaitingSnapshot) ? draft : groupValues;
  // Outside the edit page only a saved draft shows, until the server snapshot catches up.
  const shown = draft?.saved && awaitingSnapshot ? draft : groupValues;
  const editGroup = (change: Partial<Pick<typeof groupValues, 'name' | 'topic' | 'description'>>) => {
    setDraft(current => ({ ...((current?.saved ? null : current) ?? groupValues), ...change }));
  };
  useEffect(() => {
    if (draft?.saved && group.revision! > draft.expectedRevision) {
      setDraft(current => current === draft ? null : current);
    }
  }, [draft, group.revision]);
  // Leaving the edit page without saving drops its draft.
  useEffect(() => { if (page?.kind !== 'edit') setDraft(current => current && !current.saved ? null : current); }, [page?.kind]);
  // 接话方式 apply at once; the chosen value shows until the snapshot carrying it arrives.
  const [rules, setRules] = useState<{ replyMode: BotGroupSummary['replyMode']; speakingMode: BotGroupSummary['speakingMode']; revision: number } | null>(null);
  const rulesPending = !!rules && group.revision! <= rules.revision;
  useEffect(() => { if (rules && group.revision! > rules.revision) setRules(current => current === rules ? null : current); }, [rules, group.revision]);
  const replyMode = rulesPending ? rules.replyMode : group.replyMode;
  const speakingMode = rulesPending ? rules.speakingMode : group.speakingMode;
  const [nickname, setNickname] = useState(me?.nickname ?? '');
  const [editingProfile, setEditingProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const nicknameDirty = useRef(false);
  useEffect(() => { if (!nicknameDirty.current) setNickname(me?.nickname ?? ''); }, [me?.nickname]);

  const scroller = useRef<HTMLDivElement>(null);
  const homeScroll = useRef(0);
  const go = useCallback((value: string | null) => {
    if (!page && scroller.current) homeScroll.current = scroller.current.scrollTop;
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (value) next.set(BOT_GROUP_SETTINGS_PAGE_PARAM, value); else next.delete(BOT_GROUP_SETTINGS_PAGE_PARAM);
      return next;
    }, { replace: true });
  }, [page, setSearchParams]);
  // A page opens at its top; coming back to the main page returns to where you were.
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = pageKey === 'home' ? homeScroll.current : 0; }, [pageKey]);
  // A page that no longer applies (the teammate left, you are no longer an admin) closes itself.
  useEffect(() => { if (rawPage && !page) go(null); }, [rawPage, page, go]);

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
  async function saveRules(change: { replyMode?: BotGroupSummary['replyMode']; speakingMode?: BotGroupSummary['speakingMode'] }) {
    if (busyRef.current || group.revision === undefined) return;
    const next = { replyMode: change.replyMode ?? replyMode, speakingMode: change.speakingMode ?? speakingMode, revision: group.revision };
    setRules(next);
    const ok = await mutate({ type: 'update', name: group.name, topic: group.topic ?? '', description: group.description ?? '',
      responseMode: next.replyMode, speakingMode: next.speakingMode, expectedRevision: group.revision });
    if (!ok && mounted.current) setRules(current => current === next ? null : current);
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
  function saveEdit(event: FormEvent) {
    event.preventDefault();
    // The write is already committed. Retry the projection read, never the old CAS.
    if (awaitingSnapshot) { refreshBotGroups(); go(null); return; }
    const { name, topic, description, replyMode, speakingMode, expectedRevision } = editing;
    void mutate({ type: 'update', name, topic, description, responseMode: replyMode, speakingMode, expectedRevision }).then(ok => {
      if (!ok) return;
      setDraft({ name, topic, description, replyMode, speakingMode, expectedRevision, saved: true });
      go(null);
    });
  }
  function saveNickname(event: FormEvent) {
    event.preventDefault();
    if (!me?.actorId) return;
    void mutate({ type: 'nickname', actorId: me.actorId, nickname: nickname.trim() || null }).then(ok => {
      if (!ok) return;
      nicknameDirty.current = false;
      go(null);
    });
  }
  function openCapabilities(member: BotGroupMemberView) {
    const next = new URLSearchParams(searchParams);
    next.delete(BOT_GROUP_SETTINGS_PARAM);
    next.delete(BOT_GROUP_SETTINGS_PAGE_PARAM);
    next.set('settings', '1');
    next.set('settingsPage', 'capabilities');
    next.set('settingsBot', member.botId);
    setSearchParams(next);
  }
  const memberActions: MemberActions = {
    access: member => go(`${COMPANION_PAGE}${member.actorId}`),
    role: member => void mutate({ type: 'member', actorId: member.actorId!, action: 'role', role: member.role === 'admin' ? 'member' : 'admin' }),
    transfer: member => void confirmed({ type: 'transfer', actorId: member.actorId! }, t(key('transferTitle'), { name: member.name }), t(key('transferHint'))),
    remove: member => void confirmed({ type: 'member', actorId: member.actorId!, action: 'remove' }, t(key('removeTitle'), { name: member.name }), t(key('removeHint'))),
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  if (page?.kind === 'manage') {
    const activeCompanions = companions.filter(member => member.status === 'active');
    body = <>
      {group.archived && <SettingsNotice>{t(key('archived'))}</SettingsNotice>}
      {/* Whether unaddressed messages wake anyone; independent of the order teammates answer in. */}
      <SettingsSection title={t(key('replies'))}>
        <SettingsCard>
          <SettingsRow wrap title={t(shared('replyMode'))} hint={t(replyMode === 'all' ? shared('replyModeNote') : key('replyModeMentionedNote'))}
            trailing={<Select label={t(shared('replyMode'))} value={replyMode} disabled={busy} className="h-8 max-w-[220px]"
              options={(['mentioned', 'all'] as const).map(value => ({ value, label: t(REPLY_MODE_LABELS[value]) }))}
              onValueChange={value => void saveRules({ replyMode: value as typeof replyMode })} />} />
          {/* Single-speaker servers always answer one teammate at a time, so there is no speaking mode. */}
          {!group.singleSpeaker && <SettingsRow wrap title={t(shared('speakingMode'))}
            hint={t(shared(speakingMode === 'auto' ? 'speakingModeAutoNote' : 'speakingModeSequentialNote'))}
            trailing={<Select label={t(shared('speakingMode'))} value={speakingMode} disabled={busy} className="h-8 max-w-[220px]"
              options={(['auto', 'sequential'] as const).map(value => ({ value, label: t(SPEAKING_MODE_LABELS[value]) }))}
              onValueChange={value => void saveRules({ speakingMode: value as typeof speakingMode })} />} />}
        </SettingsCard>
      </SettingsSection>
      {/* The organizer arranges a 分工 whose steps are not written out; a 分工 works in the project folder. */}
      <SettingsSection title={t(key('work'))} caption={t(key('workCaption'))}>
        <SettingsCard>
          {companions.length > 0 && <SettingsRow wrap title={t('bots.groupChat.organizer')} hint={t(key('organizerHint'))}
            trailing={<Select label={t('bots.groupChat.organizer')} value={group.organizerBotId ?? ''} disabled={busy} className="h-8 max-w-[220px]" truncateOptions
              options={activeCompanions.map(member => ({ value: member.botId, label: member.name }))}
              onValueChange={organizerBotId => void updateWorkSettings({ organizerBotId })} />} />}
          <SettingsRow wrap title={t(shared('projectDir'))} hint={t(key('projectDirHint'))}
            trailing={<ProjectFolder dir={group.projectDir} busy={busy} onChoose={() => void chooseProjectDir()} onClear={() => void updateWorkSettings({ projectDir: null })} />} />
          {/* Kept on this computer like the project folder; only 分工 you start follow it (§7.4). */}
          {group.autoContinue !== undefined && <SettingsRow title={t('bots.groupChat.plan.autoContinue')} hint={t(key('autoContinueHint'))}
            trailing={<Switch data-testid="bot-group-auto-continue" checked={group.autoContinue === true} disabled={busy}
              aria-label={t('bots.groupChat.plan.autoContinue')} onCheckedChange={autoContinue => void updateWorkSettings({ autoContinue })} />} />}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection caption={owner && group.supportsDissolve !== true ? t('bots.groupChat.lifecycle.unavailable') : undefined}>
        <SettingsCard>
          <SettingsRow title={t(key(group.archived ? 'unarchive' : 'archive'))} hint={t(key(group.archived ? 'unarchiveRowHint' : 'archiveRowHint'))} disabled={busy}
            onClick={() => void confirmed({ type: 'archive', archived: !group.archived, expectedRevision: group.revision! }, t(key(group.archived ? 'unarchive' : 'archive')),
              t(key(group.archived ? 'unarchiveHint' : 'archiveHint')), false, t(key(group.archived ? 'unarchive' : 'archive')))} />
          {owner && <SettingsRow danger title={t('bots.groupChat.lifecycle.dissolve')} hint={t(key('dissolveRowHint'))} disabled={busy || group.supportsDissolve !== true}
            onClick={() => void confirmed({ type: 'dissolve', expectedRevision: group.revision! }, t('bots.groupChat.lifecycle.dissolve'), t('bots.groupChat.lifecycle.dissolveNote'))} />}
        </SettingsCard>
      </SettingsSection>
      <p className={cn('-mt-3', SETTINGS_HINT)}>{t(key('manageCaption'))}</p>
    </>;
  } else if (page?.kind === 'edit') {
    body = <form id="chat-group-edit" className="flex flex-col gap-5" onSubmit={saveEdit}>
      <FormField label={t(key('name'))}>{props => <Input {...props} size="md" value={editing.name} maxLength={40} required disabled={busy || awaitingSnapshot}
        onChange={name => editGroup({ name })} />}</FormField>
      <FormField label={t(key('topic'))} hint={t(key('topicHint'))}>{props => <Input {...props} size="md" value={editing.topic} maxLength={250} disabled={busy || awaitingSnapshot}
        onChange={topic => editGroup({ topic })} />}</FormField>
      <FormField label={t(key('description'))} hint={<span className="flex justify-between gap-3"><span>{t(key('descriptionHint'))}</span>
        <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">{editing.description.length}/2000</span></span>}>{props =>
        <Textarea {...props} rows={6} value={editing.description} maxLength={2000} disabled={busy || awaitingSnapshot} className="resize-none leading-[1.54]"
          onChange={description => editGroup({ description })} />}</FormField>
    </form>;
    footer = <>
      <Button variant="secondary" size="md" onClick={() => go(null)}>{t('bots.cancel')}</Button>
      <Button variant="cta" size="md" type="submit" form="chat-group-edit" disabled={busy || !editing.name.trim()}>{t(key('save'))}</Button>
    </>;
  } else if (page?.kind === 'profile' && me) {
    body = <>
      <div className="flex flex-col items-center pt-1 text-center">
        {group.supportsMemberAvatar
          ? <button type="button" aria-label={t(key('groupAvatar'))} disabled={busy} onClick={() => setEditingProfile(true)}
            className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]">
            <BotAvatar bot={me} size="xl" />
            <span aria-hidden className="absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]"><Camera size={12} /></span>
          </button>
          : <BotAvatar bot={me} size="xl" />}
        <p className="mt-3 max-w-full text-16 font-medium leading-[1.375] text-[var(--text-primary)] [overflow-wrap:anywhere]">{me.name}</p>
        {group.supportsMemberAvatar && <p className="mt-1 max-w-[320px] text-13 leading-[1.54] text-[var(--text-secondary)] [text-wrap:pretty]">{t(key('groupAvatarHint'))}</p>}
      </div>
      <form id="chat-group-profile" onSubmit={saveNickname}>
        <FormField label={t(key('nickname'))} hint={t(key('nicknameHint'))}>{props =>
          <Input {...props} size="md" value={nickname} maxLength={40} placeholder={me.displayName} disabled={busy}
            onChange={value => { nicknameDirty.current = true; setNickname(value); }} />}</FormField>
      </form>
    </>;
    footer = <Button variant="cta" size="md" type="submit" form="chat-group-profile" disabled={busy}>{t(key('save'))}</Button>;
  } else if (page?.kind === 'companion') {
    const member = page.member;
    body = <>
      <div className="flex items-center gap-3">
        <BotAvatar bot={member} size="md" />
        <div className="min-w-0">
          <p className="text-16 font-medium leading-[1.375] text-[var(--text-primary)] [overflow-wrap:anywhere]">{member.name}</p>
          <p className="mt-0.5 text-13 leading-[1.38] text-[var(--text-secondary)]">{t(key('yourTeammate'))}</p>
        </div>
      </div>
      <ChatBotAccessField groupId={group.id} member={member} disabled={busy} />
      {profiles.some(bot => bot.id === member.botId) && <SettingsSection caption={t(key('capabilityScope'), { name: member.name })}>
        <SettingsCard>
          <SettingsRow title={t(key('capabilitiesRow'), { name: member.name })} onClick={() => openCapabilities(member)}
            trailing={<ArrowUpRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />} />
        </SettingsCard>
      </SettingsSection>}
    </>;
  } else {
    body = <>
      <Hero group={group} name={shown.name} me={me} invite={!dissolved && !group.archived && !!me?.actorId} />
      <SegmentedControl role="tablist" fullWidth value={tab} aria-label={t('bots.groupChat.settings.title')} onValueChange={setTab}
        options={[
          { value: 'settings', label: t(key('tabSettings')), id: 'chat-group-tab-settings', 'aria-controls': 'chat-group-tabpanel' },
          { value: 'members', label: <>{t(shared('members'))} <span className="tabular-nums">{group.members.length}</span></>, id: 'chat-group-tab-members', 'aria-controls': 'chat-group-tabpanel' },
        ]} />
      <div key={tab} id="chat-group-tabpanel" role="tabpanel" aria-labelledby={`chat-group-tab-${tab}`} className="flex animate-fade-in flex-col gap-6">
        {tab === 'members'
          ? <ChatGroupMembersTab group={group} owner={owner} manager={manager} busy={busy} actions={memberActions} />
          : <>
            {dissolved && <SettingsNotice>{t('bots.groupChat.lifecycle.dissolved')}</SettingsNotice>}
            {group.archived && !dissolved && <SettingsNotice>{t(key('archived'))}</SettingsNotice>}
            {soleOwner && !group.archived && !dissolved && <SettingsNotice>{t(key('soleOwnerHint'))}</SettingsNotice>}
            <About topic={shown.topic} description={shown.description} canEdit={manager} onEdit={() => go('edit')} />
            {!dissolved && me?.actorId && <SettingsSection title={t(key('me'))}>
              <SettingsCard>
                <SettingsRow media lead={<BotAvatar bot={me} size="sm" className="h-8 w-8" />} title={me.name} hint={t(key('profileHint'))} chevron onClick={() => go('profile')} />
                {mask && !group.archived && <SettingsRow media data-testid="group-mask-settings-entry"
                  lead={mask.settings.companionId
                    ? <GroupMaskAvatar self={mask.self} companion={mask.companions.find(companion => companion.id === mask.settings.companionId)} />
                    : <SettingsRowIcon><Reply size={16} aria-hidden /></SettingsRowIcon>}
                  title={t('bots.groupChat.mask.title')} hint={t(key('maskHint'))} value={t(`bots.groupChat.mask.status.${mask.status}`)} chevron
                  onClick={() => { if (scroller.current) homeScroll.current = scroller.current.scrollTop; openMask(); }} />}
              </SettingsCard>
            </SettingsSection>}
            {!dissolved && !group.archived && ownBots.length > 0 && <SettingsSection title={t(key('myTeammates'))} caption={t(key('myTeammatesCaption'))}>
              <SettingsCard>
                {ownBots.map(member => <SettingsRow key={member.actorId} lead={<BotAvatar bot={member} size="sm" className={member.status === 'paused' ? 'opacity-60' : undefined} />}
                  title={member.name} value={t(ACCESS_LABELS[member.guestAccess ?? 'chat'])} chevron onClick={() => go(`${COMPANION_PAGE}${member.actorId}`)} />)}
              </SettingsCard>
            </SettingsSection>}
            {manager && <SettingsCard>
              <SettingsRow media lead={<SettingsRowIcon><SlidersHorizontal size={16} aria-hidden /></SettingsRowIcon>} title={t(key('manage'))}
                hint={t(key(owner ? 'manageHintOwner' : 'manageHintAdmin'))} chevron onClick={() => go('manage')} />
            </SettingsCard>}
            <SettingsSection caption={group.supportsListRemoval !== true ? t('bots.groupChat.lifecycle.unavailable') : undefined}>
              <SettingsCard>
                <SettingsRow title={t('bots.groupChat.lifecycle.hide')} hint={t(key('hideHint'))} disabled={busy || group.supportsListRemoval !== true}
                  onClick={() => void confirmed({ type: 'hide' }, t('bots.groupChat.lifecycle.hide'), t('bots.groupChat.lifecycle.hideNote'), true)} />
                {canLeave && <SettingsRow danger title={t('bots.groupChat.lifecycle.leave')} hint={t(key(ownBots.length ? 'leaveRowHint' : 'leaveRowHintAlone'))} disabled={busy}
                  onClick={() => void confirmed({ type: 'member', actorId: me!.actorId!, action: 'leave' }, t('bots.groupChat.lifecycle.leave'), t(key('leaveHint')), true)} />}
                {/* The owner leaves only after handing the group to someone else. */}
                {owner && !canLeave && !soleOwner && <SettingsRow danger disabled title={t('bots.groupChat.lifecycle.leave')} hint={t(key('leaveBlocked'))} />}
              </SettingsCard>
            </SettingsSection>
          </>}
      </div>
    </>;
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div key={pageKey} className="flex animate-fade-in flex-col gap-6 px-5 pb-8 pt-5">
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {body}
      </div>
    </div>
    {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--border-default)] px-5 py-3">{footer}</div>}
    <ProfileEditDialog key={group.id} open={editingProfile} onOpenChange={profileOpenChange} avatarEditor={avatarEditor} />
  </div>;
}

/** Group mark, name, your role and the one 「邀请」 entry everyone shares. */
function Hero({ group, name, me, invite }: { group: BotGroupSummary; name: string; me?: BotGroupMemberView; invite: boolean }) {
  const { t } = useTranslation();
  const role = me?.role === 'owner' ? t(key('youAreOwner')) : me?.role === 'admin' ? t(key('youAreAdmin')) : null;
  return <div className="flex items-center gap-3">
    <BotGroupSidebarAvatar members={group.members} compact surface="panel" />
    <div className="min-w-0 flex-1">
      <p className="text-16 font-medium leading-[1.375] text-[var(--text-primary)] [overflow-wrap:anywhere]">{name}</p>
      <p className="mt-0.5 text-13 leading-[1.38] tabular-nums text-[var(--text-secondary)]">
        {t('bots.groupChat.memberCount', { count: group.members.length })}{role && ` · ${role}`}
      </p>
    </div>
    {invite && <ChatGroupInviteMenu group={group} variant="pill" />}
  </div>;
}

/** 群介绍: the topic first, then up to four lines of the description with 展开. */
function About({ topic, description, canEdit, onEdit }: { topic: string; description: string; canEdit: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [description, expanded]);
  if (!topic && !description) {
    if (!canEdit) return null;
    return <SettingsSection title={t(key('about'))}>
      <SettingsCard className="flex items-center gap-3 px-4 py-3.5">
        <p className="min-w-0 flex-1 text-13 leading-[1.54] text-[var(--text-secondary)] [text-wrap:pretty]">{t(key('aboutEmpty'))}</p>
        <Button variant="secondary" size="sm" onClick={onEdit}>{t(key('add'))}</Button>
      </SettingsCard>
    </SettingsSection>;
  }
  return <SettingsSection title={t(key('about'))} action={canEdit
    ? <Button variant="secondary" tone="quiet" size="xs" compact className="-mr-2" onClick={onEdit}>{t(key('edit'))}</Button> : undefined}>
    <SettingsCard className="px-4 py-3.5">
      {topic && <p className="text-14 font-medium leading-[1.43] text-[var(--text-primary)] [overflow-wrap:anywhere]">{topic}</p>}
      {description && <p ref={text} className={cn('whitespace-pre-wrap text-13 leading-[1.54] text-[var(--text-secondary)] [overflow-wrap:anywhere]', topic && 'mt-1', !expanded && 'line-clamp-4')}>{description}</p>}
      {description && (overflows || expanded) && <button type="button" onClick={() => setExpanded(value => !value)}
        className="mt-1.5 rounded text-13 font-medium leading-[1.38] text-[var(--text-primary)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        {t(key(expanded ? 'showLess' : 'showMore'))}</button>}
    </SettingsCard>
  </SettingsSection>;
}

/** The project folder as a pill: its name with the full path, 更换 and 清除 behind it. */
function ProjectFolder({ dir, busy, onChoose, onClear }: { dir: string | null; busy: boolean; onChoose: () => void; onClear: () => void }) {
  const { t } = useTranslation();
  const face = (label: string, muted: boolean) => <>
    <Folder size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
    <span className={cn('min-w-0 truncate', muted && 'text-[var(--text-secondary)]')}>{label}</span>
    <ChevronDown size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
  </>;
  const pill = 'max-w-[220px] gap-1.5 px-3 font-normal';
  // Without a folder there is nothing to show or clear: the pill opens the picker directly.
  if (!dir) return <Button variant="secondary" size="md" className={pill} disabled={busy} onClick={onChoose}>{face(t(key('ownFolder')), true)}</Button>;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="secondary" size="md" className={pill} disabled={busy} title={dir}>{face(botGroupPathBasename(dir), false)}</Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel className="break-all font-normal">{dir}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={onChoose}>{t(shared('projectDirChange'))}</DropdownMenuItem>
      <DropdownMenuItem className="items-start" onSelect={onClear}>
        <span className="flex min-w-0 flex-col">
          <span>{t(shared('projectDirClear'))}</span>
          <span className="text-12 font-normal leading-[1.42] text-[var(--text-secondary)]">{t(key('projectDirClearHint'))}</span>
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
