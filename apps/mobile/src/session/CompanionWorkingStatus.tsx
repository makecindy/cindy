import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';
import { useMemo, useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isCompactingWorkingStatus, readWorkingPhase } from '@cindy/maker-shared';
import { Text } from '@/components/AppText';
import { spacing, typeScale, useTheme } from '@/theme';
import { remoteSessionStore, type RemoteSessionRunStatus } from './remoteSessionStore';
import { companionWorkingPhase } from './companionWorkingPhase';
import type { RemoteMessage } from './types';

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
  const copy = useCompanionGenerationCopy({ deviceId, botId, phase, active: shown && !reconnectAttempt, turnId });
  if (!shown) return null;
  return reconnectAttempt ? t(reconnectAttempt.kind === 'overload' ? 'session.screen.modelBusyRetrying'
    : reconnectAttempt.kind === 'rate-limit' ? 'session.screen.rateLimitRetrying' : 'session.screen.networkReconnecting') : copy;
}

export function CompanionWorkingStatus({ label }: { label: string | null }) {
  const { colors } = useTheme();
  if (!label) return null;
  return <View style={styles.row} accessibilityLiveRegion="polite" testID="companion.workingStatus">
    <ActivityIndicator size="small" color={colors.textSecondary} />
    <Text style={{ color: colors.textSecondary, fontSize: typeScale.body, flexShrink: 1 }}>{label}</Text>
  </View>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg, paddingHorizontal: spacing.md } });
