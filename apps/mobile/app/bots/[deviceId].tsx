import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react-native';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/AppText';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import {
  MainWindowEmptyState,
  MainWindowRowButton,
  RemoteListSyncingPlaceholder,
  ScreenHeader,
} from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useRemoteSyncTask } from '@/device-link/remoteSyncTask';
import {
  isRemoteBotsUnsupported,
  normalizeRemoteBotProfiles,
  remoteBotCanOpen,
  resolveRemoteBotAvatarColor,
  type RemoteBotProfile,
} from '@/bots/remoteBots';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

function routeText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function RemoteBotsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const params = useLocalSearchParams<{ deviceId: string; name?: string; deviceName?: string }>();
  const deviceId = routeText(params.deviceId);
  const deviceName = routeText(params.name) || routeText(params.deviceName) || deviceId;
  const { connectionIssue, invoke, status } = useDeviceLink();
  const [bots, setBots] = useState<RemoteBotProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncBots = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await withTransientRemoteRetry(() => invoke<unknown>(deviceId, 'local-db:bots:list', []));
      setBots(normalizeRemoteBotProfiles(raw));
      setUnsupported(false);
      setLastSyncedAt(Date.now());
    } catch (err) {
      if (isRemoteBotsUnsupported(err)) {
        setUnsupported(true);
        setBots([]);
      } else {
        setError(formatRemoteError(err));
      }
    } finally {
      setHasSynced(true);
      setLoading(false);
    }
  }, [deviceId, invoke]);
  const loadBots = useRemoteSyncTask(syncBots);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  const openBot = useCallback((bot: RemoteBotProfile) => {
    if (!remoteBotCanOpen(bot)) return;
    guardedPush({
      pathname: '/sessions/[sessionId]',
      params: { sessionId: bot.canonicalSessionId!, deviceId, deviceName },
    });
  }, [deviceId, deviceName, guardedPush]);

  return (
    <SafeAreaView style={styles.safeArea} testID="remoteBots.screen">
      <ScreenHeader
        backTestID="remoteBots.back"
        eyebrow={t('devices.bots.eyebrow')}
        onBack={() => goBackGuarded(router)}
        subtitle={t('devices.bots.subtitle', { deviceName })}
        title={t('devices.bots.title')}
      />
      <ConnectionBanner
        error={error}
        issue={connectionIssue}
        lastSyncedAt={lastSyncedAt}
        loading={loading}
        onSync={() => void loadBots()}
        status={status}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadBots()} />}
      >
        {!hasSynced ? <RemoteListSyncingPlaceholder testID="remoteBots.syncing" /> : null}
        {unsupported ? (
          <MainWindowEmptyState
            centered
            copy={t('devices.bots.unsupportedCopy')}
            testID="remoteBots.unsupported"
            title={t('devices.bots.unsupportedTitle')}
          />
        ) : hasSynced && bots.length === 0 && !error ? (
          <MainWindowEmptyState
            centered
            copy={t('devices.bots.emptyCopy')}
            testID="remoteBots.empty"
            title={t('devices.bots.emptyTitle')}
          />
        ) : (
          <View style={styles.list}>
            {bots.map((bot) => {
              const openable = remoteBotCanOpen(bot);
              const channelKinds = bot.channels.filter((channel) => channel.enabled).map((channel) => channel.kind);
              const statusLabel = bot.status === 'archived'
                ? t('devices.bots.status.archived')
                : bot.status === 'paused'
                  ? t('devices.bots.status.paused')
                  : bot.status === 'error'
                    ? t('devices.bots.status.error')
                    : bot.status === 'deleting'
                      ? t('devices.bots.status.deleting')
                  : !bot.canonicalSessionId
                    ? t('devices.bots.status.needsDesktop')
                    : t('devices.bots.status.active');
              return (
                <MainWindowRowButton
                  accessibilityLabel={openable
                    ? t('devices.bots.openA11y', { name: bot.name })
                    : t('devices.bots.unavailableA11y', { name: bot.name, status: statusLabel })}
                  disabled={!openable}
                  key={bot.id}
                  onPress={() => openBot(bot)}
                  style={styles.row}
                  testID={`remoteBots.row.${bot.id}`}
                >
                  <View style={[
                    styles.avatar,
                    { backgroundColor: resolveRemoteBotAvatarColor(bot.avatarColor, colors) },
                  ]}>
                    <Text style={styles.avatarText}>{bot.avatar}</Text>
                  </View>
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={styles.name}>{bot.name}</Text>
                    <Text numberOfLines={2} style={styles.description}>
                      {bot.description || t('devices.bots.noDescription')}
                    </Text>
                    <Text numberOfLines={1} style={styles.meta}>
                      {statusLabel}{channelKinds.length ? ` · ${channelKinds.join(' · ')}` : ''}
                    </Text>
                  </View>
                  {openable
                    ? <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                    : loading
                      ? <ActivityIndicator color={colors.textTertiary} size="small" />
                      : <RefreshCw color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
                </MainWindowRowButton>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { flexGrow: 1, padding: spacing.lg },
  list: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  row: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 92,
    paddingHorizontal: spacing.md,
  },
  avatar: { alignItems: 'center', backgroundColor: colors.surfaceElevated, borderRadius: radius.pill, height: 44, justifyContent: 'center', width: 44 },
  avatarText: { fontSize: typeScale.title },
  rowText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  name: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  description: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  meta: { color: colors.textTertiary, fontSize: typeScale.caption },
});
