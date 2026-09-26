import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import type { BotDirectMessageThreadResult } from '@cindy/maker-shared/botDirectMessage';
import { formatBotMessageGroupTime } from '@cindy/maker-shared/botTimeline';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import {
  cachedBotItem,
  readRemoteResourceSnapshot,
  remoteResourceCacheRevision,
  subscribeRemoteResourceCache,
} from '@/device-link/remoteResourceCache';
import { useRemoteCompanionQuery } from '@/session/useRemoteCompanionQuery';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

const AVATAR_SIZE = 28;

/** Desktop BotDirectMessageView: a read-only two-sided thread, the viewing teammate on the right. */
export default function CompanionDirectMessages() {
  const params = useLocalSearchParams<{ deviceId: string; botId: string; threadId: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const botId = typeof params.botId === 'string' ? params.botId : '';
  const threadId = typeof params.threadId === 'string' ? params.threadId : '';
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const { subscribe, unsubscribe } = useDeviceLink();
  const { value, error, online, refresh } = useRemoteCompanionQuery<BotDirectMessageThreadResult>(deviceId, 'maker:bot-direct-message-thread:get', [threadId, botId]);
  useFocusEffect(useCallback(() => startFocusedTopicSubscription({ deviceId, owner: `companion-direct:${threadId}`, topic: 'sessions', subscribe, unsubscribe }), [deviceId, threadId, subscribe, unsubscribe]));
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  useEffect(() => { if (userId) void readRemoteResourceSnapshot(userId); }, [userId]);
  const thread = value?.ok ? value.thread : null;
  const failed = Boolean(error || value?.ok === false);
  const participant = (id: string, fallbackName: string) => {
    const item = cachedBotItem(userId, 'teammates', deviceId, id);
    return { name: (item ? resolveRemoteText(item.display.title, i18n.language) : '') || fallbackName || id, avatar: item?.display.avatar };
  };
  const peerId = thread ? thread.botAId === botId ? thread.botBId : thread.botAId : '';
  const viewer = thread ? participant(botId, thread.botAId === botId ? thread.botAName : thread.botBName) : null;
  const peer = thread ? participant(peerId, thread.botAId === peerId ? thread.botAName : thread.botBName) : null;
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen}>
    <SimpleStackHeader title={viewer && peer ? `${viewer.name} ⇄ ${peer.name}` : t('devices.companions.messages')}
      subtitle={t('devices.companions.readOnly')} onBack={() => goBackGuarded(router)} />
    <ScrollView contentContainerStyle={styles.content} testID="companion.directThread">
      {!online ? <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text> : null}
      {messages.map((message) => {
        const ownSide = message.senderBotId === botId;
        const sender = participant(message.senderBotId, message.senderBotName);
        const avatar = <RemoteCompanionAvatar avatar={sender.avatar} deviceId={deviceId} name={sender.name} online={online} size={AVATAR_SIZE} framed />;
        return <View key={message.id} style={[styles.row, ownSide ? styles.rowOwn : styles.rowPeer]} testID={`companion.directMessage.${ownSide ? 'own' : 'peer'}`}>
          {!ownSide ? avatar : null}
          <View style={[styles.column, ownSide ? styles.columnOwn : styles.columnPeer]}>
            <Text style={styles.meta}>{`${sender.name} · ${formatBotMessageGroupTime(message.createdAt, i18n.language)}`}</Text>
            <Text selectable style={[styles.bubble, ownSide ? styles.bubbleOwn : styles.bubblePeer]}>{message.content}</Text>
          </View>
          {ownSide ? avatar : null}
        </View>;
      })}
      {thread && messages.length === 0 ? <Text style={[styles.note, styles.empty]}>{t('devices.companions.directEmpty')}</Text> : null}
      {thread?.closeReason === 'message-limit' ? <View style={styles.limit} testID="companion.directLimit">
        <View style={styles.limitLine} />
        <Text style={styles.limitText}>{t('devices.companions.directLimitReached')}</Text>
        <View style={styles.limitLine} />
      </View> : null}
      {!thread && online && !failed ? <ActivityIndicator color={colors.textTertiary} /> : null}
      {!thread && failed ? <Text style={[styles.note, styles.empty]}>{t(value?.ok === false ? 'devices.companions.directUnavailable' : 'devices.companions.actionFailed')}</Text> : null}
      {failed ? <MainWindowActionButton action={{ label: t('devices.resources.retry'), onPress: refresh }} /> : null}
    </ScrollView>
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, gap: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rowOwn: { justifyContent: 'flex-end' },
  rowPeer: { justifyContent: 'flex-start' },
  column: { maxWidth: '74%', minWidth: 0, gap: spacing.xs },
  columnOwn: { alignItems: 'flex-end' },
  columnPeer: { alignItems: 'flex-start' },
  meta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, paddingHorizontal: spacing.xs },
  bubble: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10, overflow: 'hidden' },
  // Own side reads like the user's bubble; the peer sits on the chip surface (Desktop msg-user / surface-chip).
  bubbleOwn: { backgroundColor: colors.surfaceElevated, borderColor: colors.borderStrong },
  bubblePeer: { backgroundColor: colors.surfaceChip, borderColor: colors.border },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote },
  empty: { color: colors.textTertiary, textAlign: 'center', paddingVertical: spacing.xl },
  limit: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  limitLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  limitText: { flexShrink: 1, color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, textAlign: 'center' },
});
