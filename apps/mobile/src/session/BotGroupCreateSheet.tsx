/**
 * 新建群聊（对照桌面 BotGroupCreateDialog.tsx）：填群名称，选 2–6 位伙伴。群建在一台电脑上，
 * 只能选这台电脑上的伙伴；多台电脑时先在「+」的菜单里选电脑。成员顺序即发言顺序，跟随
 * 列表顺序而不是点选先后（与桌面一致）。群名长度与人数由电脑最终校验，这里先挡住明显不
 * 成立的提交。建好后电脑回一个跳转，页面打开新群。
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  BOT_GROUP_NAME_MAX_CHARS,
  BOT_GROUP_REMOTE_COLLECTION_ID,
} from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_ROW_AVATAR_SIZE, BotGroupAvatar } from './BotGroupAvatars';
import { botGroupActionErrorText } from './botGroupCopy';
import { createdBotGroupId } from './botGroupRemote';
import { CompanionSheet } from './CompanionSheet';
import { orderedTeammates } from './teammateNavigation';
import { useHostTeammates } from './useHostTeammates';

export function BotGroupCreateSheet(props: {
  visible: boolean;
  host: RemoteResourceHostTarget | null;
  online: boolean;
  onClose(): void;
  onClosed?(): void;
  /** The new group; the caller opens it after the sheet has closed. */
  onCreated(groupId: string): void;
}) {
  const { accountGeneration } = useAuth();
  // A new computer or account starts an empty form.
  return <CreateSheetContent key={`${accountGeneration}:${props.host?.deviceId ?? ''}`} {...props} />;
}

