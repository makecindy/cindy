/** 群设置由管理电脑保存；项目文件夹仅可查看。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, Ellipsis, Folder, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  BOT_GROUP_NAME_MAX_CHARS,
  type BotGroupRemoteActionId,
  type BotGroupRemoteChatData,
  type BotGroupReplyMode,
  type BotGroupSpeakingMode,
} from '@cindy/maker-shared/botGroupChat';
import { chatGroupMembership, isActiveBotGroupMember } from '@cindy/maker-shared/botGroupPresentation';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { showConfirm } from '@/platform/chrome';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_ROW_AVATAR_SIZE, BotGroupAvatar, useBotGroupIdentities } from './BotGroupAvatars';
import { BotGroupOrganizerTag, type BotGroupIdentityLookup } from './BotGroupPlan';
import { botGroupActionErrorText } from './botGroupCopy';
import { CompanionSheet } from './CompanionSheet';
import { useHostTeammates } from './useHostTeammates';
import { BotGroupMenu } from './BotGroupMenu';
import { useBotGroupSettingsManagement } from './useBotGroupSettingsManagement';
import { canManageBotGroup } from './botGroupRemote';

type Busy = 'name' | 'members' | 'organizer' | 'replyMode' | 'speakingMode' | 'delete' | 'lifecycle' | null;
type Act = (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>) => Promise<unknown>;

type SettingsProps = {
  visible: boolean;
  readOnly?: boolean;
  group: BotGroupRemoteChatData;
  host: RemoteResourceHostTarget;
  identityFor: BotGroupIdentityLookup;
  online: boolean;
  act: Act;
  onClose(): void;
  onClosed?(): void;
  /** The group is gone; the screen leaves once the sheet has closed. */
  onDeleted(): void;
  onRefresh?(): void;
};

/** Server chat remains direct; only the open settings sheet resolves a management host. */
export function BotGroupSettingsSheet(props: SettingsProps) {
  return props.readOnly ? <ServerGroupSettings {...props} /> : <BotGroupSettingsContent {...props} />;
}

function ServerGroupSettings(props: SettingsProps) {
  const management = useBotGroupSettingsManagement(props.group.id, props.visible);
  const host = management.selected?.host ?? props.host;
  const group = management.selected?.group ?? props.group;
  const lookup = useBotGroupIdentities(host.deviceId);
  return <BotGroupSettingsContent {...props} group={group} host={host}
    identityFor={(id, name) => lookup(id, name, group.members.find(member => member.botId === id))}
    online={!!management.selected && !management.loading} readOnly={!management.selected || management.loading}
    act={async (action, input) => { const receipt = await management.act(action, input); props.onRefresh?.(); return receipt; }}
    management={management} lifecycle={props} />;
}

