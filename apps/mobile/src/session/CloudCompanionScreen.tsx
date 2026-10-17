import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { chatHttpsUrl } from '@/chat/chatServerClient';
import {
  CLOUD_SWITCH_POLL_MS, cloudCompanionMessages, cloudSwitchAfterSetHome, cloudSwitchCandidates, cloudSwitchTick,
  type CloudSwitchCandidate, type CloudSwitchState,
} from '@/chat/cloudCompanion';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { useCloudCompanionRoom } from '@/chat/useCloudCompanionRoom';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { cachedBotItem } from '@/device-link/remoteResourceCache';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { useUserBubbleAppearance } from '@/theme/userBubblePreference';
import { goBackGuarded } from '@/utils/backGuard';
import { BOT_GROUP_MESSAGE_AVATAR_SIZE } from './BotGroupAvatars';
import { BotGroupMarkdownText, BotGroupUserText } from './BotGroupMessageText';
import { CHAT_HEADER_MARK_SIZE, ChatIdentityHeader, ChatIdentitySubtitle } from './ChatIdentityHeader';
import { CompanionCardActions, CompanionCardButton } from './CompanionCardButton';
import { CompanionSettingsRow } from './CompanionSettingsRow';
import { CompanionSheet } from './CompanionSheet';
import { useTeammateNavigation } from './useTeammateNavigation';
import { TEAMMATE_COLLECTION_ID, useTeammateRoster } from './useTeammateRoster';

/** Presence dot before the subtitle, as in the 1:1 header. */
const PRESENCE_DOT = 6;
/** Reply geometry of the 1:1 chat: 28pt portrait, 10pt to the text. */
const REPLY_AVATAR_GAP = 10;
/** Load the previous page once the reader is this close to the top. */
const LOAD_OLDER_THRESHOLD_PX = 120;
const STICK_TO_BOTTOM_PX = 48;
const NO_MENTIONS: readonly string[] = [];

type Notice = 'noTargets' | 'devicesFailed' | null;

/**
 * 伙伴的主力电脑离线时，手机上的云端对话（docs/product-rules/cloud-companions.md §3.1）：只读显示
 * 1:1 房间里的对话层，横幅「主力电脑「名字」离线」+「换一台电脑继续」。选中电脑后服务器改主力电脑，
 * 那台电脑自动接手；手机等它在伙伴列表里出现后，像普通点按一样打开那台电脑上的伙伴。
 */
