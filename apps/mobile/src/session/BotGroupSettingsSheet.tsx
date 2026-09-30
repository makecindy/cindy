/**
 * 群设置（对照桌面 BotGroupSettingsDrawer.tsx）：群名称、成员（点成员行弹菜单：设为负责人 / 移出；添加伙伴）、
 * 项目文件夹（只读：手机不能指定电脑上的文件夹，在电脑上选择或更换）、没有 @ 人时的回复方式、
 * 发言方式、删除群聊（系统确认框二次确认）。
 *
 * 每项改动立即交给电脑；群数据以电脑推送后重读的结果为准，失败就地提示并保持原值。
 * 成员数 2–6 由电脑最终校验，这里只把不会成立的操作提前禁用。能加入的只有这台电脑上的伙伴。
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ellipsis, Folder, Plus } from 'lucide-react-native';
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
import { isActiveBotGroupMember } from '@cindy/maker-shared/botGroupPresentation';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { showConfirm } from '@/platform/chrome';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_ROW_AVATAR_SIZE, BotGroupAvatar } from './BotGroupAvatars';
import { BotGroupOrganizerTag, type BotGroupIdentityLookup } from './BotGroupPlan';
import { botGroupActionErrorText } from './botGroupCopy';
import { CompanionSheet } from './CompanionSheet';
import { useHostTeammates } from './useHostTeammates';
import { BotGroupMenu } from './BotGroupMenu';

type Busy = 'name' | 'members' | 'organizer' | 'replyMode' | 'speakingMode' | 'delete' | null;
type Act = (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>) => Promise<unknown>;

export function BotGroupSettingsSheet({ visible, group, host, identityFor, online, act, onClose, onClosed, onDeleted }: {
  visible: boolean;
  group: BotGroupRemoteChatData;
  host: RemoteResourceHostTarget;
  identityFor: BotGroupIdentityLookup;
  online: boolean;
  act: Act;
  onClose(): void;
  onClosed?(): void;
  /** The group is gone; the screen leaves once the sheet has closed. */
  onDeleted(): void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const [errors, setErrors] = useState<Partial<Record<Exclude<Busy, null>, string>>>({});
  const [picking, setPicking] = useState(false);
  const nameFocused = useRef(false);
  const teammates = useHostTeammates(host, visible && picking);

  // Follow renames that land from the computer while the field is not being edited.
  useEffect(() => { if (!nameFocused.current) setName(group.name); }, [group.name]);
  useEffect(() => { if (!visible) { setPicking(false); setErrors({}); } }, [visible]);

  const memberIds = group.members.map((member) => member.botId);
  const canRemove = group.members.length > BOT_GROUP_MIN_MEMBERS;
  const canAdd = group.members.length < BOT_GROUP_MAX_MEMBERS;
  const addable = teammates.rows.filter((row) => !memberIds.includes(row.item.ref.id));
  const locked = busy !== null || !online;

  /** Run one change; the section shows the failure copy, or clears it on success. */
  const run = async (section: Exclude<Busy, null>, actionId: BotGroupRemoteActionId, input: Record<string, unknown>, fallbackKey: string) => {
    if (busyRef.current) return false;
    busyRef.current = section;
    setBusy(section);
    setErrors((current) => ({ ...current, [section]: undefined }));
    try {
      await act(actionId, input);
      return true;
    } catch (error) {
      setErrors((current) => ({ ...current, [section]: botGroupActionErrorText(t, error, fallbackKey) }));
      return false;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setName(group.name); return; }
    if (trimmed === group.name) return;
    const saved = await run('name', 'update', { name: trimmed }, 'groupChat.settings.nameSaveFailed');
    if (!saved) setName(group.name);
  };

  const setMembers = async (botIds: string[]) => {
    const saved = await run('members', 'set-members', { botIds }, 'groupChat.settings.membersSaveFailed');
    if (saved) setPicking(false);
  };

  const remove = async () => {
    if (busyRef.current) return;
    const confirmed = await showConfirm({
      title: t('groupChat.settings.deleteConfirmTitle', { name: group.name }),
      message: t('groupChat.settings.deleteNote'),
      cancelLabel: t('devices.common.cancel'),
      confirmLabel: t('groupChat.settings.delete'),
      destructive: true,
    });
    if (!confirmed) return;
    if (await run('delete', 'delete', {}, 'groupChat.settings.deleteFailed')) onDeleted();
  };

  const error = (section: Exclude<Busy, null>) => errors[section]
    ? <Text accessibilityRole="alert" style={styles.error}>{errors[section]}</Text>
    : null;

  const segmented = <T extends string>(section: 'replyMode' | 'speakingMode', value: T, options: { value: T; label: string }[]) =>
    <View style={styles.segments} accessibilityRole="tablist">
      {options.map((option) => <MainWindowOptionButton key={option.value} accessibilityRole="tab" density="default" variant="segmented"
        label={option.label} selected={option.value === value} disabled={locked}
        onPress={() => { if (option.value !== value) void run(section, 'update', { [section]: option.value }, `groupChat.settings.${section}SaveFailed`); }}
        style={styles.segment} testID={`botGroup.settings.${section}.${option.value}`} />)}
    </View>;

  return <CompanionSheet visible={visible} title={t('groupChat.settings.title')} onClose={onClose} onClosed={onClosed}
    preventDismiss={busy !== null} testID="botGroup.settings">
    <View style={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.create.nameLabel')}</Text>
        <TextInput accessibilityLabel={t('groupChat.create.nameLabel')} value={name} maxLength={BOT_GROUP_NAME_MAX_CHARS}
          editable={!locked || busy === 'name'} returnKeyType="done"
          onChangeText={(value) => { setName(value); setErrors((current) => ({ ...current, name: undefined })); }}
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
            const organizer = member.botId === group.organizerBotId;
            // G12: one row per member; a tap opens its menu (设为负责人 / 移出群聊) instead of two inline buttons.
            const options = [
              ...(!organizer && active ? [{ id: `organizer:${member.botId}`, title: t('groupChat.settings.setOrganizer') }] : []),
              {
                id: `remove:${member.botId}`, title: t('groupChat.settings.remove'), destructive: true, disabled: !canRemove,
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
                else if (id.startsWith('remove:')) void setMembers(memberIds.filter((botId) => botId !== member.botId));
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
            style={({ pressed }) => [styles.memberRow, pressed && mobileInteractionStyles.pressed, (locked || !canAdd) && styles.inactive]}
            testID="botGroup.settings.add">
            <View style={styles.addMark}><Plus size={iconSize.sm} color={colors.textSecondary} /></View>
            <Text numberOfLines={1} style={[styles.rowTitle, styles.flex]}>{t('groupChat.settings.add')}</Text>
            {!canAdd ? <Text style={styles.rowMeta}>{t('groupChat.settings.maxMembers', { max: BOT_GROUP_MAX_MEMBERS })}</Text> : null}
            {picking && canAdd ? <View style={styles.rowDivider} /> : null}
          </Pressable>
          {picking && canAdd ? <View testID="botGroup.settings.addable">
            {teammates.loading && addable.length === 0 ? <ActivityIndicator color={colors.textSecondary} style={styles.spinner} /> : null}
            {!teammates.loading && addable.length === 0
              ? <Text style={styles.note}>{t(teammates.failed ? 'devices.resources.loadFailed' : 'groupChat.settings.noMoreBots')}</Text>
              : null}
            {addable.map((row, index) => {
              const title = resolveRemoteText(row.item.display.title, i18n.language);
              return <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={title} disabled={locked}
                onPress={() => void setMembers([...memberIds, row.item.ref.id])}
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
        <Text style={styles.note}>{t('groupChat.settings.replyModeNote')}</Text>
        {error('replyMode')}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('groupChat.settings.speakingMode')}</Text>
        {segmented<BotGroupSpeakingMode>('speakingMode', group.speakingMode, [
          { value: 'auto', label: t('groupChat.settings.speakingModeAuto') },
          { value: 'sequential', label: t('groupChat.settings.speakingModeSequential') },
        ])}
        <Text style={styles.note}>{t(group.speakingMode === 'sequential'
          ? 'groupChat.settings.speakingModeSequentialNote'
          : 'groupChat.settings.speakingModeAutoNote')}</Text>
        {error('speakingMode')}
      </View>

      <View style={styles.section}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('groupChat.settings.delete')} disabled={locked}
          onPress={() => void remove()}
          style={({ pressed }) => [styles.group, styles.memberRow, pressed && mobileInteractionStyles.pressed, locked && styles.inactive]}
          testID="botGroup.settings.delete">
          {busy === 'delete' ? <ActivityIndicator color={colors.destructive} /> : null}
          <Text style={[styles.rowTitle, styles.destructive]}>{t('groupChat.settings.delete')}</Text>
        </Pressable>
        <Text style={styles.note}>{t('groupChat.settings.deleteNote')}</Text>
        {error('delete')}
      </View>
    </View>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  group: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, overflow: 'hidden' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm },
  // Dividers start at the name column (after the avatar), like the companion list rows; the add row is last and has none.
  rowDivider: { position: 'absolute', left: spacing.md + BOT_GROUP_ROW_AVATAR_SIZE + spacing.sm, right: 0, bottom: 0,
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  memberName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  rowValue: { color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  rowMeta: { flexShrink: 0, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  flex: { flex: 1 },
  inactive: { opacity: 0.6 },
  addMark: { width: BOT_GROUP_ROW_AVATAR_SIZE, height: BOT_GROUP_ROW_AVATAR_SIZE, borderRadius: radius.pill, borderWidth: 1,
    borderStyle: 'dashed', borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  spinner: { paddingVertical: spacing.md },
  segments: { flexDirection: 'row', backgroundColor: colors.surfaceChip, borderRadius: radius.pill, padding: spacing.xs },
  segment: { flex: 1, minHeight: 44 },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  destructive: { color: colors.destructive },
});
