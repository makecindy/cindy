/**
 * 共享群（Chat Server）的群设置，与电脑端同一结构（docs/product-rules/bot-group-chat.md）：
 * 顶部群身份 + 唯一的「邀请」菜单，「群设置 | 成员」两个分段。群设置先放你自己的（我在本群、
 * 我的伙伴），群级默认收进只有群主和管理员能进的「群管理」；编辑群资料、本群资料、伙伴在
 * 本群、邀请伙伴都是同一个面板里的下一页。卡片里只放「名称 + 取值 / 箭头」，说明写在分组下；
 * 点不了的入口不摆出来，原因写进说明（mobile-design-guide §4）。
 *
 * 直连时读写走账号自己的聊天服务（`management`）；经电脑打开的群只能做电脑支持的那几项，
 * 其余入口不显示。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Check, Ellipsis, Plus, Reply, SlidersHorizontal, UserPlus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { BOT_GROUP_NAME_MAX_CHARS, type BotGroupMemberView, type BotGroupRemoteActionId, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { chatGroupMembership, isActiveBotGroupMember } from '@cindy/maker-shared/botGroupPresentation';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { chatMemberAvatar } from '@/chat/chatServerClient';
import { useChatClient } from '@/chat/useChatServer';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { showConfirm } from '@/platform/chrome';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_ROW_AVATAR_SIZE, BotGroupAvatar, BotGroupDuoAvatar, type BotGroupIdentity } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { BotGroupMenu } from './BotGroupMenu';
import { botGroupActionErrorText } from './botGroupCopy';
import { BOT_GROUP_TEAMMATES_COLLECTION_ID, botGroupMemberAvatar } from './botGroupRemote';
import { CompanionSheet } from './CompanionSheet';
import { FileBrowserSegmentedControl } from './FileBrowserSegmentedControl';
import { GroupMaskAvatar } from './GroupMaskControls';
import { pickGroupAvatar } from './groupAvatarPicker';
import { ActionInfoRow, SettingsGroup, SettingsSwitchRow } from './SettingsGroupRows';
import { useHostTeammates } from './useHostTeammates';
import { useCloudGroupCandidates, type GroupSettingsActionId, type useBotGroupSettingsManagement } from './useBotGroupSettingsManagement';
import type { GroupPersonalMask } from './useGroupPersonalMask';
import { useTeammateNavigation } from './useTeammateNavigation';

type Access = 'none' | 'chat' | 'tools';
const ACCESS: readonly Access[] = ['none', 'chat', 'tools'];
const ACCESS_LABEL = { none: 'accessNone', chat: 'accessChat', tools: 'accessTools' } as const;
const ACCESS_TITLE = { none: 'accessNoneTitle', chat: 'accessChatTitle', tools: 'accessToolsTitle' } as const;
const ACCESS_HINT = { none: 'accessNoneHint', chat: 'accessChatHint', tools: 'accessToolsHint' } as const;
const AVATAR_LARGE = 72;

type Page = { kind: 'home' | 'manage' | 'edit' | 'profile' | 'inviteBots' } | { kind: 'companion'; actorId: string };
type Act = (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>) => Promise<unknown>;
type Translate = (name: string, values?: Record<string, unknown>) => string;

export interface ChatGroupSettingsSheetProps {
  visible: boolean;
  group: BotGroupRemoteChatData;
  host: RemoteResourceHostTarget;
  identityFor: BotGroupIdentityLookup;
  online: boolean;
  /** Lifecycle (hide / leave / dissolve) and, through a computer, the settings it supports. */
  act: Act;
  /** Present when the phone talks to the chat service itself. */
  management?: ReturnType<typeof useBotGroupSettingsManagement>;
  mask?: GroupPersonalMask;
  onMask?(): void;
  onClose(): void;
  onClosed?(): void;
}

