import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { MainWindowEmptyState, StatusDot } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceHostOnline, readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  type HostedRemoteCollectionItem,
  listRemoteCollection,
  mergeRemoteCollectionHostShards,
  normalizeRemoteCollectionItems,
  parseRemoteResourceTargets,
} from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
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
  const {
    connectionEpoch,
    status: relayStatus,
    presenceVersion,
    getPresenceAvailability,
    invoke,
    onRemoteResourceChanged,
    subscribe,
    unsubscribe,
  } = useDeviceLink();
  const { accountGeneration, user } = useAuth();
  const cacheOwner = `${user?.id ?? ''}:${accountGeneration}`;
  const accountRef = useRef(accountGeneration);
  accountRef.current = accountGeneration;
  const [replyEpochs, setReplyEpochs] = useState<Record<string, number>>({});
  const presenceKey = targets.map((host) => `${host.deviceId}:${getPresenceAvailability(host.deviceId)}`).join('|');
  // Reading presenceVersion makes the authoritative availability projection reactive.
  void presenceVersion;
  const [itemsAccount, setItemsAccount] = useState(accountGeneration);
  const [items, setItems] = useState<HostedResourceItem[]>(() => readRemoteCollectionCache(cacheOwner, collectionId));
  const loadGenerationRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (visible: boolean) => {
    const generation = ++loadGenerationRef.current;
    const expectedAccount = accountGeneration;
    if (!collectionId || targets.length === 0) {
      setItems([]);
      setError(t('devices.resources.noHosts'));
      setLoading(false);
      return;
    }
    if (visible) setRefreshing(true);
    else setLoading(true);
    const results = await Promise.allSettled(targets.map(async (host) => {
      if (relayStatus !== 'online' || getPresenceAvailability(host.deviceId) === false) throw new Error(t('devices.resources.hostOffline'));
      return { host, response: await listRemoteCollection(invoke, host, collectionId, i18n.language) };
    }));
    if (loadGenerationRef.current !== generation || accountRef.current !== expectedAccount) return;
    const next: HostedResourceItem[] = [];
    const failures: string[] = [];
    const successfulDeviceIds = new Set<string>();
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(formatRemoteError(result.reason));
        continue;
      }
      successfulDeviceIds.add(result.value.host.deviceId);
      const rawItems = normalizeRemoteCollectionItems(result.value.response, collectionId);
      for (const item of rawItems) {
        next.push({
          key: `${result.value.host.deviceId}:${item.ref.kind}:${item.ref.id}`,
          host: result.value.host,
          item,
        });
      }
    }
    setReplyEpochs(Object.fromEntries([...successfulDeviceIds].map((id) => [id, connectionEpoch])));
    const allHostsFailed = failures.length === targets.length;
    setItemsAccount(expectedAccount);
    setItems((current) => {
      const merged = allHostsFailed ? current : mergeRemoteCollectionHostShards(current, next, successfulDeviceIds, targets);
      writeRemoteCollectionCache(cacheOwner, collectionId, merged);
      return merged;
    });
    setError(allHostsFailed ? failures.slice(0, 2).join('\n') : null);
    setLoading(false);
    setRefreshing(false);
  }, [accountGeneration, cacheOwner, collectionId, connectionEpoch, getPresenceAvailability, i18n.language, invoke, relayStatus, t, targets, presenceKey]);

  useEffect(() => {
    loadGenerationRef.current += 1;
    setItems(readRemoteCollectionCache(cacheOwner, collectionId));
    setItemsAccount(accountGeneration);
    setReplyEpochs({});
  }, [accountGeneration, cacheOwner, collectionId]);

  useFocusEffect(useCallback(() => {
    void load(false);
    return () => { loadGenerationRef.current += 1; };
  }, [connectionEpoch, load]));
  useFocusEffect(useCallback(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load(false);
    });
    return () => subscription.remove();
  }, [load]));
  useFocusEffect(useCallback(() => {
    if (!collectionId) return undefined;
    const cleanups = targets.map((target) => startFocusedTopicSubscription({
      deviceId: target.deviceId,
      owner: `remote-collection:${collectionId}:${target.deviceId}`,
      subscribe,
      topic: 'sessions',
      unsubscribe,
    }));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [collectionId, subscribe, targets, unsubscribe]));
  useEffect(() => onRemoteResourceChanged((deviceId, payload) => {
    if (
      payload.collectionId === collectionId
      && targets.some((target) => target.deviceId === deviceId)
    ) {
      void load(false);
    }
  }), [collectionId, load, onRemoteResourceChanged, targets]);

  const openItem = useCallback((hosted: HostedResourceItem) => {
    if (!isRemoteResourceHostOnline(relayStatus, getPresenceAvailability(hosted.host.deviceId), replyEpochs[hosted.host.deviceId], connectionEpoch)) return;
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
  }, [collectionId, connectionEpoch, getPresenceAvailability, guardedPush, i18n.language, relayStatus, replyEpochs]);

  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={styles.safeArea}
      testID="remoteResources.screen"
    >
      <SimpleStackHeader
        backTestID="remoteResources.backButton"
        onBack={() => goBackGuarded(router)}
        subtitle={targets.length > 1 ? t('devices.resources.hostCount', { count: targets.length }) : targets[0]?.deviceName}
        title={title || t('devices.resources.titleFallback')}
        titleTestID="remoteResources.title"
      />
      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.muted}>{t('devices.resources.loading')}</Text>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyContent : styles.listContent}
          data={itemsAccount === accountGeneration ? items : []}
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
            const online = isRemoteResourceHostOnline(relayStatus, getPresenceAvailability(hosted.host.deviceId), replyEpochs[hosted.host.deviceId], connectionEpoch);
            const status = !online ? t('devices.resources.hostOffline') : display.status
              ? resolveRemoteText(display.status.label, i18n.language)
              : '';
            const avatar = display.avatar?.kind === 'emoji' && display.avatar.value
              ? display.avatar.value
              : display.avatar?.fallbackText || titleText.slice(0, 1);
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
                  <Text style={styles.avatarText}>{avatar}</Text>
                  <View style={styles.connectionDot}><StatusDot tone={online ? 'ready' : 'off'} /></View>
                </View>
                <View style={styles.body}>
                  <View style={styles.titleRow}>
                    <Text numberOfLines={1} style={styles.title}>{titleText}</Text>
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
  connectionDot: { position: 'absolute', bottom: 0, right: 0 },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  avatarText: { color: colors.textPrimary, fontSize: typeScale.listTitle, fontWeight: fontWeight.semibold },
  body: { flex: 1, gap: spacing.xs, minWidth: 0 },
  titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  title: { color: colors.textPrimary, flex: 1, fontSize: typeScale.listTitle, fontWeight: fontWeight.semibold },
  time: { color: colors.textTertiary, fontSize: typeScale.footnote },
  subtitle: { color: colors.textSecondary, fontSize: typeScale.body },
  meta: { color: colors.textTertiary, fontSize: typeScale.footnote },
});