export function CloudCompanionScreen({ actorId, botId, deviceId, deviceName, title }: {
  actorId: string; botId: string; deviceId: string; deviceName: string; title: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useAuth();
  const { readDeviceList } = useDeviceLink();
  const revoked = useRevokedDevices();
  const navigation = useTeammateNavigation();
  const home = useCloudCompanionHome(true);
  const actor = home.actors.find(candidate => candidate.id === actorId) ?? null;
  const name = actor?.name || title;
  const currentHome = actor?.homeDeviceId ?? deviceId;
  const room = useCloudCompanionRoom(actorId, name, true);
  const { colors: userBubbleColors } = useUserBubbleAppearance();
  const cached = cachedBotItem(user?.id ?? '', TEAMMATE_COLLECTION_ID, deviceId, botId);
  const imageUrl = useMemo(() => {
    try { return actor?.avatar ? chatHttpsUrl(actor.avatar) : null; } catch { return null; }
  }, [actor?.avatar]);

  // Computer names seen in the latest device list (conflict / waiting copy).
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map([[deviceId, deviceName]]));
  const deviceLabel = (id: string | null) => (id && names.get(id)) || t('devices.cloudCompanion.unknownDevice');
  const homeName = currentHome === deviceId ? deviceName || deviceLabel(currentHome) : deviceLabel(currentHome);
  const homeOffline = t('devices.cloudCompanion.homeOffline', { device: homeName });

  const [candidates, setCandidates] = useState<CloudSwitchCandidate[]>([]);
  const [picker, setPicker] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const pendingChoice = useRef<CloudSwitchCandidate | null>(null);
  const [switching, setSwitching] = useState<CloudSwitchState>({ phase: 'idle' });
  const switchingRef = useRef(switching); switchingRef.current = switching;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const openPicker = async () => {
    if (loadingDevices) return;
    setNotice(null); setLoadingDevices(true);
    try {
      const response = await readDeviceList();
      if (!mounted.current) return;
      const rows = toDeviceListItems(response.devices, Date.now(), revoked);
      setNames(new Map([[deviceId, deviceName], ...rows.map(row => [row.device.deviceId, row.device.name] as const)]));
      const next = cloudSwitchCandidates(rows, currentHome);
      setCandidates(next);
      if (next.length) setPicker(true); else setNotice('noTargets');
    } catch {
      if (mounted.current) setNotice('devicesFailed');
    } finally { if (mounted.current) setLoadingDevices(false); }
  };

  const moveTo = async (target: CloudSwitchCandidate) => {
    setNotice(null);
    setSwitching({ phase: 'requesting', target });
    try {
      const result = await home.setHome(actorId, target.deviceId, currentHome);
      if (!mounted.current) return;
      const next = cloudSwitchAfterSetHome(target, result, Date.now());
      setSwitching(next);
      if (next.phase === 'conflict') void home.refresh();
    } catch {
      if (mounted.current) setSwitching({ phase: 'failed', target });
    }
  };

  // Watch the roster only while the new main computer is getting ready.
  const waiting = switching.phase === 'waiting';
  const roster = useTeammateRoster(waiting);
  const rosterRef = useRef(roster); rosterRef.current = roster;
  const openTeammate = useRef(navigation.openTeammate); openTeammate.current = navigation.openTeammate;
  const tick = useCallback(() => {
    // Only a read of that computer made while waiting counts; a cached row is not the arrival.
    const { state, arrived } = cloudSwitchTick(switchingRef.current, rosterRef.current.items, botId, Date.now(),
      row => rosterRef.current.isOnline(row.host));
    if (arrived) {
      switchingRef.current = { phase: 'idle' };
      setSwitching(switchingRef.current);
      void openTeammate.current(arrived, { replace: true });
    } else if (state !== switchingRef.current) setSwitching(state);
  }, [botId]);
  // Every roster change may be the arrival; the interval re-reads the roster and enforces the timeout.
  useEffect(() => { if (waiting) tick(); });
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void rosterRef.current.refresh(); tick(); }, CLOUD_SWITCH_POLL_MS);
    return () => clearInterval(timer);
  }, [tick, waiting]);

  // Timeline: newest at the bottom; older pages load near the top.
  const messages = useMemo(() => cloudCompanionMessages(room.messages, actorId), [actorId, room.messages]);
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickToBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_TO_BOTTOM_PX;
    if (contentOffset.y < LOAD_OLDER_THRESHOLD_PX && room.before && !room.loadingOlder && contentSize.height > layoutMeasurement.height) {
      stickToBottom.current = false;
      void room.loadOlder();
    }
  };

  const avatar = (size: number) => <RemoteCompanionAvatar avatar={cached?.display.avatar} imageUrl={imageUrl} deviceId={deviceId} name={name}
    online={false} size={size} framed />;

  const status = (() => {
    switch (switching.phase) {
      case 'waiting':
        return <View accessibilityLiveRegion="polite" style={styles.statusBlock} testID="cloudCompanion.waiting">
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.statusStrong}>{t('devices.cloudCompanion.preparing', { device: switching.target.name })}</Text>
          </View>
          <Text style={styles.bannerCopy}>{t('devices.cloudCompanion.preparingHint')}</Text>
        </View>;
      case 'timeout':
        return <Text accessibilityRole="alert" style={styles.bannerCopy} testID="cloudCompanion.timeout">
          {t('devices.cloudCompanion.timeout', { device: switching.target.name })}</Text>;
      case 'conflict':
        return <Text accessibilityRole="alert" style={styles.bannerCopy} testID="cloudCompanion.conflict">
          {t('devices.cloudCompanion.conflict', { name, device: deviceLabel(switching.homeDeviceId) })}</Text>;
      case 'failed':
        return <Text accessibilityRole="alert" style={styles.bannerCopy} testID="cloudCompanion.failed">{t('devices.cloudCompanion.switchFailed')}</Text>;
      default:
        return notice ? <Text accessibilityRole="alert" style={styles.bannerCopy} testID={`cloudCompanion.${notice}`}>
          {t(`devices.cloudCompanion.${notice}`)}</Text> : null;
    }
  })();

  let timeline;
  if (room.status === 'loading') {
    timeline = <View style={styles.center}><ActivityIndicator color={colors.textSecondary} /></View>;
  } else if (room.status === 'error') {
    timeline = <View style={styles.center} testID="cloudCompanion.loadFailed">
      <Text style={styles.centerText}>{t('devices.cloudCompanion.loadFailed')}</Text>
      <CompanionCardActions>
        <CompanionCardButton label={t('devices.resources.retry')} onPress={() => { void room.reload(); }} testID="cloudCompanion.reload" />
      </CompanionCardActions>
    </View>;
  } else {
    timeline = <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.timeline}
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      onScroll={onScroll} scrollEventThrottle={64}
      onContentSizeChange={() => { if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false }); }}
      testID="cloudCompanion.timeline">
      <View style={styles.olderSlot}>
        {room.loadingOlder ? <ActivityIndicator color={colors.textTertiary} testID="cloudCompanion.loadingOlder" />
          : room.before ? <CompanionCardActions>
            <CompanionCardButton label={t('devices.cloudCompanion.loadOlder')} onPress={() => { stickToBottom.current = false; void room.loadOlder(); }}
              testID="cloudCompanion.loadOlder" />
          </CompanionCardActions> : null}
      </View>
      {messages.length === 0 ? <Text style={styles.centerText} testID="cloudCompanion.empty">{t('devices.cloudCompanion.empty')}</Text> : null}
      {messages.map((message, index) => {
        if (!message.fromCompanion) return <View key={message.id} style={styles.userRow} testID="cloudCompanion.message.user">
          <View style={[styles.userBubble, userBubbleColors && { backgroundColor: userBubbleColors.background, borderColor: userBubbleColors.border }]}>
            <BotGroupUserText content={message.text} mentionLabels={NO_MENTIONS} />
          </View>
        </View>;
        const continued = index > 0 && messages[index - 1]!.fromCompanion;
        return <View key={message.id} style={[styles.replyRow, continued && styles.replyRowContinued]} testID="cloudCompanion.message.companion">
          {continued ? <View style={styles.avatarSpacer} /> : <View style={styles.avatarSlot}>{avatar(BOT_GROUP_MESSAGE_AVATAR_SIZE)}</View>}
          <View style={styles.replyColumn}><BotGroupMarkdownText content={message.text} /></View>
        </View>;
      })}
    </ScrollView>;
  }

  const busy = loadingDevices || switching.phase === 'requesting';
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']} testID="cloudCompanion.screen">
    <Stack.Screen options={{ headerShown: false }} />
    <ChatIdentityHeader testIDPrefix="cloudCompanion"
      mark={avatar(CHAT_HEADER_MARK_SIZE)}
      title={name}
      subtitle={<View style={styles.subtitleRow}>
        <View style={styles.presenceOff} testID="cloudCompanion.header.presence" />
        <ChatIdentitySubtitle>{homeOffline}</ChatIdentitySubtitle>
      </View>}
      identityLabel={[name, homeOffline].join(', ')}
      onBack={() => goBackGuarded(router)} />
    <View style={styles.banner} testID="cloudCompanion.banner">
      <Text style={styles.bannerTitle}>{homeOffline}</Text>
      {status ?? <Text style={styles.bannerCopy}>{t('devices.cloudCompanion.readOnlyNote')}</Text>}
      {waiting ? null : <CompanionCardActions>
        {switching.phase === 'timeout' ? <CompanionCardButton label={t('devices.resources.retry')} testID="cloudCompanion.retryWait"
          onPress={() => setSwitching({ phase: 'waiting', target: switching.target, since: Date.now() })} /> : null}
        <CompanionCardButton primary busy={busy} label={t('devices.cloudCompanion.switchAction')} testID="cloudCompanion.switch"
          onPress={() => { void openPicker(); }} />
      </CompanionCardActions>}
    </View>
    {timeline}
    <View style={styles.footer} testID="cloudCompanion.composerHint">
      <Text style={styles.footerText}>{t('devices.cloudCompanion.composerHint')}</Text>
    </View>
    <CompanionSheet visible={picker} title={t('devices.cloudCompanion.switchAction')} testID="cloudCompanion.picker"
      onClose={() => { pendingChoice.current = null; setPicker(false); }}
      onClosed={() => { const choice = pendingChoice.current; pendingChoice.current = null; if (choice) void moveTo(choice); }}>
      {candidates.map(candidate => <CompanionSettingsRow key={candidate.deviceId} icon={null} label={candidate.name}
        testID={`cloudCompanion.picker.${candidate.deviceId}`}
        onPress={() => { pendingChoice.current = candidate; setPicker(false); }} />)}
    </CompanionSheet>
  </SafeAreaView>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  presenceOff: { width: PRESENCE_DOT, height: PRESENCE_DOT, borderRadius: radius.pill, backgroundColor: colors.borderStrong },
  // Card shell (mobile guide §4): elevated surface, 1px border, container radius, 16 padding.
  banner: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.surfaceElevated,
    borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container },
  // Row title role: 16/22 medium.
  bannerTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  // Explanation role: 13/18 regular secondary.
  bannerCopy: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  statusBlock: { gap: spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusStrong: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  centerText: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
  timeline: { flexGrow: 1, justifyContent: 'flex-end', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  olderSlot: { alignItems: 'center' },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  // The 1:1 user bubble: 86% wide, padding 12.
  userBubble: { maxWidth: '86%', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, padding: spacing.md },
  replyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: REPLY_AVATAR_GAP },
  replyRowContinued: { marginTop: -spacing.sm },
  avatarSlot: { marginTop: 2 },
  avatarSpacer: { width: BOT_GROUP_MESSAGE_AVATAR_SIZE },
  replyColumn: { flex: 1, minWidth: 0 },
  // Where the composer would be: a quiet, disabled-looking strip with the explanation.
  footer: { marginHorizontal: spacing.lg, marginTop: spacing.xs, marginBottom: spacing.sm, minHeight: 44, justifyContent: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  footerText: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center' },
});