export function ChatGroupSettingsSheet({ visible, group, host, identityFor, online, act, management, mask, onMask, onClose, onClosed }: ChatGroupSettingsSheetProps) {
  const { t, i18n } = useTranslation();
  const k: Translate = (name, values) => t(`groupChat.groupSettings.${name}`, values);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { user, accountGeneration } = useAuth();
  const chat = useChatClient();
  const navigation = useTeammateNavigation();
  const direct = !!management;
  const membership = chatGroupMembership(group);
  const me = membership.self;
  const dissolved = !!group.dissolvedAt;
  const archived = !!group.archived;
  const owner = membership.owner && !dissolved;
  // A computer that predates role-checked settings decides who may change them, as before.
  const hostDecides = !direct && group.supportsSettingsManagement !== true;
  const manager = (membership.manager || hostDecides) && !dissolved;
  const canLeave = membership.canLeave && !dissolved;
  const soleOwner = me?.role === 'owner' && group.members.length === 1;
  const ownBots = group.members.filter(member => member.actorKind === 'bot' && member.isOwned === true && !!member.actorId);
  // Group-wide writes need an owner/admin you control, a connection, and a path that carries them.
  const writable = manager && online && !archived && (!direct || management.editable);
  // Your own identity and teammates' grants go to the chat service as yourself.
  const selfWritable = direct && online && !archived && !dissolved && management.ready;

  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [tab, setTab] = useState<'settings' | 'members'>('settings');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // An edit keeps the revision it started from; after a failed save the next one uses the latest.
  const [draft, setDraft] = useState({ name: '', topic: '', description: '', base: { name: '', topic: '', description: '' }, revision: group.revision, failed: false });
  const [nickname, setNickname] = useState('');
  // Each opening is its own scope: a reply to a request from an earlier opening changes nothing.
  const [opening, setOpening] = useState(0);
  useEffect(() => { if (visible) setOpening(count => count + 1); }, [visible]);
  const scope = `${accountGeneration}:${group.id}:${visible}:${opening}`;
  const live = useRef(scope); live.current = scope;
  useEffect(() => () => { live.current = ''; }, []);
  // A reopened sheet does not wait for a request the closed one started.
  useEffect(() => { busyRef.current = false; setBusy(false); }, [scope]);
  // A closed sheet opens again on its first page.
  useEffect(() => { if (!visible) { setPage({ kind: 'home' }); setTab('settings'); setError(''); setNotice(''); } }, [visible]);
  useEffect(() => { setError(''); }, [page]);
  const companion = page.kind === 'companion' ? ownBots.find(member => member.actorId === page.actorId) : undefined;
  // A page that no longer applies (no longer an admin, the teammate left, the group dissolved) closes itself.
  useEffect(() => {
    if ((page.kind === 'companion' && !companion) || ((page.kind === 'manage' || page.kind === 'edit') && !manager)
      || ((page.kind === 'profile' || page.kind === 'inviteBots') && dissolved)) setPage({ kind: 'home' });
  }, [page.kind, companion, manager, dissolved]);

  /** One write at a time; its error stays on the page that made it. */
  async function run(write: () => Promise<unknown>, fallbackKey = 'groupChat.groupSettings.saveFailed') {
    if (busyRef.current) return false;
    const captured = live.current;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await write(); return live.current === captured; }
    catch (failure) { if (live.current === captured) setError(botGroupActionErrorText(t, failure, fallbackKey)); return false; }
    finally { if (live.current === captured) { busyRef.current = false; setBusy(false); } }
  }
  // A computer with role-checked settings takes each write against the revision you saw.
  const throughComputer = (input: Record<string, unknown>) => group.supportsSettingsManagement ? { expectedRevision: group.revision, ...input } : input;
  const settings = (actionId: GroupSettingsActionId, input: Record<string, unknown> = {}) => run(() => management
    ? management.act(actionId, input) : act(actionId as BotGroupRemoteActionId, throughComputer(input)));
  async function confirmed(title: string, message: string, confirmLabel: string, write: () => Promise<unknown>) {
    const captured = live.current;
    if (!await showConfirm({ title, message, cancelLabel: t('devices.common.cancel'), confirmLabel, destructive: true }) || live.current !== captured) return;
    await run(write, 'groupChat.lifecycle.failed');
  }
  const lifecycle = (action: 'dissolve' | 'leave' | 'hide') => void confirmed(t(`groupChat.lifecycle.${action}`), t(`groupChat.lifecycle.${action}Note`),
    t(`groupChat.lifecycle.${action}`), () => act(action, action === 'dissolve' ? { expectedRevision: group.revision } : undefined));
  const home = () => setPage({ kind: 'home' });
  const openEdit = () => {
    const base = { name: group.name, topic: group.topic ?? '', description: group.description ?? '' };
    setDraft({ ...base, base, revision: group.revision, failed: false });
    setPage({ kind: 'edit' });
  };

  const identityOf = (member: BotGroupMemberView) => identityFor(member.botId, member.name);
  const avatar = (identity: BotGroupIdentity, size = BOT_GROUP_ROW_AVATAR_SIZE) =>
    <BotGroupAvatar deviceId={host.deviceId} identity={identity} size={size} online={online} />;

  // 邀请朋友: a join link from the owner or admin you control, in a system dialog with 复制.
  async function inviteFriends() {
    if (!management) return;
    let invite: { link: string; expiresAt: string | null; reusable?: boolean } | null = null;
    if (!await run(async () => { invite = await management.invite(); }) || !invite) return;
    const { link, expiresAt, reusable } = invite as { link: string; expiresAt: string | null; reusable?: boolean };
    const validity = reusable ? k('reusableLink') : k('singleUseUntil', { date: expiresAt ? new Date(expiresAt).toLocaleString(i18n.language) : '' });
    const captured = live.current;
    if (!await showConfirm({ title: k('inviteTitle'), message: `${k('inviteLinkNote')} ${validity}\n\n${link}`,
      cancelLabel: k('close'), confirmLabel: k('copy') }) || live.current !== captured) return;
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(link);
      if (live.current === captured) setNotice(k('copied'));
    }
    catch { if (live.current === captured) setError(k('copyFailed')); }
  }

  let title = t('groupChat.settings.title');
  let content: ReactNode;
  let trailing: { label: string; onPress(): void; disabled?: boolean; busy?: boolean; testID?: string } | undefined;
  let dirty = false;
  if (page.kind === 'manage') {
    title = k('manage');
    content = <ManagePage k={k} group={group} owner={owner} writable={writable} online={online} busy={busy} direct={direct}
      identityOf={identityOf} settings={settings} lifecycle={lifecycle} rename={direct ? undefined : openEdit}
      archive={archive => void confirmed(k(archive ? 'archive' : 'unarchive'), k(archive ? 'archiveHint' : 'unarchiveHint'), k(archive ? 'archive' : 'unarchive'),
        () => management ? management.act('archive', { archived: archive }) : act('delete', throughComputer({})))} />;
  } else if (page.kind === 'edit') {
    title = k('editTitle');
    // Only what you changed is sent, so a retry on the latest revision keeps others' concurrent edits.
    const name = draft.name.trim();
    const changes = { ...(name !== draft.base.name ? { name } : {}),
      ...(direct && draft.topic !== draft.base.topic ? { topic: draft.topic } : {}),
      ...(direct && draft.description !== draft.base.description ? { description: draft.description } : {}) };
    dirty = Object.keys(changes).length > 0;
    // A computer only renames the group; the topic and description are edited where they are stored.
    content = <EditPage k={k} draft={draft} full={direct} editable={writable && !busy} onChange={change => setDraft(current => ({ ...current, ...change }))} />;
    trailing = { label: k('save'), busy, disabled: !writable || !name, testID: 'botGroup.settings.editSave',
      onPress: () => { if (!Object.keys(changes).length) { home(); return; }
        void settings('update', { ...changes, expectedRevision: draft.failed ? group.revision : draft.revision })
          .then(ok => { if (ok) home(); else setDraft(current => ({ ...current, failed: true })); }); } };
  } else if (page.kind === 'profile' && me?.actorId) {
    title = k('myProfile');
    dirty = nickname.trim() !== (me.nickname ?? '');
    content = <ProfilePage k={k} me={me} identity={identityOf(me)} avatar={avatar} nickname={nickname} onNickname={setNickname}
      editable={selfWritable && !busy} canChangeAvatar={selfWritable && group.supportsMemberAvatar === true}
      changeAvatar={reset => void run(async () => {
        if (reset) { await management!.act('avatar', { actorId: me.actorId, avatar: null }); return; }
        const picked = await pickGroupAvatar();
        if (!picked) return;
        try { await management!.act('avatar', { actorId: me.actorId, avatar: await chat.uploadAvatar(picked) }); }
        finally { picked.release(); }
      }, 'groupChat.groupSettings.avatarFailed')} />;
    trailing = { label: k('save'), busy, disabled: !selfWritable, testID: 'botGroup.settings.profileSave',
      onPress: () => void settings('nickname', { actorId: me.actorId, nickname }).then(ok => { if (ok) home(); }) };
  } else if (page.kind === 'companion' && companion) {
    title = k('companionTitle', { name: companion.name });
    // The teammate's own tools live with it on its main computer; offer the way there only when it is known.
    const hosted = companion.homeDeviceId ? readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, BOT_GROUP_TEAMMATES_COLLECTION_ID)
      .find(row => row.host.deviceId === companion.homeDeviceId && row.item.ref.id === companion.botId) : undefined;
    content = <CompanionPage k={k} member={companion} identity={identityOf(companion)} avatar={avatar} editable={selfWritable && !busy}
      choose={access => void (async () => {
        const captured = live.current;
        if (access === 'tools' && (!await showConfirm({ title: k('authorizeTitle', { name: companion.name }), message: k('toolsHint'),
          cancelLabel: t('devices.common.cancel'), confirmLabel: k('confirm'), destructive: true }) || live.current !== captured)) return;
        await settings('bot-access', { actorId: companion.actorId, access, expectedRevision: companion.accessRevision });
      })()}
      openCapabilities={hosted ? () => { onClose(); void navigation.openTeammate(hosted, { settings: 'capabilities' }); } : undefined} />;
  } else if (page.kind === 'inviteBots') {
    title = k('inviteBotsItem');
    content = <InviteBotsPage k={k} group={group} host={host} direct={direct} visible={visible} online={online} busy={busy} avatar={avatar}
      add={(id, name) => void settings('add-member', direct ? { actorId: id } : { botId: id }).then(ok => {
        if (ok) { home(); setNotice(k('inviteBotsAdded', { name })); }
      })} />;
  } else {
    const count = group.members.length;
    const roleLabel = me?.role === 'owner' ? k('youAreOwner') : me?.role === 'admin' ? k('youAreAdmin') : '';
    const maskRow = !!onMask && !!mask?.state && !archived && !dissolved;
    const maskCompanion = mask?.state?.companions.find(item => item.id === mask.state?.settings.companionId);
    // Your own teammates join as yourself when direct; a computer adds them as a manager.
    const canInviteBots = direct ? selfWritable : writable;
    content = <>
      {management && (management.loading || management.reason === 'unavailable') ? <View style={styles.status} testID="botGroup.settings.management">
        {management.loading ? <ActivityIndicator size="small" color={colors.textSecondary} testID="botGroup.settings.connecting" /> : null}
        <Text style={[styles.statusText, styles.flex]} testID="botGroup.settings.managementStatus">
          {t(`groupChat.settings.cloudStatus.${management.loading ? 'loading' : 'unavailable'}`)}</Text>
        {!management.loading ? <Pressable accessibilityRole="button" onPress={() => void management.refresh()} style={styles.retry} testID="botGroup.settings.retry">
          <Text style={styles.retryText}>{t('groupChat.settings.retry')}</Text></Pressable> : null}
      </View> : null}
      <View style={styles.hero} testID="botGroup.settings.hero">
        <BotGroupDuoAvatar deviceId={host.deviceId} members={group.members.map(identityOf)} online={online} />
        <View style={styles.flex}>
          <Text accessibilityRole="header" style={styles.heroName}>{group.name}</Text>
          <Text style={styles.heroMeta}>{[t('groupChat.memberCount', { count }), roleLabel].filter(Boolean).join(' · ')}</Text>
        </View>
        {!dissolved && !archived && me?.actorId && (direct || canInviteBots) ? <BotGroupMenu title={k('inviteEntry')} accessibilityLabel={k('inviteEntry')}
          disabled={!online || busy} testID="botGroup.settings.invite"
          sections={[{ id: 'invite', options: [
            ...(direct ? [{ id: 'friends', title: k('inviteFriendsItem'), subtitle: k(group.canInvite ? 'inviteFriendsItemHint' : 'inviteFriendsLocked'), disabled: !group.canInvite }] : []),
            ...(canInviteBots ? [{ id: 'bots', title: k('inviteBotsItem'), subtitle: k('inviteBotsItemHint') }] : []),
          ] }]}
          onSelect={id => { if (id === 'friends') void inviteFriends(); else setPage({ kind: 'inviteBots' }); }}>
          {open => <Pressable accessibilityRole="button" accessibilityLabel={k('inviteEntry')} onPress={open} disabled={!online || busy}
            style={({ pressed }) => [styles.invite, pressed && mobileInteractionStyles.pressed, (!online || busy) && styles.inactive]} testID="botGroup.settings.inviteButton">
            <UserPlus size={iconSize.md} color={colors.textPrimary} />
            <Text style={styles.inviteLabel}>{k('inviteEntry')}</Text>
          </Pressable>}
        </BotGroupMenu> : null}
      </View>
      <FileBrowserSegmentedControl accessibilityLabel={t('groupChat.settings.title')} value={tab} onChange={next => setTab(next as typeof tab)} testID="botGroup.settings.tabs"
        options={[{ value: 'settings', label: k('tabSettings'), testID: 'botGroup.settings.tab.settings' },
          { value: 'members', label: `${t('groupChat.settings.members')} ${count}`, testID: 'botGroup.settings.tab.members' }]} />
      {tab === 'members'
        ? <MembersTab k={k} group={group} owner={owner} manager={writable} direct={direct} busy={busy} identityOf={identityOf} avatar={avatar}
          access={actorId => setPage({ kind: 'companion', actorId })}
          role={member => void settings('set-member-role', { actorId: member.actorId, role: member.role === 'admin' ? 'member' : 'admin' })}
          transfer={member => void confirmed(k('transferTitle', { name: member.name }), k('transferHint'), k('transfer'),
            () => management!.act('transfer', { actorId: member.actorId }))}
          remove={member => void confirmed(k('removeTitle', { name: member.name }), k('removeHint'), t('groupChat.settings.remove'),
            () => management ? management.act('remove-member', { actorId: member.actorId }) : act('remove-member', throughComputer({ actorId: member.actorId })))} />
        : <>
          {dissolved ? <Notice>{t('groupChat.lifecycle.dissolved')}</Notice> : null}
          {archived && !dissolved ? <Notice>{k('archived')}</Notice> : null}
          {soleOwner && !archived && !dissolved ? <Notice>{k('soleOwnerHint')}</Notice> : null}
          <About k={k} group={group} canEdit={writable} canFill={direct} onEdit={openEdit} />
          {!dissolved && me?.actorId && (direct || maskRow) ? <SettingsGroup title={k('me')} footer={maskRow ? k('maskHint') : null} testID="botGroup.settings.me">
            {direct ? <ActionInfoRow key="profile" lead={avatar(identityOf(me))} label={k('myProfile')} value={me.name} accessibilityLabel={k('myProfile')}
              onPress={() => { setNickname(me.nickname ?? ''); setPage({ kind: 'profile' }); }} testID="botGroup.settings.profile" /> : null}
            {maskRow ? <ActionInfoRow key="mask" testID="botGroup.settings.mask"
              lead={maskCompanion ? <GroupMaskAvatar self={mask!.state!.self} companion={maskCompanion} deviceId={host.deviceId} />
                : <RowIcon><Reply size={iconSize.md} color={colors.textSecondary} /></RowIcon>}
              label={t('groupChat.mask.title')} value={t(`groupChat.mask.status.${mask!.state!.status}`)} accessibilityLabel={t('groupChat.mask.title')} onPress={onMask} /> : null}
          </SettingsGroup> : null}
          {direct && !dissolved && !archived && ownBots.length ? <SettingsGroup title={k('myTeammates')} footer={k('myTeammatesCaption')} testID="botGroup.settings.myTeammates">
            {ownBots.map(member => <ActionInfoRow key={member.actorId} lead={avatar(identityOf(member))} label={member.name}
              value={k(member.status === 'paused' ? 'paused' : ACCESS_LABEL[member.guestAccess ?? 'chat'])} accessibilityLabel={member.name}
              onPress={() => setPage({ kind: 'companion', actorId: member.actorId! })} testID={`botGroup.settings.teammate.${member.botId}`} />)}
          </SettingsGroup> : null}
          {manager ? <SettingsGroup footer={k(owner ? 'manageHintOwner' : 'manageHintAdmin')} testID="botGroup.settings.manageGroup">
            <ActionInfoRow lead={<RowIcon><SlidersHorizontal size={iconSize.md} color={colors.textSecondary} /></RowIcon>} label={k('manage')}
              accessibilityLabel={k('manage')} onPress={() => setPage({ kind: 'manage' })} testID="botGroup.settings.manage" />
          </SettingsGroup> : null}
          {/* Your own exits. The owner leaves only after handing the group over, said under 移除 rather than a disabled row. */}
          {group.supportsListRemoval ? <SettingsGroup footer={k('hideHint')} testID="botGroup.settings.hideGroup"
            messages={[owner && !canLeave && !soleOwner && { text: k('leaveBlocked'), testID: 'botGroup.settings.leaveBlocked' }]}>
            <ActionInfoRow chevron={false} label={t('groupChat.lifecycle.hide')} accessibilityLabel={t('groupChat.lifecycle.hide')}
              disabled={!online || busy} onPress={() => lifecycle('hide')} testID="botGroup.settings.hide" />
          </SettingsGroup> : null}
          {canLeave && group.supportsGroupLeave ? <SettingsGroup footer={k(ownBots.length ? 'leaveRowHint' : 'leaveRowHintAlone')} testID="botGroup.settings.leaveGroup">
            <ActionInfoRow chevron={false} destructive label={t('groupChat.lifecycle.leave')} accessibilityLabel={t('groupChat.lifecycle.leave')}
              disabled={!online || busy} onPress={() => lifecycle('leave')} testID="botGroup.settings.leave" />
          </SettingsGroup> : null}
          {!group.supportsListRemoval || (canLeave && !group.supportsGroupLeave)
            ? <Text style={styles.note}>{t('groupChat.lifecycle.unavailable')}</Text> : null}
        </>}
    </>;
  }

  // An unsaved edit stays open until it is saved or the user goes Back.
  // Save sits under the form on both platforms: the iOS system sheet has no header slot for it.
  const footer = trailing ? <View style={styles.footer}>
    <MainWindowActionButton action={{ label: t('devices.common.cancel'), disabled: busy, onPress: home, testID: 'botGroup.settings.cancel' }} />
    <MainWindowActionButton action={{ ...trailing, tone: 'primary' }} />
  </View> : undefined;
  return <CompanionSheet visible={visible} title={title} onClose={() => { if (!dirty) onClose(); }} onClosed={onClosed} testID="botGroup.settings"
    preventDismiss={busy || dirty} onBack={page.kind !== 'home' ? home : undefined} footer={footer}>
    <View style={styles.content}>
      {error ? <Text accessibilityRole="alert" style={styles.error} testID="botGroup.settings.error">{error}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.note} testID="botGroup.settings.notice">{notice}</Text> : null}
      {content}
    </View>
  </CompanionSheet>;
}

