import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult, BotDelegationCancelResult } from '@cindy/maker-shared/botDelegation';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, radius, typeScale } from '@/theme/tokens';
import type { NormalizedRemoteMessage } from './messageNormalize';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';

export function CompanionMessageCard({ message }: { message: NormalizedRemoteMessage }) {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ deviceId?: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const styles = useThemedStyles(makeStyles);
  const card = message.companion;
  if (!card) return null;
  if (card.kind === 'task' && card.meta.role === 'delegation-request') {
    return <CompanionTaskCard deviceId={deviceId} parentSessionId={message.source.sessionId} meta={card.meta} />;
  }
  if (card.kind === 'task') return <Text style={styles.note}>{t('devices.companions.messageSent')}{message.body ? ` · ${message.body}` : ''}</Text>;
  const meta = card.meta;
  return <Pressable accessibilityRole="button" style={styles.card} onPress={() => router.push({
    pathname: '/companions/direct/[threadId]',
    params: { deviceId, threadId: meta.threadId, botId: meta.viewerBotId },
  })}>
    <Text style={styles.title}>{t('devices.companions.privateChat', { name: meta.peerBotName })}</Text>
    <Text numberOfLines={2} style={styles.note}>{meta.preview}</Text>
  </Pressable>;
}

function CompanionTaskCard({ deviceId, parentSessionId, meta }: { deviceId: string; parentSessionId: string; meta: BotCollaborationMeta }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { invoke } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const { value, online, error, refresh } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId, 'maker:bot-delegations:list', [parentSessionId]);
  const row = value?.ok ? value.delegations.find((item) => item.id === meta.delegationId) : null;
  const [pending, setPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const childSessionId = row?.childSessionId || meta.childSessionId;
  const active = row && ['queued', 'running', 'waiting'].includes(row.status);
  const stop = async () => {
    if (!online || pending) return;
    setPending(true); setActionFailed(false);
    try {
      const result = await invoke<BotDelegationCancelResult>(deviceId, 'maker:bot-delegation:cancel', [parentSessionId, meta.delegationId]);
      setActionFailed(!result.ok); refresh();
    } catch { setActionFailed(true); }
    finally { setPending(false); }
  };
  return <View style={styles.card} testID="companion.taskCard">
    <Text style={styles.note}>{t('devices.companions.backgroundTask')}</Text>
    <Text style={styles.title}>{row?.title || meta.objective}</Text>
    <Text style={styles.note}>{!online ? t('devices.resources.hostOffline') : t(`devices.companions.status.${row?.status || 'unknown'}`)}</Text>
    {row?.pendingInteraction ? <Text style={styles.note}>{row.pendingInteraction.summary}</Text> : null}
    {row?.resultSummary ? <Text style={styles.note}>{row.resultSummary}</Text> : null}
    <View style={styles.actions}>
      {childSessionId ? <Pressable accessibilityRole="button" style={styles.action} onPress={() => router.push({ pathname: '/sessions/[sessionId]', params: { deviceId, sessionId: childSessionId } })}>
        <Text style={styles.note}>{t('devices.companions.openTask')}</Text>
      </Pressable> : null}
      {active ? <Pressable accessibilityRole="button" disabled={!online || pending} style={[styles.action, (!online || pending) && styles.disabled]} onPress={() => void stop()}>
        <Text style={styles.note}>{t('devices.companions.stopTask')}</Text>
      </Pressable> : null}
      {error ? <Pressable accessibilityRole="button" style={styles.action} onPress={refresh}><Text style={styles.note}>{t('devices.resources.retry')}</Text></Pressable> : null}
    </View>
    {actionFailed ? <Text style={styles.error}>{t('devices.companions.actionFailed')}</Text> : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { marginVertical: spacing.sm, padding: spacing.md, gap: spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceElevated, borderRadius: radius.container },
  title: { color: colors.textPrimary, fontSize: typeScale.body },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote },
  error: { color: colors.statusError, fontSize: typeScale.footnote },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: { minHeight: 44, paddingHorizontal: spacing.sm, justifyContent: 'center' },
  disabled: { opacity: 0.5 },
});
