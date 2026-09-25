import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isCompactingWorkingStatus, readWorkingPhase } from '@cindy/maker-shared';
import { useAuth } from '@/auth/AuthContext';
import type { RemoteCollectionItem } from '@cindy/device-link';
import {
  cachedBotIdForSession,
  cachedBotItem,
  readRemoteResourceSnapshot,
  remoteResourceCacheRevision,
  subscribeRemoteResourceCache,
} from '@/device-link/remoteResourceCache';
import { spacing, typeScale, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { remoteSessionStore, type RemoteSessionRunStatus } from './remoteSessionStore';
import { companionWorkingPhase } from './companionWorkingPhase';
import { WorkingStatusText } from './WorkingStatusText';
import type { RemoteMessage } from './types';

const TEAMMATE_COLLECTION_ID = 'teammates';

/** Loads the account's cached roster when the route does not already name the Bot. */
function useCompanionRosterCache(needed: boolean): string {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (!needed || !userId) return;
    let current = true;
    void readRemoteResourceSnapshot(userId).then(() => { if (current) setLoaded(value => value + 1); });
    return () => { current = false; };
  }, [needed, userId]);
  return userId;
}

/** The route's resource names the Bot; a cached roster link covers ordinary task entries. */
function useCompanionBotId(deviceId: string, sessionId: string, resourceBotId: string): string {
  const userId = useCompanionRosterCache(!resourceBotId);
  return resourceBotId || cachedBotIdForSession(userId, TEAMMATE_COLLECTION_ID, deviceId, sessionId);
}

/** Name and avatar for a chat opened from a task link or notification: the cached roster row, display only. */
export function useCompanionDisplayResource(deviceId: string, sessionId: string, resource: RemoteCollectionItem | null,
  enabled: boolean): RemoteCollectionItem | null {
  const userId = useCompanionRosterCache(enabled && !resource);
  if (!enabled) return null;
  if (resource) return resource;
  const botId = cachedBotIdForSession(userId, TEAMMATE_COLLECTION_ID, deviceId, sessionId);
  return botId ? cachedBotItem(userId, TEAMMATE_COLLECTION_ID, deviceId, botId) : null;
}

/** One live reply position; optional host copy enriches the same factual phase. */
export function useCompanionWorkingLabel({ sessionId, deviceId, botId, active, messages, reconnectAttempt }: {
  sessionId: string; deviceId: string; botId: string; active: boolean;
  messages: readonly RemoteMessage[]; reconnectAttempt: RemoteSessionRunStatus['reconnectAttempt'];
}) {
  const { t } = useTranslation();
  const activity = useSyncExternalStore(remoteSessionStore.subscribe, () => remoteSessionStore.getSessionLiveActivity(sessionId));
  const { phase: fallbackPhase, turnId } = useMemo(() => companionWorkingPhase(messages), [messages]);
  const phase = readWorkingPhase(activity?.workingPhase) ?? (isCompactingWorkingStatus(activity?.compactDetail) ? 'compacting' : fallbackPhase);
  const shown = active && activity?.phase !== 'needs-interaction' && activity?.phase !== 'error' && activity?.phase !== 'completed' && (!!reconnectAttempt || phase !== null);
  const companionBotId = useCompanionBotId(deviceId, sessionId, botId);
  const copy = useCompanionGenerationCopy({ deviceId, botId: companionBotId, phase, active: shown && !reconnectAttempt, turnId });
  if (!shown) return null;
  return reconnectAttempt ? t(reconnectAttempt.kind === 'overload' ? 'session.screen.modelBusyRetrying'
    : reconnectAttempt.kind === 'rate-limit' ? 'session.screen.rateLimitRetrying' : 'session.screen.networkReconnecting') : copy;
}

/** Desktop BotAvatar `xs`: the composer status line stays compact on a phone. */
export const COMPANION_STATUS_AVATAR_SIZE = 20;

/** Composer-owned live status (Desktop BotWorkingStatus): avatar, spinner and paced copy. */
export function CompanionWorkingStatus({ label, avatar }: { label: string | null; avatar?: ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Terminal events unmount immediately; cadence only applies while the lifecycle is active.
  if (!label) return null;
  return <View style={styles.row} accessibilityLiveRegion="polite" testID="companion.workingStatus">
    {avatar ? <View style={styles.avatar}>{avatar}</View> : null}
    <ActivityIndicator size="small" color={colors.textTertiary} />
    <WorkingStatusText text={label} style={styles.text} />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32, paddingHorizontal: spacing.xs },
  avatar: { flexShrink: 0 },
  text: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