/** 群介绍: the topic, then the description. Members see it read-only, and not at all when empty. */
function About({ k, group, canEdit, canFill, onEdit }: { k: Translate; group: BotGroupRemoteChatData; canEdit: boolean; canFill: boolean; onEdit(): void }) {
  const styles = useThemedStyles(makeStyles);
  const topic = group.topic?.trim() ?? '';
  const description = group.description?.trim() ?? '';
  if (!topic && !description && !(canEdit && canFill)) return null;
  const action = canEdit ? <Pressable accessibilityRole="button" accessibilityLabel={k(topic || description ? 'edit' : 'add')} onPress={onEdit}
    hitSlop={12} testID="botGroup.settings.editAbout"><Text style={styles.groupAction}>{k(topic || description ? 'edit' : 'add')}</Text></Pressable> : undefined;
  return <View style={styles.section} testID="botGroup.settings.about">
    <View style={styles.sectionHead}><Text accessibilityRole="header" style={styles.sectionTitle}>{k('about')}</Text>{action}</View>
    <View style={styles.card}>
      {topic || description ? <>
        {topic ? <Text selectable style={styles.aboutTopic}>{topic}</Text> : null}
        {description ? <Text selectable style={styles.aboutText}>{description}</Text> : null}
      </> : <Text style={styles.aboutText}>{k('aboutEmpty')}</Text>}
    </View>
  </View>;
}