function CreateSheetContent({ visible, host, online, onClose, onClosed, onCreated }: Parameters<typeof BotGroupCreateSheet>[0]) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { invoke, openLink } = useDeviceLink();
  const teammates = useHostTeammates(host, visible);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    setName(''); setSelected([]); setNameError(false); setMembersError(false); setSubmitError(null);
  }, [visible]);

  const candidates = orderedTeammates(teammates.rows, '', i18n.language);
  // Speaking order follows the list order, not the tap order.
  const ordered = candidates.map((row) => row.item.ref.id).filter((botId) => selected.includes(botId));
  const atLimit = ordered.length >= BOT_GROUP_MAX_MEMBERS;
  const dirty = !!name.trim() || selected.length > 0;

  const toggle = (botId: string) => {
    setSubmitError(null);
    setMembersError(false);
    setSelected((current) => current.includes(botId)
      ? current.filter((id) => id !== botId)
      : current.length >= BOT_GROUP_MAX_MEMBERS ? current : [...current, botId]);
  };

  const close = () => {
    if (busyRef.current) return;
    if (!dirty) { onClose(); return; }
    Alert.alert(t('devices.companions.automation.unsavedTitle'), t('devices.companions.automation.unsavedBody'), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companions.automation.discard'), style: 'destructive', onPress: () => { if (!busyRef.current) onClose(); } },
    ]);
  };

  const submit = async () => {
    if (busyRef.current || !host) return;
    const trimmed = name.trim();
    const nameInvalid = trimmed.length === 0;
    const membersInvalid = ordered.length < BOT_GROUP_MIN_MEMBERS || ordered.length > BOT_GROUP_MAX_MEMBERS;
    setNameError(nameInvalid);
    setMembersError(membersInvalid);
    if (nameInvalid || membersInvalid) return;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      await openLink(host.deviceId);
      const response = await invokeRemoteResourceAction(invoke, host, {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
        actionId: 'create',
        input: { name: trimmed, botIds: ordered },
      }, i18n.language);
      if (!mounted.current) return;
      const groupId = createdBotGroupId(response.effects);
      if (!groupId) throw new Error('Creation receipt missing');
      onCreated(groupId);
      onClose();
    } catch (error) {
      if (mounted.current) setSubmitError(botGroupActionErrorText(t, error, 'groupChat.create.failed'));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const notEnough = !teammates.loading && candidates.length < BOT_GROUP_MIN_MEMBERS;
  return <CompanionSheet visible={visible} title={t('groupChat.create.title')} onClose={close} onClosed={onClosed}
    preventDismiss={dirty || busy} testID="botGroup.create">
    <View style={styles.content}>
      <Text style={styles.description}>{t('groupChat.create.description')}</Text>
      {host ? <Text style={styles.note}>{t('groupChat.create.computerNote', { deviceName: host.deviceName })}</Text> : null}
      {!online ? <Text accessibilityRole="alert" style={styles.note}>{t('devices.resources.hostOffline')}</Text> : null}
      <View style={styles.field}>
        <Text style={styles.label}>{t('groupChat.create.nameLabel')}</Text>
        <TextInput accessibilityLabel={t('groupChat.create.nameLabel')} value={name} maxLength={BOT_GROUP_NAME_MAX_CHARS}
          editable={!busy} placeholder={t('groupChat.create.namePlaceholder')} placeholderTextColor={colors.textPlaceholder}
          onChangeText={(value) => { setName(value); if (value.trim()) setNameError(false); setSubmitError(null); }}
          style={styles.input} testID="botGroup.create.name" />
        {nameError ? <Text accessibilityRole="alert" style={styles.error}>{t('groupChat.create.nameRequired')}</Text> : null}
      </View>
      <View style={styles.field}>
        <View style={styles.labelRow}>
          <Text style={[styles.label, styles.flex]}>{t('groupChat.create.membersLabel')}</Text>
          <Text style={styles.count}>{t('groupChat.create.selectedCount', { count: ordered.length, max: BOT_GROUP_MAX_MEMBERS })}</Text>
        </View>
        {candidates.length > 0 ? <View style={styles.group}>
          {candidates.map((row, index) => {
            const title = resolveRemoteText(row.item.display.title, i18n.language);
            const checked = selected.includes(row.item.ref.id);
            const disabled = busy || (!checked && atLimit);
            return <Pressable key={row.key} accessibilityRole="checkbox" accessibilityLabel={title}
              accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => toggle(row.item.ref.id)}
              style={({ pressed }) => [styles.row, index === candidates.length - 1 && styles.lastRow, pressed && mobileInteractionStyles.pressed, disabled && !checked && styles.inactive]}
              testID={`botGroup.create.member.${row.item.ref.id}`}>
              <BotGroupAvatar deviceId={row.host.deviceId} identity={{ botId: row.item.ref.id, name: title, avatar: row.item.display.avatar }}
                size={BOT_GROUP_ROW_AVATAR_SIZE} online={online} />
              <Text numberOfLines={1} style={[styles.rowTitle, styles.flex]}>{title}</Text>
              <View style={[styles.check, checked && styles.checked]}>
                {checked ? <Check size={iconSize.xs} color={colors.ctaText} strokeWidth={iconStroke.bold} /> : null}
              </View>
            </Pressable>;
          })}
        </View> : null}
        {teammates.loading && candidates.length === 0 ? <ActivityIndicator color={colors.textSecondary} style={styles.spinner} /> : null}
        {notEnough ? <Text style={styles.note}>{t(teammates.failed ? 'devices.resources.loadFailed' : 'groupChat.create.notEnoughBots', { min: BOT_GROUP_MIN_MEMBERS })}</Text> : null}
        {membersError ? <Text accessibilityRole="alert" style={styles.error}>{t('groupChat.create.minMembers', { min: BOT_GROUP_MIN_MEMBERS })}</Text> : null}
      </View>
      {submitError ? <Text accessibilityRole="alert" style={styles.error} testID="botGroup.create.error">{submitError}</Text> : null}
      <View style={styles.actions}>
        <MainWindowActionButton action={{ label: t('devices.common.cancel'), disabled: busy, onPress: close, testID: 'botGroup.create.cancel' }} />
        <MainWindowActionButton action={{ label: t('groupChat.create.submit'), tone: 'primary', busy, disabled: !online || !host,
          onPress: () => void submit(), testID: 'botGroup.create.submit' }} />
      </View>
    </View>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  description: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  field: { gap: spacing.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  count: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontVariant: ['tabular-nums'] },
  flex: { flex: 1 },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  group: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.md,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  lastRow: { borderBottomWidth: 0 },
  rowTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  inactive: { opacity: 0.6 },
  check: { width: iconSize.action, height: iconSize.action, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.cta, borderColor: colors.cta },
  spinner: { paddingVertical: spacing.md },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
