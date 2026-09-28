/**
 * 正在发言 / 安排 / 做事的伙伴一行（对照桌面 BotGroupChatView 的 BotGroupSpeakingRow 与
 * BotGroupPendingInteraction）。
 *
 * 伙伴的群专线或分工 Session 是一条普通 Cindy Session：页面聚焦期间订阅它的
 * `session:<id>` 流并读一次挂起交互的快照，权限请求 / 提问就地用伙伴卡片样式显示在这位
 * 伙伴下面，作答走任务页同一条路径。等你确认时不再显示「正在…」。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CircleAlert, Sparkles } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { readWorkingPhase } from '@cindy/maker-shared';
import type { BotGroupSpeakerActivity } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, spacing, typeScale } from '@/theme/tokens';
import {
  BOT_GROUP_INLINE_AVATAR_SIZE,
  BOT_GROUP_MESSAGE_AVATAR_SIZE,
  BotGroupAvatar,
  type BotGroupIdentity,
} from './BotGroupAvatars';
import { InteractionPanel } from './InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from './remoteSessionStore';
import type { PendingInteraction } from './types';
import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';
import { WorkingStatusText } from './WorkingStatusText';

export function BotGroupSpeakerRow({ deviceId, identity, sessionId, activity, online, onError }: {
  deviceId: string;
  identity: BotGroupIdentity;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
  online: boolean;
  onError(message: string | null): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { invoke, subscribe, unsubscribe } = useDeviceLink();
  const lane = sessionId ?? '';
  useFocusEffect(useCallback(() => {
    if (!lane || !online) return;
    let cancelled = false;
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `bot-group-speaker:${lane}`, topic: `session:${lane}`, subscribe, unsubscribe });
    // Seed prompts raised before this screen subscribed; later ones arrive as pushes.
    void invoke<PendingInteraction[]>(deviceId, 'maker:get-pending-interactions', [lane]).then((list) => {
      if (!cancelled && Array.isArray(list)) remoteSessionStore.setPendingInteractions(lane, list);
    }).catch(() => undefined);
    return () => { cancelled = true; offTopic(); };
  }, [deviceId, invoke, lane, online, subscribe, unsubscribe]));
  const pending = useSessionPendingInteractions(lane);
  const live = useSyncExternalStore(remoteSessionStore.subscribe, () => lane ? remoteSessionStore.getSessionLiveActivity(lane) : null);
  const waiting = pending.length > 0 || live?.phase === 'needs-interaction';
  const livePhase = readWorkingPhase(live?.workingPhase);
  // The organizer's decision runs outside any Session: there is no live phase to show.
  const copy = useCompanionGenerationCopy({
    deviceId,
    botId: identity.botId,
    phase: activity === 'reply' ? livePhase ?? 'thinking' : livePhase,
    active: !waiting && activity !== 'planning' && (activity === 'reply' || livePhase !== null),
    turnId: lane,
  });
  const label = activity === 'planning'
    ? t('groupChat.speaking.planning')
    : copy ?? (activity === 'step' ? t('groupChat.speaking.step') : t('devices.companions.working.thinking'));
  return <View style={styles.row} testID="botGroup.speaking" accessibilityLabel={`${identity.name}, ${waiting ? t('groupChat.waitingConfirm', { name: identity.name }) : label}`}>
    <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_MESSAGE_AVATAR_SIZE} online={online} />
    <View style={styles.column}>
      <Text numberOfLines={1} style={styles.name}>{identity.name}</Text>
      {!waiting ? <View style={styles.status} accessibilityLiveRegion="polite" testID={`botGroup.speaking.${activity}`}>
        <Sparkles size={iconSize.sm} color={colors.statusAccent} />
        <WorkingStatusText key={`${lane}:${activity}`} text={label} style={styles.statusText} />
      </View> : null}
      {pending.length > 0 && lane ? <InteractionPanel embedded companion
        companionIdentity={{ name: identity.name, avatar: <BotGroupAvatar deviceId={deviceId} identity={identity} size={BOT_GROUP_INLINE_AVATAR_SIZE} online={online} /> }}
        deviceId={deviceId} sessionId={lane} interactions={pending} onError={onError} />
        : waiting ? <View style={styles.status} testID="botGroup.speaking.waiting">
          <CircleAlert size={iconSize.sm} color={colors.warningFg} />
          <Text style={styles.waitingText}>{t('groupChat.waitingConfirm', { name: identity.name })}</Text>
        </View> : null}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  column: { flex: 1, minWidth: 0, gap: spacing.xs },
  name: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statusText: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  waitingText: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