function MembersTab({ k, group, owner, manager, direct, busy, identityOf, avatar, access, role, transfer, remove }: {
  k: Translate; group: BotGroupRemoteChatData; owner: boolean; manager: boolean; direct: boolean; busy: boolean;
  identityOf(member: BotGroupMemberView): BotGroupIdentity; avatar(identity: BotGroupIdentity): ReactNode;
  access(actorId: string): void; role(member: BotGroupMemberView): void; transfer(member: BotGroupMemberView): void; remove(member: BotGroupMemberView): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? group.members.filter(member => member.name.toLocaleLowerCase().includes(needle)) : group.members;
  return <>
    <TextInput value={query} onChangeText={setQuery} accessibilityLabel={k('searchMembers')} placeholder={k('searchMembers')}
      placeholderTextColor={colors.textPlaceholder} autoCorrect={false} returnKeyType="search" style={styles.search} testID="botGroup.settings.memberSearch" />
    {shown.length ? <View style={styles.card} testID="botGroup.settings.members">
      {shown.map((member, index) => {
        const bot = member.actorKind === 'bot';
        const mine = bot && member.isOwned === true && !!member.actorId;
        // Owners manage everyone but themselves; admins everyone but the owner. Ownership goes to a person.
        const manageable = manager && !member.isSelf && !!member.actorId && (owner || member.role !== 'owner');
        const transferable = direct && owner && manager && !!member.actorId && member.actorKind === 'human' && member.role !== 'owner';
        const options = [
          ...(mine && direct ? [{ id: 'access', title: k('accessMenu') }] : []),
          ...(manageable && direct ? [{ id: 'role', title: t(member.role === 'admin' ? 'groupChat.settings.removeAdmin' : 'groupChat.settings.makeAdmin') }] : []),
          ...(transferable ? [{ id: 'transfer', title: k('transfer') }] : []),
          ...(manageable && (direct || group.supportsMemberRemoval) ? [{ id: 'remove', title: t('groupChat.settings.remove'), destructive: true }] : []),
        ];
        const paused = !isActiveBotGroupMember(member);
        const meta = bot ? `${k('teammateTag')} · ${k(paused ? 'paused' : ACCESS_LABEL[member.guestAccess ?? 'chat'])}` : t(`groupChat.settings.roles.${member.role ?? 'member'}`);
        // With a native menu the system opens it from the row; the fallback sheet passes `open`.
        const row = (menu: boolean, open?: () => void) => <Pressable accessibilityRole={menu ? 'button' : undefined} accessibilityLabel={`${member.name}, ${meta}`}
          disabled={!menu || busy} onPress={open} style={({ pressed }) => [styles.memberRow, pressed && menu && mobileInteractionStyles.pressed]}
          testID={`botGroup.settings.member.${member.botId}`}>
          <View style={paused ? styles.inactive : undefined}>{avatar(identityOf(member))}</View>
          <View style={styles.flex}>
            <View style={styles.nameLine}>
              <Text numberOfLines={1} style={styles.rowTitle}>{member.name}</Text>
              {member.isSelf ? <Text style={styles.tag}>{k('you')}</Text> : null}
            </View>
            <Text numberOfLines={1} style={styles.rowMeta}>{meta}</Text>
          </View>
          {menu ? <Ellipsis size={iconSize.lg} color={colors.textTertiary} /> : null}
          {index < shown.length - 1 ? <View style={styles.memberDivider} /> : null}
        </Pressable>;
        if (!options.length || group.dissolvedAt) return <View key={member.botId}>{row(false)}</View>;
        return <BotGroupMenu key={member.botId} title={member.name} disabled={busy} accessibilityLabel={member.name}
          testID={`botGroup.settings.memberMenu.${member.botId}`} sections={[{ id: 'member', options }]}
          onSelect={id => { if (id === 'access') access(member.actorId!); else if (id === 'role') role(member); else if (id === 'transfer') transfer(member); else remove(member); }}>
          {open => row(true, open)}
        </BotGroupMenu>;
      })}
    </View> : <Text style={styles.empty}>{k('membersNoMatch', { query: query.trim() })}</Text>}
  </>;
}

function ManagePage({ k, group, owner, writable, online, busy, direct, identityOf, settings, lifecycle, archive, rename }: {
  k: Translate; group: BotGroupRemoteChatData; owner: boolean; writable: boolean; online: boolean; busy: boolean; direct: boolean;
  identityOf(member: BotGroupMemberView): BotGroupIdentity;
  settings(actionId: GroupSettingsActionId, input: Record<string, unknown>): Promise<boolean>;
  lifecycle(action: 'dissolve'): void; archive(archive: boolean): void;
  /** Through a computer the group name is the one 群资料 field the phone can change. */
  rename?(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const choice = <T extends string>(label: string, value: T, options: Array<{ id: T; title: string }>, field: string, testID: string) =>
    <BotGroupMenu title={label} accessibilityLabel={label} disabled={!writable || busy} testID={testID}
      sections={[{ id: field, options: options.map(option => ({ ...option, selected: option.id === value })) }]}
      onSelect={id => { if (id !== value) void settings('update', { [field]: id }); }}>
      {open => <ActionInfoRow label={label} value={options.find(option => option.id === value)?.title ?? ''} accessibilityLabel={label}
        disabled={!writable || busy} onPress={open} testID={`${testID}.row`} />}
    </BotGroupMenu>;
  // Early groups do not tag kinds; every member there is a teammate.
  const companions = group.members.filter(member => (!member.actorKind || member.actorKind === 'bot') && isActiveBotGroupMember(member));
  if (group.archived) return <>
    <Notice>{k('archived')}</Notice>
    {/* Archived groups are read-only here; only 取消归档 remains, which a computer cannot carry. */}
    {online && direct ? <SettingsGroup footer={k('unarchiveRowHint')}>
      <ActionInfoRow chevron={false} label={k('unarchive')} accessibilityLabel={k('unarchive')} disabled={busy} onPress={() => archive(false)} testID="botGroup.settings.unarchive" />
    </SettingsGroup> : null}
  </>;
  return <>
    {rename ? <SettingsGroup>
      <ActionInfoRow label={k('name')} value={group.name} accessibilityLabel={k('name')} disabled={!writable || busy} onPress={rename} testID="botGroup.settings.rename" />
    </SettingsGroup> : null}
    <SettingsGroup title={k('replies')} footer={group.replyMode === 'all'
      ? t(group.singleSpeaker ? 'groupChat.settings.replyModeNoteQueue' : 'groupChat.settings.replyModeNote') : k('replyModeMentionedNote')}>
      {choice(t('groupChat.settings.replyMode'), group.replyMode, [
        { id: 'mentioned', title: t('groupChat.settings.replyModeMentioned') }, { id: 'all', title: t('groupChat.settings.replyModeAll') },
      ], 'replyMode', 'botGroup.settings.replyMode')}
    </SettingsGroup>
    {group.supportsMentionAudiences && owner ? <SettingsGroup footer={t('groupChat.settings.allowMentionAllBotsHint')}>
      <SettingsSwitchRow label={t('groupChat.settings.allowMentionAllBots')} value={group.allowMentionAllBots === true}
        disabled={!writable || busy} switchTestID="botGroup.settings.allowMentionAllBots"
        onValueChange={allowMentionAllBots => { void settings('update', { allowMentionAllBots }); }} />
    </SettingsGroup> : null}
    {/* Single-speaker servers always answer one teammate at a time, so there is no speaking mode. */}
    {group.singleSpeaker ? null : <SettingsGroup footer={t(group.speakingMode === 'sequential' ? 'groupChat.settings.speakingModeSequentialNote' : 'groupChat.settings.speakingModeAutoNote')}>
      {choice(t('groupChat.settings.speakingMode'), group.speakingMode, [
        { id: 'auto', title: t('groupChat.settings.speakingModeAuto') }, { id: 'sequential', title: t('groupChat.settings.speakingModeSequential') },
      ], 'speakingMode', 'botGroup.settings.speakingMode')}
    </SettingsGroup>}
    {companions.length ? <SettingsGroup title={k('work')} footer={`${k('organizerHint')}${k('projectDirOnComputer')}`}>
      {choice(t('groupChat.organizer'), group.organizerBotId ?? '', companions.map(member => ({ id: member.botId, title: identityOf(member).name || member.name })),
        'organizerBotId', 'botGroup.settings.organizer')}
      {group.projectDirName !== undefined && !direct ? <ActionInfoRow chevron={false} label={t('groupChat.settings.projectDir')}
        value={group.projectDirName ?? k('ownFolder')} accessibilityLabel={t('groupChat.settings.projectDir')} testID="botGroup.settings.projectDir" /> : null}
    </SettingsGroup> : null}
    <SettingsGroup footer={k('archiveRowHint')}>
      <ActionInfoRow chevron={false} label={k('archive')} accessibilityLabel={k('archive')} disabled={!writable || busy} onPress={() => archive(true)} testID="botGroup.settings.archive" />
    </SettingsGroup>
    {owner ? group.supportsDissolve ? <SettingsGroup footer={k('dissolveRowHint')}>
      <ActionInfoRow chevron={false} destructive label={t('groupChat.lifecycle.dissolve')} accessibilityLabel={t('groupChat.lifecycle.dissolve')}
        disabled={!online || busy} onPress={() => lifecycle('dissolve')} testID="botGroup.settings.dissolve" />
    </SettingsGroup> : <Text style={styles.note}>{t('groupChat.lifecycle.unavailable')}</Text> : null}
    <Text style={[styles.note, styles.centered]}>{k('manageCaption')}</Text>
  </>;
}

function EditPage({ k, draft, full, editable, onChange }: {
  k: Translate; draft: { name: string; topic: string; description: string }; full: boolean; editable: boolean;
  onChange(change: Partial<{ name: string; topic: string; description: string }>): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const field = (label: string, input: ReactNode, hint?: string) => <View style={styles.section}>
    <Text style={styles.sectionTitle}>{label}</Text>{input}{hint ? <Text style={styles.note}>{hint}</Text> : null}
  </View>;
  return <>
    {field(k('name'), <TextInput accessibilityLabel={k('name')} value={draft.name} maxLength={BOT_GROUP_NAME_MAX_CHARS} editable={editable}
      onChangeText={name => onChange({ name })} placeholderTextColor={colors.textPlaceholder} style={styles.input} testID="botGroup.settings.name" />)}
    {full ? field(k('topic'), <TextInput accessibilityLabel={k('topic')} value={draft.topic} maxLength={250} editable={editable}
      onChangeText={value => onChange({ topic: value })} placeholderTextColor={colors.textPlaceholder} style={styles.input} testID="botGroup.settings.topic" />, k('topicHint')) : null}
    {full ? field(k('description'), <TextInput accessibilityLabel={k('description')} value={draft.description} maxLength={2000} multiline editable={editable}
      onChangeText={description => onChange({ description })} style={[styles.input, styles.multiline]} testID="botGroup.settings.description" />, k('descriptionHint')) : null}
  </>;
}

function ProfilePage({ k, me, identity, avatar, nickname, onNickname, editable, canChangeAvatar, changeAvatar }: {
  k: Translate; me: BotGroupMemberView; identity: BotGroupIdentity; avatar(identity: BotGroupIdentity, size?: number): ReactNode;
  nickname: string; onNickname(value: string): void; editable: boolean; canChangeAvatar: boolean; changeAvatar(reset: boolean): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <>
    <View style={styles.profileHead}>
      {/* The member's avatar is already this group's photo when one is set. */}
      {avatar(identity, AVATAR_LARGE)}
      {canChangeAvatar ? <BotGroupMenu title={k('changeAvatar')} accessibilityLabel={k('changeAvatar')} disabled={!editable} testID="botGroup.settings.avatar"
        sections={[{ id: 'avatar', options: [{ id: 'pick', title: k('changeAvatar') }, ...(me.groupAvatar ? [{ id: 'reset', title: k('resetAvatar') }] : [])] }]}
        onSelect={id => changeAvatar(id === 'reset')}>
        {open => <Pressable accessibilityRole="button" accessibilityLabel={k('changeAvatar')} onPress={open} disabled={!editable} hitSlop={8}
          testID="botGroup.settings.avatarButton"><Text style={[styles.linkLabel, !editable && styles.inactive]}>{k('changeAvatar')}</Text></Pressable>}
      </BotGroupMenu> : null}
      {canChangeAvatar ? <Text style={[styles.note, styles.centered]}>{k('groupAvatarHint')}</Text> : null}
    </View>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{k('nickname')}</Text>
      <TextInput accessibilityLabel={k('nickname')} value={nickname} maxLength={40} editable={editable} placeholder={me.displayName ?? me.name}
        onChangeText={onNickname} placeholderTextColor={colors.textPlaceholder} style={styles.input} testID="botGroup.settings.nickname" />
      <Text style={styles.note}>{k('nicknameHint')}</Text>
    </View>
  </>;
}

function CompanionPage({ k, member, identity, avatar, editable, choose, openCapabilities }: {
  k: Translate; member: BotGroupMemberView; identity: BotGroupIdentity; avatar(identity: BotGroupIdentity): ReactNode;
  editable: boolean; choose(access: Access): void; openCapabilities?(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const current = member.guestAccess ?? 'chat';
  const locked = !editable || member.accessRevision === undefined;
  return <>
    <View style={styles.hero}>
      {avatar(identity)}
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{member.name}</Text>
        <Text style={styles.rowMeta}>{k('yourTeammate')}</Text>
      </View>
    </View>
    <SettingsGroup title={k('accessQuestion', { name: member.name })} footer={k(ACCESS_HINT[current], { name: member.name })} testID="botGroup.settings.access">
      {ACCESS.map(access => <Pressable key={access} accessibilityRole="radio" accessibilityState={{ checked: access === current, disabled: locked }}
        disabled={locked} onPress={() => { if (access !== current) choose(access); }} testID={`botGroup.settings.access.${access}`}
        style={({ pressed }) => [styles.choiceRow, pressed && mobileInteractionStyles.pressed, locked && styles.inactive]}>
        <Text style={[styles.rowTitle, styles.flex]}>{k(ACCESS_TITLE[access])}</Text>
        {access === current ? <Check size={iconSize.lg} color={colors.textPrimary} /> : null}
      </Pressable>)}
    </SettingsGroup>
    {openCapabilities ? <SettingsGroup footer={k('capabilityScope', { name: member.name })}>
      <ActionInfoRow label={k('capabilitiesRow', { name: member.name })} accessibilityLabel={k('capabilitiesRow', { name: member.name })}
        onPress={openCapabilities} testID="botGroup.settings.capabilities" />
    </SettingsGroup> : null}
  </>;
}

/** Your teammates not in the group yet: one searchable page, tap to add. */
function InviteBotsPage({ k, group, host, direct, visible, online, busy, avatar, add }: {
  k: Translate; group: BotGroupRemoteChatData; host: RemoteResourceHostTarget; direct: boolean; visible: boolean; online: boolean; busy: boolean;
  avatar(identity: BotGroupIdentity): ReactNode; add(id: string, name: string): void;
}) {
  const { i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState('');
  const cloud = useCloudGroupCandidates(visible);
  const computer = useHostTeammates(host, !direct && visible, query);
  const local = direct ? [] : computer.rows.map(row => ({ id: row.item.ref.id, actorId: undefined as string | undefined,
    name: resolveRemoteText(row.item.display.title, i18n.language), avatar: row.item.display.avatar, avatarUrl: undefined as string | undefined }));
  // A computer also adds your teammates whose main computer is another one, by their stable external id.
  const remote = cloud.rows.filter(row => direct || (row.externalId && row.homeDeviceId && row.homeDeviceId !== host.deviceId
    && !local.some(item => item.id === row.externalId))).map(row => {
    const image = chatMemberAvatar(row.avatar);
    return { id: direct ? row.id : row.externalId, actorId: row.id as string | undefined, name: row.name,
      avatar: botGroupMemberAvatar({ ...image, name: row.name, avatarColor: '' }), avatarUrl: image.avatarUrl };
  });
  const rows = [...local, ...remote];
  const inGroup = new Set(group.members.flatMap(member => [member.actorId, member.botId]));
  const addable = rows.filter(row => !inGroup.has(row.id) && !(row.actorId && inGroup.has(row.actorId)));
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? addable.filter(row => row.name.toLocaleLowerCase().includes(needle)) : addable;
  const loading = cloud.loading || (!direct && computer.loading);
  const failed = cloud.failed || (!direct && computer.failed);
  return <>
    <TextInput value={query} onChangeText={setQuery} accessibilityLabel={k('searchTeammates')} placeholder={k('searchTeammates')}
      placeholderTextColor={colors.textPlaceholder} autoCorrect={false} returnKeyType="search" style={styles.search} testID="botGroup.settings.inviteSearch" />
    {loading && !addable.length ? <ActivityIndicator color={colors.textSecondary} style={styles.spinner} /> : null}
    {!loading && !shown.length ? <Text style={styles.empty}>{failed ? k('saveFailed')
      : needle && addable.length ? k('inviteBotsNoMatch', { query: query.trim() }) : rows.length ? k('inviteBotsAllIn') : k('noTeammates')}</Text> : null}
    {shown.length ? <View style={styles.card} testID="botGroup.settings.inviteBots">
      {shown.map((row, index) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={row.name} disabled={!online || busy}
        onPress={() => add(row.id, row.name)} style={({ pressed }) => [styles.memberRow, pressed && mobileInteractionStyles.pressed]}
        testID={`botGroup.settings.inviteBot.${row.id}`}>
        {avatar({ botId: row.id, name: row.name, avatar: row.avatar, avatarUrl: row.avatarUrl })}
        <Text numberOfLines={1} style={[styles.rowTitle, styles.flex]}>{row.name}</Text>
        <Plus size={iconSize.lg} color={colors.textTertiary} />
        {index < shown.length - 1 ? <View style={styles.memberDivider} /> : null}
      </Pressable>)}
    </View> : null}
  </>;
}

function Notice({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.card} accessibilityLiveRegion="polite"><Text style={styles.aboutText}>{children}</Text></View>;
}

function RowIcon({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.rowIcon}>{children}</View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  flex: { flex: 1, minWidth: 0 },
  inactive: { opacity: 0.6 },
  centered: { textAlign: 'center' },
  status: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  retry: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  retryText: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroName: { color: colors.textPrimary, fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium },
  heroMeta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  invite: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md,
    borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  inviteLabel: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  section: { gap: spacing.sm },
  sectionHead: { minHeight: spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md },
  sectionTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, paddingHorizontal: spacing.md },
  groupAction: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container,
    overflow: 'hidden', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  aboutTopic: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  aboutText: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  search: { minHeight: 44, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, paddingHorizontal: spacing.lg,
    color: colors.textPrimary, fontSize: typeScale.bodySmall },
  memberRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg },
  memberDivider: { position: 'absolute', left: spacing.lg + BOT_GROUP_ROW_AVATAR_SIZE + spacing.md, right: 0, bottom: 0,
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, minWidth: 0 },
  rowTitle: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  tag: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  rowMeta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  rowIcon: { width: BOT_GROUP_ROW_AVATAR_SIZE, height: BOT_GROUP_ROW_AVATAR_SIZE, borderRadius: radius.pill, backgroundColor: colors.surfaceChip,
    alignItems: 'center', justifyContent: 'center' },
  choiceRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg,
    color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  multiline: { minHeight: 120, borderRadius: radius.container, paddingVertical: spacing.md, textAlignVertical: 'top', lineHeight: lineHeight.body },
  profileHead: { alignItems: 'center', gap: spacing.sm },
  linkLabel: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  spinner: { paddingVertical: spacing.md },
  empty: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center', paddingVertical: spacing.lg },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.md },
  error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.md },
});
