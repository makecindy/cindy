import { useRemoteResourceList } from '@/session/useRemoteResourceList';
import { isRemoteResourceUnread } from '@/device-link/remoteResourceCache';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  resolveRemoteText,
} from '@cindy/device-link';

import { Text } from '@/components/AppText';
import { useTeammateNavigation } from '@/session/useTeammateNavigation';
import { TeammateList } from '@/session/TeammateList';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { MainWindowEmptyState, StatusDot } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { useAuth } from '@/auth/AuthContext';
import {
  type HostedRemoteCollectionItem,
  parseRemoteResourceTargets,
} from '@/device-link/remoteResources';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale } from '@/theme/tokens';

type HostedResourceItem = HostedRemoteCollectionItem;

function timestampLabel(value: number | undefined, locale: string): string | null {
  if (!value || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function RemoteCollectionScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const teammates = useTeammateNavigation();
  const params = useLocalSearchParams<{
    collectionId?: string;
    title?: string;
    targets?: string;
  }>();
  const collectionId = Array.isArray(params.collectionId)
    ? params.collectionId[0] ?? ''
    : params.collectionId ?? '';
  const title = Array.isArray(params.title) ? params.title[0] : params.title;
  const targets = useMemo(() => parseRemoteResourceTargets(params.targets), [params.targets]);
  const list = useRemoteResourceList(collectionId, targets);
  const { items, loading, refreshing, error, isOnline, connectionState } = list;
  const load = list.refresh;
  const { user } = useAuth();

  const openItem = useCallback((hosted: HostedResourceItem) => {
    if (!isOnline(hosted.host)) return;
    if (hosted.item.ref.kind === 'bot') { void teammates.openTeammate(hosted); return; }
    guardedPush({
      pathname: '/resources/[collectionId]/[resourceId]',
      params: {
        collectionId,
        deviceId: hosted.host.deviceId,
        deviceName: hosted.host.deviceName,
        resourceId: hosted.item.ref.id,
        resourceKind: hosted.item.ref.kind,
        title: resolveRemoteText(hosted.item.display.title, i18n.language),
      },
    });
  }, [collectionId, guardedPush, i18n.language, isOnline, teammates.openTeammate]);

  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={styles.safeArea}
      testID="remoteResources.screen"
    >
      <SimpleStackHeader
        backTestID="remoteResources.backButton"
        onBack={() => goBackGuarded(router)}
        subtitle={collectionId === 'teammates' ? undefined : targets.length > 1 ? t('devices.resources.hostCount', { count: targets.length }) : targets[0]?.deviceName}
        title={title || t('devices.resources.titleFallback')}
        titleTestID="remoteResources.title"
      />
      {collectionId === 'teammates' ? <TeammateList
        items={items} loading={loading} refreshing={refreshing} error={error}
        connectionState={connectionState}
        isOnline={isOnline}
        onRefresh={() => void load(true)} onSelect={openItem} /> : loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.muted}>{t('devices.resources.loading')}</Text>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyContent : styles.listContent}
          data={items}
          keyExtractor={(item) => item.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
          renderItem={({ item: hosted }) => {
            const display = hosted.item.display;
            const titleText = resolveRemoteText(display.title, i18n.language);
            const subtitle = display.preview
              ? resolveRemoteText(display.preview, i18n.language)
              : display.subtitle
                ? resolveRemoteText(display.subtitle, i18n.language)
                : '';
            const online = isOnline(hosted.host);
            const status = !online ? t('devices.resources.hostOffline') : display.status
              ? resolveRemoteText(display.status.label, i18n.language)
              : '';
            const unread = hosted.item.ref.kind === 'bot' && isRemoteResourceUnread(user?.id ?? '', hosted.host.deviceId, hosted.item.ref.id, display.lastReplyAt);
            const time = timestampLabel(display.timestamp, i18n.language);
            return (
              <Pressable
                accessibilityLabel={[titleText, subtitle, status].filter(Boolean).join(', ')}
                accessibilityRole="button"
                accessibilityState={{ disabled: !online }}
                disabled={!online}
                onPress={() => openItem(hosted)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                testID={`remoteResources.item.${hosted.item.ref.id}`}
              >
                <View style={styles.avatar}>
                  <RemoteCompanionAvatar avatar={display.avatar} deviceId={hosted.host.deviceId} name={titleText} online={online} />
                  <View style={styles.connectionDot}><StatusDot tone={online ? 'ready' : 'off'} /></View>
                </View>
                <View style={styles.body}>
                  <View style={styles.titleRow}>
                    <Text numberOfLines={1} style={styles.title}>{titleText}</Text>
                    {unread ? <View accessibilityLabel={t('devices.companions.unread')} style={styles.unread} /> : null}
                    {time ? <Text numberOfLines={1} style={styles.time}>{time}</Text> : null}
                  </View>
                  {subtitle ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : null}
                  <Text numberOfLines={1} style={styles.meta}>
                    {[status, targets.length > 1 ? hosted.host.deviceName : ''].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              </Pressable>
            );
          }}
          ListEmptyComponent={(
            <MainWindowEmptyState
              copy={error ?? t('devices.resources.emptyCopy')}
              testID={error ? 'remoteResources.error' : 'remoteResources.empty'}
              title={error ? t('devices.resources.loadFailed') : t('devices.resources.emptyTitle')}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  center: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center' },
  muted: { color: colors.textSecondary, fontSize: typeScale.footnote },
  listContent: { gap: spacing.sm, padding: spacing.md },
  emptyContent: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surfaceListRow,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 78,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.72 },
  unread: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.statusAwaiting },
  connectionDot: { position: 'absolute', bottom: 0, right: 0 },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  body: { flex: 1, gap: spacing.xs, minWidth: 0 },
  titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  title: { color: colors.textPrimary, flex: 1, fontSize: typeScale.listTitle, fontWeight: fontWeight.semibold },
  time: { color: colors.textTertiary, fontSize: typeScale.footnote },
  subtitle: { color: colors.textSecondary, fontSize: typeScale.body },
  meta: { color: colors.textTertiary, fontSize: typeScale.footnote },
});