function BotGroupSettingsContent({ visible, group, host, identityFor, online, act, onClose, onClosed, onDeleted, readOnly = false, management, lifecycle }: SettingsProps & {
  management?: ReturnType<typeof useBotGroupSettingsManagement>;
  lifecycle?: SettingsProps;
}) {
  const { t, i18n } = useTranslation();
  const { accountGeneration } = useAuth();
  const lifecycleProps = lifecycle ?? { visible, group, host, online, act, onDeleted };
  const lifecycleGroup = lifecycleProps.group;
  const membership = chatGroupMembership(lifecycleGroup);
  const scope = useMemo(() => ({ accountGeneration, groupId: lifecycleGroup.id, deviceId: lifecycleProps.host.deviceId, visible }),
    [accountGeneration, lifecycleGroup.id, lifecycleProps.host.deviceId, visible]);
  const active = useRef<typeof scope | null>(scope); active.current = scope;
  useEffect(() => () => { active.current = null; }, []);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const [errors, setErrors] = useState<Partial<Record<Exclude<Busy, null>, string>>>({});
  useEffect(() => { busyRef.current = null; setBusy(null); setErrors({}); }, [scope]);
  const [picking, setPicking] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const serverManaged = group.serverBacked === true && group.supportsSettingsManagement === true;
  const nameFocused = useRef(false);
  const nameDirty = useRef(false);
  const nameRevision = useRef(group.revision);
  const teammates = useHostTeammates(host, visible && picking && !readOnly, serverManaged ? memberQuery : '');

  // Follow renames that land from the computer while the field is not being edited.
  useEffect(() => { if (!nameFocused.current && !nameDirty.current) setName(group.name); }, [group.name]);
  useEffect(() => { if (!visible) { setPicking(false); setErrors({}); } }, [visible]);

  useEffect(() => { if (!picking) setMemberQuery(''); }, [picking]);

  const memberIds = group.members.map((member) => member.botId);

  const { owner } = chatGroupMembership(group);
  const leavesGroup = group.serverBacked === true && management === undefined && !owner;
  const archivesGroup = (serverManaged && !leavesGroup) || management !== undefined;
  const canRemove = serverManaged || group.members.length > BOT_GROUP_MIN_MEMBERS;
  const canAdd = serverManaged || group.members.length < BOT_GROUP_MAX_MEMBERS;
  const addable = teammates.rows.filter((row) => !memberIds.includes(row.item.ref.id));
  const permissionLocked = serverManaged && !canManageBotGroup(group);
  const unavailable = readOnly || permissionLocked || !online || !!lifecycleGroup.dissolvedAt;
  const locked = unavailable || busy !== null;
  const deleteLocked = leavesGroup ? readOnly || !online || busy !== null : locked || (serverManaged && !owner);

  const run = async (section: Exclude<Busy, null>, actionId: BotGroupRemoteActionId, input: Record<string, unknown>, fallbackKey: string) => {
    const leaving = actionId === 'delete' && leavesGroup;
    if (readOnly || (permissionLocked && !leaving) || !online || busyRef.current) return false;
    const captured = scope;
    busyRef.current = section;
    setBusy(section);
    setErrors((current) => ({ ...current, [section]: undefined }));
    try {
      await act(actionId, serverManaged && !leaving ? { expectedRevision: group.revision, ...input } : input);
      // Legacy deletion reports success to the owning screen even if this sheet unmounted.
      return true;
    } catch (error) {
      if (active.current === captured) setErrors((current) => ({ ...current, [section]: botGroupActionErrorText(t, error, fallbackKey) }));
      return false;
    } finally {
      if (active.current === captured) { busyRef.current = null; setBusy(null); }
    }
  };

  const saveName = async () => {
    if (!nameDirty.current) { setName(group.name); return; }
    if (readOnly) return;
    const trimmed = name.trim();
    if (!trimmed) { nameDirty.current = false; setName(group.name); return; }
    if (trimmed === group.name) { nameDirty.current = false; return; }
    if (errors.name) nameRevision.current = group.revision;
    const saved = await run('name', 'update', { name: trimmed, ...(serverManaged ? { expectedRevision: nameRevision.current } : {}) }, 'groupChat.settings.nameSaveFailed');
    if (saved) nameDirty.current = false;
  };

  const setMembers = async (botIds: string[]) => {
    const saved = await run('members', 'set-members', { botIds }, 'groupChat.settings.membersSaveFailed');
    if (saved) setPicking(false);
  };

  const remove = async () => {
    if (busyRef.current) return;
    const confirmed = await showConfirm({
      title: t(archivesGroup ? 'groupChat.settings.archiveConfirmTitle' : 'groupChat.settings.deleteConfirmTitle', { name: group.name }),
      message: t(archivesGroup ? 'groupChat.settings.archiveNote' : 'groupChat.settings.deleteNote'),
      cancelLabel: t('devices.common.cancel'),
      confirmLabel: t(archivesGroup ? 'groupChat.settings.archive' : 'groupChat.settings.delete'),
      destructive: true,
    });
    if (!confirmed) return;
    if (await run('delete', 'delete', {}, 'groupChat.settings.deleteFailed')) onDeleted();
  };

  const runLifecycle = async (action: 'dissolve' | 'leave' | 'hide') => {
    if (busyRef.current || !visible || !lifecycleProps.online) return;
    const captured = scope;
    busyRef.current = 'lifecycle'; setBusy('lifecycle');
    try {
      if (!await showConfirm({ title: t(`groupChat.lifecycle.${action}`), message: t(`groupChat.lifecycle.${action}Note`),
        cancelLabel: t('devices.common.cancel'), confirmLabel: t(`groupChat.lifecycle.${action}`), destructive: true }) || active.current !== captured) return;
      await lifecycleProps.act(action, action === 'dissolve' ? { expectedRevision: lifecycleGroup.revision } : undefined);
      // The owning screen completes hide/leave navigation even if this sheet unmounted.
    } catch (error) {
      if (active.current === captured) setErrors(current => ({ ...current, lifecycle: botGroupActionErrorText(t, error, 'groupChat.lifecycle.failed') }));
    } finally { if (active.current === captured) { busyRef.current = null; setBusy(null); } }
  };

  const error = (section: Exclude<Busy, null>) => errors[section]
    ? <Text accessibilityRole="alert" style={styles.error}>{errors[section]}</Text>
    : null;

  const segmented = <T extends string>(section: 'replyMode' | 'speakingMode', value: T, options: { value: T; label: string }[]) =>
    <View style={styles.segments} accessibilityRole="tablist">
      {options.map((option) => <MainWindowOptionButton key={option.value} accessibilityRole="tab" density="default" variant="segmented"
        label={option.label} selected={option.value === value} disabled={locked}
        onPress={() => { if (option.value !== value) void run(section, 'update', { [section]: option.value }, `groupChat.settings.${section}SaveFailed`); }}
        style={[styles.segment, unavailable && styles.inheritedInactive]} testID={`botGroup.settings.${section}.${option.value}`} />)}
    </View>;

  return <CompanionSheet visible={visible} title={t('groupChat.settings.title')} onClose={onClose} onClosed={onClosed}
    preventDismiss={busy !== null} testID="botGroup.settings">
    <View style={styles.content}>
      {management ? <View style={styles.managementRow} testID="botGroup.settings.management">
        {management.managers.length > 1 ? <View style={styles.computerSlot}><BotGroupMenu title={t('groupChat.settings.managementComputer')} disabled={busy !== null}
          testID="botGroup.settings.computerMenu" sections={[{ id: 'computers', options: management.managers.map(manager => ({
            id: manager.host.deviceId, title: manager.host.deviceName,
          })) }]} onSelect={management.select}>
          {open => <Pressable accessibilityRole="button" disabled={busy !== null} onPress={open} style={styles.computerPicker}>
            <Text numberOfLines={1} style={[styles.managementText, styles.flex]}>{management.selected?.host.deviceName}</Text>
            <ChevronDown size={iconSize.sm} color={colors.textSecondary} />
          </Pressable>}
        </BotGroupMenu></View> : <Text numberOfLines={1} style={[styles.managementText, styles.flex]} testID="botGroup.settings.computerName">
          {management.displayHost?.deviceName ?? t('groupChat.settings.managementComputer')}
        </Text>}
        {management.loading ? <ActivityIndicator size="small" color={colors.textSecondary} testID="botGroup.settings.connecting" />
          : !unavailable ? <View style={styles.connectedDot} testID="botGroup.settings.connectedDot" /> : null}
        <Text style={styles.managementText} testID="botGroup.settings.managementStatus">
          {t(`groupChat.settings.managementStatus.${management.loading ? 'loading' : !unavailable ? 'ready' : management.reason ?? 'unavailable'}`)}
        </Text>
        {unavailable && !management.loading ? <Pressable accessibilityRole="button" onPress={management.refresh}
          style={styles.reconnect} testID="botGroup.settings.retry">
          <Text style={styles.reconnectText}>{t(management.reason === 'noHost' || management.reason === 'unavailable'
            ? 'groupChat.settings.reconnect' : 'groupChat.settings.retry')}</Text>
        </Pressable> : null}
      </View> : null}
      <View style={[styles.settingsBody, unavailable && styles.inactive]} testID="botGroup.settings.body">
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.create.nameLabel')}</Text>
        <TextInput accessibilityLabel={t('groupChat.create.nameLabel')} value={name} maxLength={BOT_GROUP_NAME_MAX_CHARS}
          editable={!locked} returnKeyType="done"
          onChangeText={(value) => { if (!nameDirty.current || errors.name) nameRevision.current = group.revision;
            nameDirty.current = true; setName(value); setErrors((current) => ({ ...current, name: undefined })); }}
          onFocus={() => { nameFocused.current = true; }}
          onBlur={() => { nameFocused.current = false; void saveName(); }}
          onSubmitEditing={() => void saveName()}
          placeholderTextColor={colors.textPlaceholder} style={styles.input} testID="botGroup.settings.name" />
        {error('name')}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.settings.members')}</Text>
        <View style={styles.group}>
          {group.members.map((member) => {
            const identity = identityFor(member.botId, member.name);
            const active = isActiveBotGroupMember(member);
            const canOrganize = active && (!member.actorKind || member.actorKind === 'bot');
            const removable = canRemove && (!member.actorKind || member.actorKind === 'bot' || group.supportsMemberRemoval === true)
              && (!serverManaged || (!member.isSelf && (owner || member.role !== 'owner')));
            const organizer = member.botId === group.organizerBotId;
            const options = [
              ...(!organizer && canOrganize ? [{ id: `organizer:${member.botId}`, title: t('groupChat.settings.setOrganizer') }] : []),
              {
                id: `remove:${member.botId}`, title: t('groupChat.settings.remove'), destructive: true, disabled: !removable,
                ...(canRemove ? {} : { subtitle: t('groupChat.settings.minMembers', { min: BOT_GROUP_MIN_MEMBERS }) }),
              },
            ];
            const rowBusy = busy === 'organizer' || busy === 'members';
            return <BotGroupMenu key={member.botId} title={identity.name} disabled={locked}
              accessibilityLabel={t('groupChat.settings.memberActions', { name: identity.name })}
              testID={`botGroup.settings.memberMenu.${member.botId}`}
              sections={[{ id: 'member', options }]}
              onSelect={(id) => {
                if (id.startsWith('organizer:')) void run('organizer', 'update', { organizerBotId: member.botId }, 'groupChat.settings.organizerSaveFailed');
                else if (id.startsWith('remove:')) {
                  if (group.supportsMemberRemoval && member.actorId)
                    void run('members', 'remove-member', { actorId: member.actorId }, 'groupChat.settings.membersSaveFailed');
                  else void setMembers(memberIds.filter((botId) => botId !== member.botId));
                }
              }}>
              {(open) => <Pressable accessibilityRole="button" accessibilityLabel={t('groupChat.settings.memberActions', { name: identity.name })}
                disabled={locked} onPress={open}
                style={({ pressed }) => [styles.memberRow, pressed && mobileInteractionStyles.pressed]}
                testID={`botGroup.settings.member.${member.botId}`}>
                <View style={!active ? styles.inactive : undefined}>
                  <BotGroupAvatar deviceId={host.deviceId} identity={identity} size={BOT_GROUP_ROW_AVATAR_SIZE} online={online} />
                </View>
                <View style={styles.memberName}>
                  <Text numberOfLines={1} style={styles.rowTitle}>{identity.name}</Text>
                  {organizer ? <BotGroupOrganizerTag /> : null}
                  {!active ? <Text numberOfLines={1} style={styles.rowMeta}>
                    {t(member.status === 'paused' ? 'groupChat.memberStatus.paused' : 'groupChat.memberStatus.unavailable')}
                  </Text> : null}
                </View>
                {rowBusy ? <ActivityIndicator color={colors.textSecondary} /> : <Ellipsis size={iconSize.lg} color={colors.textTertiary} />}
                <View style={styles.rowDivider} />
              </Pressable>}
            </BotGroupMenu>;
          })}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: picking, disabled: locked || !canAdd }}
            accessibilityLabel={canAdd ? t('groupChat.settings.add') : t('groupChat.settings.maxMembers', { max: BOT_GROUP_MAX_MEMBERS })}
            disabled={locked || !canAdd} onPress={() => setPicking((value) => !value)}
            style={({ pressed }) => [styles.memberRow, pressed && mobileInteractionStyles.pressed, !unavailable && (locked || !canAdd) && styles.inactive]}
            testID="botGroup.settings.add">
            <View style={styles.addMark}><Plus size={iconSize.sm} color={colors.textSecondary} /></View>
            <Text numberOfLines={1} style={[styles.rowTitle, styles.flex]}>{t('groupChat.settings.add')}</Text>
            {!canAdd ? <Text style={styles.rowMeta}>{t('groupChat.settings.maxMembers', { max: BOT_GROUP_MAX_MEMBERS })}</Text> : null}
            {picking && canAdd ? <View style={styles.rowDivider} /> : null}
          </Pressable>
          {picking && canAdd ? <View testID="botGroup.settings.addable">
            {serverManaged ? <TextInput value={memberQuery} onChangeText={setMemberQuery} editable={!locked}
              accessibilityLabel={t('devices.companions.search')} placeholder={t('devices.companions.search')}
              placeholderTextColor={colors.textPlaceholder} autoCorrect={false} returnKeyType="search"
              style={[styles.input, styles.searchInput]} testID="botGroup.settings.memberSearch" /> : null}
            {teammates.loading && addable.length === 0 ? <ActivityIndicator color={colors.textSecondary} style={styles.spinner} /> : null}
            {!teammates.loading && addable.length === 0
              ? <Text style={styles.note}>{t(teammates.failed ? 'devices.resources.loadFailed' : 'groupChat.settings.noMoreBots')}</Text>
              : null}
            {addable.map((row, index) => {
              const title = resolveRemoteText(row.item.display.title, i18n.language);
              return <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={title} disabled={locked}
                onPress={() => { if (serverManaged) void run('members', 'add-member', { botId: row.item.ref.id }, 'groupChat.settings.membersSaveFailed').then(saved => { if (saved) setPicking(false); });
                  else void setMembers([...memberIds, row.item.ref.id]); }}
                style={({ pressed }) => [styles.memberRow, pressed && mobileInteractionStyles.pressed]}
                testID={`botGroup.settings.addable.${row.item.ref.id}`}>
                <BotGroupAvatar deviceId={host.deviceId} identity={{ botId: row.item.ref.id, name: title, avatar: row.item.display.avatar }}
                  size={BOT_GROUP_ROW_AVATAR_SIZE} online={online} />
                <Text numberOfLines={1} style={[styles.rowTitle, styles.flex]}>{title}</Text>
                <Plus size={iconSize.sm} color={colors.textTertiary} />
                {index < addable.length - 1 ? <View style={styles.rowDivider} /> : null}
              </Pressable>;
            })}
          </View> : null}
        </View>
        <Text style={styles.note}>{t('groupChat.settings.organizerNote')}</Text>
        {error('members')}
        {error('organizer')}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.settings.projectDir')}</Text>
        <View style={[styles.group, styles.memberRow]} testID="botGroup.settings.projectDir">
          <Folder size={iconSize.md} color={colors.textSecondary} />
          <Text numberOfLines={1} style={[styles.rowValue, styles.flex]}>{group.projectDirName ?? t('groupChat.settings.projectDirNone')}</Text>
          <Text numberOfLines={1} style={styles.rowMeta}>{t('groupChat.settings.projectDirOnComputer')}</Text>
        </View>
        <Text style={styles.note}>{t('groupChat.settings.projectDirNote')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.settings.replyMode')}</Text>
        {segmented<BotGroupReplyMode>('replyMode', group.replyMode, [
          { value: 'all', label: t('groupChat.settings.replyModeAll') },
          { value: 'mentioned', label: t('groupChat.settings.replyModeMentioned') },
        ])}
        <Text style={styles.note}>{t(group.singleSpeaker ? 'groupChat.settings.replyModeNoteQueue' : 'groupChat.settings.replyModeNote')}</Text>
        {error('replyMode')}
      </View>

      {/* Single-speaker servers always answer one teammate at a time, so there is no speaking mode. */}
      {group.singleSpeaker ? null : <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.settings.speakingMode')}</Text>
        {segmented<BotGroupSpeakingMode>('speakingMode', group.speakingMode, [
          { value: 'auto', label: t('groupChat.settings.speakingModeAuto') },
          { value: 'sequential', label: t('groupChat.settings.speakingModeSequential') },
        ])}
        <Text style={styles.note}>{t(group.speakingMode === 'sequential'
          ? 'groupChat.settings.speakingModeSequentialNote'
          : 'groupChat.settings.speakingModeAutoNote')}</Text>
        {error('speakingMode')}
      </View>}

      </View>
      {(!group.serverBacked || (canManageBotGroup(group) && !leavesGroup && !group.dissolvedAt)) && <View style={[styles.section, (readOnly || !online) && styles.inheritedInactive]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t(archivesGroup ? 'groupChat.settings.archive' : 'groupChat.settings.delete')} disabled={deleteLocked}
          onPress={() => void remove()}
          style={({ pressed }) => [styles.group, styles.memberRow, pressed && mobileInteractionStyles.pressed, !readOnly && online && deleteLocked && styles.inactive]}
          testID="botGroup.settings.delete">
          {busy === 'delete' ? <ActivityIndicator color={colors.destructive} /> : null}
          <Text style={[styles.rowTitle, styles.destructive]}>{t(archivesGroup ? 'groupChat.settings.archive' : 'groupChat.settings.delete')}</Text>
        </Pressable>
        <Text style={styles.note}>{t(archivesGroup ? 'groupChat.settings.archiveNote' : 'groupChat.settings.deleteNote')}</Text>
        {error('delete')}
      </View>}
      {lifecycleGroup.serverBacked && <View style={styles.section} testID="botGroup.settings.lifecycle">
        {lifecycleGroup.dissolvedAt ? <Text style={styles.note}>{t('groupChat.lifecycle.dissolved')}</Text> : null}
        {(['dissolve', 'leave', 'hide'] as const).filter(action => action === 'hide' || (!lifecycleGroup.dissolvedAt &&
          (action === 'dissolve' ? membership.owner : membership.canLeave))).map(action => {
          const supported = (action === 'leave' ? lifecycleGroup.supportsGroupLeave : action === 'dissolve' ? lifecycleGroup.supportsDissolve : lifecycleGroup.supportsListRemoval) === true;
          const disabled = !supported || !lifecycleProps.online || busy !== null;
          return <Pressable key={action} accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }}
            onPress={() => void runLifecycle(action)} testID={`botGroup.settings.${action}`}
            style={({ pressed }) => [styles.group, styles.memberRow, pressed && mobileInteractionStyles.pressed, disabled && styles.inactive]}>
            <Text style={[styles.rowTitle, styles.destructive]}>{t(`groupChat.lifecycle.${action}`)}</Text>
          </Pressable>;
        })}
        {((membership.owner && !lifecycleGroup.supportsDissolve) || !lifecycleGroup.supportsListRemoval || (membership.canLeave && !lifecycleGroup.supportsGroupLeave))
          ? <Text style={styles.note}>{t('groupChat.lifecycle.unavailable')}</Text> : null}
        {error('lifecycle')}
      </View>}
    </View>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  settingsBody: { gap: spacing.xl },
  managementRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  managementText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  computerSlot: { flex: 1, minWidth: 0 },
  computerPicker: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  connectedDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.statusDone },
  reconnect: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  reconnectText: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  searchInput: { fontSize: typeScale.bodySmall },
  group: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, overflow: 'hidden' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm },
  rowDivider: { position: 'absolute', left: spacing.md + BOT_GROUP_ROW_AVATAR_SIZE + spacing.sm, right: 0, bottom: 0,
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  memberName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  rowValue: { color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  rowMeta: { flexShrink: 0, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  flex: { flex: 1 },
  inactive: { opacity: 0.6 },
  // The body already supplies the disabled opacity; avoid dimming segmented controls twice.
  inheritedInactive: { opacity: 1 },
  addMark: { width: BOT_GROUP_ROW_AVATAR_SIZE, height: BOT_GROUP_ROW_AVATAR_SIZE, borderRadius: radius.pill, borderWidth: 1,
    borderStyle: 'dashed', borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  spinner: { paddingVertical: spacing.md },
  segments: { flexDirection: 'row', backgroundColor: colors.surfaceChip, borderRadius: radius.pill, padding: spacing.xs },
  segment: { flex: 1, minHeight: 44 },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  destructive: { color: colors.destructive },
});
