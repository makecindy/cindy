import { useCallback } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BotDirectMessageThreadResult } from '@cindy/maker-shared/botDirectMessage';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { useRemoteCompanionQuery } from '@/session/useRemoteCompanionQuery';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

export default function CompanionDirectMessages() {
  const params = useLocalSearchParams<{ deviceId: string; botId: string; threadId: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const botId = typeof params.botId === 'string' ? params.botId : '';
  const threadId = typeof params.threadId === 'string' ? params.threadId : '';
  const { t } = useTranslation();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { subscribe, unsubscribe } = useDeviceLink();
  const { value, error, online, refresh } = useRemoteCompanionQuery<BotDirectMessageThreadResult>(deviceId, 'maker:bot-direct-message-thread:get', [threadId, botId]);
  useFocusEffect(useCallback(() => startFocusedTopicSubscription({ deviceId, owner: `companion-direct:${threadId}`, topic: 'sessions', subscribe, unsubscribe }), [deviceId, threadId, subscribe, unsubscribe]));
  const thread = value?.ok ? value.thread : null;
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen}>
    <SimpleStackHeader title={thread ? `${thread.botAName} · ${thread.botBName}` : t('devices.companions.messages')} subtitle={t('devices.companions.readOnly')} onBack={() => goBackGuarded(router)} />
    <ScrollView contentContainerStyle={styles.content}>
      {!online ? <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text> : null}
      {thread?.messages.map((message) => <Text selectable key={message.id} style={styles.message}>{`${message.senderBotName}\n${message.content}`}</Text>)}
      {!thread && online ? <Text style={styles.note}>{error || value?.ok === false ? t('devices.companions.actionFailed') : t('devices.resources.loading')}</Text> : null}
      {error || value?.ok === false ? <MainWindowActionButton action={{ label: t('devices.resources.retry'), onPress: refresh }} /> : null}
    </ScrollView>
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, gap: spacing.lg },
  message: { color: colors.textPrimary, fontSize: typeScale.body, backgroundColor: colors.surfaceElevated, padding: spacing.md },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote },
});
