import { prNumberLabel } from '@cindy/maker-shared';
import { prStatusQuery } from '@cindy/maker-shared';
import { formatLocalizedSeconds } from './sessionDurationFormat';
import { CompanionTaskResultCard } from './CompanionTaskResultCard';
import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { Animated, Easing, Linking, Pressable, StyleSheet, View } from 'react-native';
import {
  CircleAlert,
  CircleCheck,
  GitPullRequest,
  ChevronRight,
  Layers,
  Megaphone,
  TriangleAlert,
} from 'lucide-react-native';
import {
  MAX_STATUS_QUERIES,
  PR_STATUS_REFRESH_INTERVAL_MS,
  prStatusKey,
  sessionPrUrl,
  type SessionPrRef,
  type PrStatusResult,
} from '@cindy/maker-shared';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult, BotDelegationStatus } from '@cindy/maker-shared/botDelegation';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import type { BotDirectMessageMeta } from '@cindy/maker-shared/botDirectMessage';
import { resolveRemoteText } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  cachedBotItem,
  readRemoteResourceSnapshot,
  remoteResourceCacheRevision,
  subscribeRemoteResourceCache,
} from '@/device-link/remoteResourceCache';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import type { NormalizedRemoteMessage } from './messageNormalize';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';

const TRACE_AVATAR_SIZE = 20;
const TRACE_HIT_SLOP = { top: 6, bottom: 6 } as const;
const AUX_HIT_SLOP = { top: 6, bottom: 6 } as const;
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import { prStatusVisual } from './prStatusVisual';
import { useCompanionTaskSession } from './useCompanionTaskSession';

class CompanionRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean; resetKey: string }
> {
  state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; resetKey: string },
  ) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CompanionMessageCard({ message, deviceId, renderMarkdown }: {
  message: NormalizedRemoteMessage;
  deviceId: string;
  /** The conversation's Markdown renderer for frozen task results. */
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <CompanionRenderBoundary
      fallback={<Text style={styles.note}>{t('devices.companions.actionFailed')}</Text>}
      resetKey={message.key}
    >
      <CompanionMessageCardContent message={message} deviceId={deviceId} renderMarkdown={renderMarkdown} />
    </CompanionRenderBoundary>
  );
}

