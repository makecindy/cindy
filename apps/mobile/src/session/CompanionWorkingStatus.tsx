import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { hasPublicWorkingSubject } from '@cindy/maker-shared';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useAuth } from '@/auth/AuthContext';
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
  const { t, i18n } = useTranslation();
  const { invoke } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const activity = useSyncExternalStore(remoteSessionStore.subscribe, () => remoteSessionStore.getSessionLiveActivity(sessionId));
  const { phase, turnId } = useMemo(() => companionWorkingPhase(messages), [messages]);
  const shown = active && activity?.phase !== 'needs-interaction' && activity?.phase !== 'error' && (!!reconnectAttempt || phase !== null);
  const scope = JSON.stringify([accountGeneration, deviceId, botId, sessionId, turnId, phase, i18n.language, shown, !!reconnectAttempt]);
  const [caption, setCaption] = useState<{ scope: string; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (shown && phase && hasPublicWorkingSubject(phase) && !reconnectAttempt) {
      void invoke<unknown>(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{ client: {
        protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['status'], locale: i18n.language,
      }, ref: { collectionId: 'teammates', kind: 'bot', id: `working:${botId}/${phase}` } }]).then(value => {
        if (cancelled || !value || typeof value !== 'object') return;
        const blocks = (value as { blocks?: unknown }).blocks;
        if (!Array.isArray(blocks)) return;
        const text = blocks.find(block => block?.id === 'working' && block.primitive === 'status')?.fallbackMarkdown;
        if (typeof text === 'string' && text.trim() && text.length <= 160) setCaption({ scope, text });
      }).catch(() => { /* Older hosts retain the local factual caption. */ });
    }
    return () => { cancelled = true; };
  }, [scope, invoke]);
  if (!shown) return null;
  return reconnectAttempt ? t(reconnectAttempt.kind === 'overload' ? 'session.screen.modelBusyRetrying'
    : reconnectAttempt.kind === 'rate-limit' ? 'session.screen.rateLimitRetrying' : 'session.screen.networkReconnecting')
    : caption?.scope === scope ? caption.text : t(`devices.companions.working.${phase ?? 'thinking'}`);
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