function CompanionMessageCardContent({ message, deviceId, renderMarkdown }: {
  message: NormalizedRemoteMessage;
  deviceId: string;
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const card = message.companion;
  if (!card) return null;
  if (card.kind === 'task' && card.meta.role === 'delegation-result') {
    return <CompanionTaskResultCard meta={card.meta} deviceId={deviceId} parentSessionId={message.source.sessionId} renderMarkdown={renderMarkdown} />;
  }
  if (card.kind === 'task' && card.meta.role === 'delegation-request') {
    return (
      <CompanionTaskCard
        deviceId={deviceId}
        parentSessionId={message.source.sessionId}
        meta={card.meta}
      />
    );
  }
  if (card.kind === 'task')
    return (
      <View style={styles.messageTrace} testID="companion.taskMessageTrace">
        <Megaphone size={iconSize.xs} color={colors.textTertiary} style={styles.traceIcon} />
        <Text style={[styles.note, styles.tertiary, styles.traceLabel]}>
          {t('devices.companions.messageSent')}
        </Text>
      </View>
    );
  return <CompanionPrivateTrace deviceId={deviceId} meta={card.meta} />;
}

/** Desktop BotDirectMessageCard: a separator pill with the peer's portrait, opening the read-only thread. */
function CompanionPrivateTrace({ deviceId, meta }: { deviceId: string; meta: BotDirectMessageMeta }) {
  const { t, i18n } = useTranslation();
  const push = useGuardedPush();
  const { user } = useAuth();
  const { status, getPresenceAvailability } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const userId = user?.id ?? '';
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  useEffect(() => { if (userId) void readRemoteResourceSnapshot(userId); }, [userId]);
  const peer = cachedBotItem(userId, 'teammates', deviceId, meta.peerBotId);
  const peerName = (peer ? resolveRemoteText(peer.display.title, i18n.language) : '')
    || meta.peerBotName || meta.peerBotId;
  return (
    <View style={styles.privateTrace} testID="companion.privateTrace">
      <Pressable
        accessibilityRole="button"
        hitSlop={TRACE_HIT_SLOP}
        style={styles.traceTouchTarget}
        onPress={() =>
          push({
            pathname: '/companions/direct/[threadId]',
            params: {
              deviceId,
              threadId: meta.threadId,
              botId: meta.viewerBotId,
            },
          })
        }
      >
        {({ pressed }) => (
          <View style={[styles.traceAction, pressed && mobileInteractionStyles.pressed]}>
            {peer ? <RemoteCompanionAvatar avatar={peer.display.avatar} deviceId={deviceId} name={peerName}
              online={status === 'online' && getPresenceAvailability(deviceId) !== false} size={TRACE_AVATAR_SIZE} framed /> : null}
            <Text numberOfLines={1} style={[styles.note, styles.traceLabel]}>
              {t(meta.direction === 'sent' ? 'devices.companions.sentTo' : 'devices.companions.receivedFrom', { name: peerName })}
            </Text>
            <ChevronRight size={iconSize.sm} color={colors.textTertiary} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

/** Stored rows that ended; an unfinished stored row is never shown as live (nothing updates it now). */
const TERMINAL_STATUSES: ReadonlySet<BotDelegationStatus> = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

/**
 * Read-only card of a V1 background task a teammate started (also from a group, BotGroupTaskCard).
 * Live state comes from the original task; the stored row only supplies its ended status and facts.
 */
export function CompanionTaskCard({
  deviceId,
  parentSessionId,
  meta,
}: {
  deviceId: string;
  parentSessionId: string;
  meta: BotCollaborationMeta;
}) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { value, online, error, refresh } = useRemoteCompanionQuery<BotDelegationListResult>(
    deviceId,
    'maker:bot-delegations:list',
    [parentSessionId],
  );
  const row =
    value?.ok && Array.isArray(value.delegations)
      ? (value.delegations.find((item) => item.id === meta.delegationId) ?? null)
      : null;
  const childSessionId = row?.childSessionId || meta.childSessionId;
  const task = useCompanionTaskSession(deviceId, childSessionId);
  // Like Desktop, the original task can still be running after the stored task ended.
  const rowEnded = Boolean(row && TERMINAL_STATUSES.has(row.status));
  const status =
    task.activity?.phase === 'error' ? 'failed'
    : task.waiting || task.activity?.phase === 'needs-interaction' ? 'waiting'
    : task.running ? 'running'
    : task.activity?.phase === 'completed' ? 'completed'
    : row && rowEnded ? row.status
    : 'unknown';
  const title = task.session?.title || row?.title || meta.objective.trim().split('\n')[0] || t('devices.companions.backgroundTask');
  const [actionFailed, setActionFailed] = useState(false);
  const [showPrs, setShowPrs] = useState(false);
  const [now, setNow] = useState(Date.now);
  const ticking = Boolean(row) && !rowEnded && status === 'running';
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const seconds = row && (ticking || rowEnded)
    ? Math.max(
        0,
        Math.floor(((ticking ? now : (row.completedAt ?? row.updatedAt)) - row.createdAt) / 1000),
      )
    : null;
  const duration =
    seconds === null || !Number.isFinite(seconds)
      ? null
      : seconds < 60
        ? t('devices.companions.duration.seconds', { n: seconds })
        : seconds < 3600
          ? t('devices.companions.duration.minutes', {
              n: Math.floor(seconds / 60),
            })
          : seconds >= 86_400
            ? formatLocalizedSeconds(seconds)
            : t('devices.companions.duration.hoursMinutes', {
                h: Math.floor(seconds / 3600),
                m: Math.floor(seconds / 60) % 60,
              });
  const associated = useRemoteCompanionQuery<SessionPrRef[]>(
    deviceId,
    'git-context:pr-refs:list',
    [childSessionId],
    {
      enabled: Boolean(childSessionId),
      refreshIntervalMs: PR_STATUS_REFRESH_INTERVAL_MS,
      refreshKey: row?.updatedAt,
    },
  );
  const prs = Array.isArray(associated.value) ? associated.value.slice(0, MAX_STATUS_QUERIES) : [];
  const prStatuses = useRemoteCompanionQuery<PrStatusResult[]>(
    deviceId,
    'git-context:pr-status',
    [
      {
        sessionId: childSessionId,
        queries: prs.map(prStatusQuery),
      },
    ],
    {
      enabled: Boolean(childSessionId) && prs.length > 0,
      refreshIntervalMs: PR_STATUS_REFRESH_INTERVAL_MS,
    },
  );
  const prIcon = (ref: SessionPrRef) => {
    const result = Array.isArray(prStatuses.value)
      ? prStatuses.value.find((s) => prStatusKey(s) === prStatusKey(ref))
      : undefined;
    const { Icon, color } = prStatusVisual(
      result?.ok ? result.status : null,
      colors,
      result?.ok ? result.conflicts : null,
    );
    return <Icon size={iconSize.sm} color={color} />;
  };
  const openPr = (url: string) => {
    setShowPrs(false);
    setActionFailed(false);
    void Linking.openURL(url).catch(() => setActionFailed(true));
  };
  const openTask = childSessionId && deviceId && !task.originConflict ? () => push({
    pathname: '/sessions/[sessionId]',
    params: { deviceId, sessionId: childSessionId },
  }) : undefined;
  const stale = (!online || error || associated.error || prStatuses.error
    || (Array.isArray(prStatuses.value) && prStatuses.value.some((result) => !result.ok))) && (row || task.session);
  const facts = [
    duration,
    Array.isArray(row?.artifacts) && row.artifacts.length > 0
      ? t('devices.companions.artifactCount', { count: row.artifacts.length })
      : null,
    prs.length === 1
      ? `${prs[0].owner}/${prs[0].repo} ${prNumberLabel(prs[0])}`
      : prs.length > 1
        ? t(
            prs.every((pr) => pr.provider === 'gitlab')
              ? 'devices.companions.mrCount'
              : prs.some((pr) => pr.provider === 'gitlab')
                ? 'devices.companions.prMrCount'
                : 'devices.companions.prCount',
            { count: prs.length },
          )
        : null,
  ].filter((part): part is string => !!part);
  return (
    <View style={styles.card} testID="companion.taskCard">
      {/* K6: the whole card opens the task; secondary actions sit below as small buttons. */}
      <Pressable accessibilityRole="button" disabled={!openTask} onPress={openTask}
        accessibilityLabel={`${t('devices.companions.backgroundTask')}, ${title}, ${t(`devices.companions.status.${status}`)}`}
        accessibilityHint={openTask ? t('devices.companions.openTask') : undefined}
        style={({ pressed }) => [styles.head, pressed && openTask && mobileInteractionStyles.pressed]} testID="companion.taskCard.open">
        <View style={styles.eyebrow}>
          <Layers size={iconSize.sm} color={colors.textSecondary} />
          <Text style={styles.eyebrowText}>{t('devices.companions.backgroundTask')}</Text>
          {openTask ? <ChevronRight size={iconSize.md} color={colors.textTertiary} /> : null}
        </View>
        <Text numberOfLines={2} style={styles.title}>{title}</Text>
        <View style={styles.metadata}>
          <TaskStatusMark status={status} />
          <Text style={styles.note}>{t(`devices.companions.status.${status}`)}</Text>
          {facts.map((part) => <Text key={part} numberOfLines={1} style={styles.note}>{`· ${part}`}</Text>)}
        </View>
      </Pressable>
      {stale ? (
        <View style={styles.messageTrace}>
          <TriangleAlert size={iconSize.xs} color={colors.textTertiary} style={styles.traceIcon} />
          <Text style={[styles.note, styles.tertiary, styles.traceLabel]}>{t('devices.companions.stale')}</Text>
        </View>
      ) : !online ? (
        <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text>
      ) : null}
      {row?.lastError && (row.status === 'failed' || row.status === 'timed-out') ? (
        <Text numberOfLines={2} style={styles.error}>
          {row.lastError.replace(/^[A-Z_]+:\s*/, '')}
        </Text>
      ) : null}
      {prs.length > 0 || error ? (
        <View style={styles.actions}>
          {prs.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={prs.length > 1 ? { expanded: showPrs } : undefined}
              hitSlop={AUX_HIT_SLOP}
              style={({ pressed }) => [styles.action, pressed && mobileInteractionStyles.pressed]}
              onPress={() =>
                prs.length === 1 ? openPr(sessionPrUrl(prs[0])) : setShowPrs(!showPrs)
              }
            >
              {prs.length === 1 ? (
                prIcon(prs[0])
              ) : (
                <GitPullRequest size={iconSize.sm} color={colors.textPrimary} />
              )}
              <Text style={styles.actionLabel}>
                {t(
                  prs.some((pr) => pr.provider === 'gitlab')
                    ? prs.every((pr) => pr.provider === 'gitlab')
                      ? 'devices.companions.viewMr'
                      : 'devices.companions.viewPrMr'
                    : 'devices.companions.viewPr',
                )}
              </Text>
            </Pressable>
          ) : null}
          {error ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={AUX_HIT_SLOP}
              style={({ pressed }) => [styles.action, pressed && mobileInteractionStyles.pressed]}
              onPress={() => {
                refresh();
                task.refresh();
              }}
            >
              <Text style={styles.actionLabel}>{t('devices.resources.retry')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {showPrs && prs.length > 1 ? (
        <View>
          {prs.map((pr) => (
            <Pressable
              key={pr.url}
              accessibilityRole="link"
              style={styles.prOption}
              onPress={() => openPr(sessionPrUrl(pr))}
            >
              {prIcon(pr)}
              <Text style={styles.note}>
                {pr.owner}/{pr.repo} {prNumberLabel(pr)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {actionFailed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('devices.companions.actionFailed')}
        </Text>
      ) : null}
    </View>
  );
}

/** K7: running breathes in Heart Orange, done is a check, failure a red alert; nothing else gets a color. */
function TaskStatusMark({ status }: { status: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const animate = useReduceMotionEnabled() === false;
  const opacity = useRef(new Animated.Value(1)).current;
  const running = status === 'running' || status === 'queued';
  useEffect(() => {
    if (!running || !animate) { opacity.setValue(1); return; }
    const step = (toValue: number) => Animated.timing(opacity, { toValue, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([step(0.3), step(1)]));
    loop.start();
    return () => loop.stop();
  }, [animate, opacity, running]);
  if (running) return <Animated.View style={[styles.runningDot, { opacity }]} testID="companion.taskCard.running" />;
  if (status === 'completed') return <CircleCheck size={iconSize.xs} color={colors.textSecondary} />;
  if (status === 'failed' || status === 'timed-out') return <CircleAlert size={iconSize.xs} color={colors.statusError} />;
  return null;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // K10: a small pill under the reply text, left aligned with it.
    privateTrace: { flexDirection: 'row', alignItems: 'center' },
    traceTouchTarget: { maxWidth: '100%', flexShrink: 1 },
    traceAction: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, minHeight: 32, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, borderRadius: radius.pill, backgroundColor: colors.surfaceElevated,
      paddingLeft: spacing.xs + 2, paddingRight: spacing.sm + 2 },
    traceLabel: { flexShrink: 1 },
    // Quiet persisted traces (Desktop BotSessionTaskMessageTrace): tertiary, icon aligned to the first line.
    messageTrace: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginVertical: spacing.xs },
    traceIcon: { marginTop: 3, flexShrink: 0 },
    tertiary: { color: colors.textTertiary },
    runningDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.statusAccent },
    // K1 card shell.
    card: {
      marginVertical: spacing.sm,
      padding: spacing.lg,
      gap: spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.container,
    },
    head: { gap: spacing.xs },
    eyebrow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, minHeight: lineHeight.caption },
    eyebrowText: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
    title: { marginTop: 2, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
    note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
    actionLabel: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
    // Paragraph errors follow errorText; red is reserved for the status dot.
    error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
    metadata: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.xs + 2 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
    // K6 auxiliary actions: 32 visible (hitSlop to 44), chip fill, no border.
    action: {
      minHeight: 32,
      paddingHorizontal: spacing.md,
      gap: spacing.xs + 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceChip,
    },
    prOption: { minHeight: 44, justifyContent: 'center' },
  });
