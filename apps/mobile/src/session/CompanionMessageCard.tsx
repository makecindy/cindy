import { CompanionTaskResultCard } from './CompanionTaskResultCard';
import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  FileText,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Square,
  ArrowLeftRight,
  ChevronRight,
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
import {
  BOT_DELEGATION_STATUSES,
  type BotDelegationListResult,
  type BotDelegationCancelResult,
} from '@cindy/maker-shared/botDelegation';
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
import { spacing, radius, typeScale, iconSize, fontWeight } from '@/theme/tokens';
import type { NormalizedRemoteMessage } from './messageNormalize';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';

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

export function CompanionMessageCard({ message, renderMarkdown }: {
  message: NormalizedRemoteMessage;
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
      <CompanionMessageCardContent message={message} renderMarkdown={renderMarkdown} />
    </CompanionRenderBoundary>
  );
}

function CompanionMessageCardContent({ message, renderMarkdown }: {
  message: NormalizedRemoteMessage;
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ deviceId?: string }>();
  const deviceId = typeof params.deviceId === 'string' ? params.deviceId : '';
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const card = message.companion;
  if (!card) return null;
  if (card.kind === 'task' && card.meta.role === 'delegation-result') {
    return <CompanionTaskResultCard meta={card.meta} deviceId={deviceId} renderMarkdown={renderMarkdown} />;
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
  const router = useRouter();
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
      <View style={styles.traceLine} />
      <Pressable
        accessibilityRole="button"
        style={styles.traceTouchTarget}
        onPress={() =>
          router.push({
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
              online={status === 'online' && getPresenceAvailability(deviceId) !== false} size={iconSize.md} framed /> : null}
            <ArrowLeftRight size={iconSize.xs} color={colors.textTertiary} />
            <Text numberOfLines={2} style={[styles.note, styles.traceLabel]}>
              {t(meta.direction === 'sent' ? 'devices.companions.sentTo' : 'devices.companions.receivedFrom', { name: peerName })}
            </Text>
            <ChevronRight size={iconSize.xs} color={colors.textTertiary} />
          </View>
        )}
      </Pressable>
      <View style={styles.traceLine} />
    </View>
  );
}

function CompanionTaskCard({
  deviceId,
  parentSessionId,
  meta,
}: {
  deviceId: string;
  parentSessionId: string;
  meta: BotCollaborationMeta;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { invoke } = useDeviceLink();
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
  // Desktop parity: until the first read settles the task is still starting;
  // a settled read without this row, or a host that cannot be read, is unverifiable.
  const resolved = value !== null || error || !online;
  const status =
    row && (BOT_DELEGATION_STATUSES as readonly string[]).includes(row.status)
      ? row.status
      : resolved ? 'unknown' : 'queued';
  const statusColor =
    status === 'completed' ? colors.statusDone
      : status === 'failed' || status === 'timed-out' ? colors.statusError
      : status === 'running' ? colors.statusAccent
      : status === 'waiting' ? colors.statusAwaiting
      : colors.textTertiary;
  const title = row?.title || meta.objective.trim().split('\n')[0] || t('devices.companions.backgroundTask');
  const [pending, setPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [showPrs, setShowPrs] = useState(false);
  // Equal intrinsic widths in every language; the 32px visible frame sits inside a 44px hit target.
  const [actionWidth, setActionWidth] = useState(104);
  const [now, setNow] = useState(Date.now);
  const childSessionId = row?.childSessionId || meta.childSessionId;
  const active = Boolean(row && ['queued', 'running', 'waiting'].includes(row.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const seconds = row
    ? Math.max(
        0,
        Math.floor(((active ? now : (row.completedAt ?? row.updatedAt)) - row.createdAt) / 1000),
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
        queries: prs.map(({ owner, repo, prNumber }) => ({ owner, repo, prNumber })),
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
    const kind = result?.ok ? result.status : null;
    const Icon =
      kind === 'merged'
        ? GitMerge
        : kind === 'closed'
          ? GitPullRequestClosed
          : kind === 'draft'
            ? GitPullRequestDraft
            : GitPullRequest;
    return (
      <Icon
        size={iconSize.sm}
        color={
          kind === 'open'
            ? colors.statusDone
            : kind === 'closed'
              ? colors.statusError
              : kind === 'draft'
                ? colors.textTertiary
                : colors.textSecondary
        }
      />
    );
  };
  const openPr = (url: string) => {
    setShowPrs(false);
    setActionFailed(false);
    void Linking.openURL(url).catch(() => setActionFailed(true));
  };
  const stop = async () => {
    if (!online || pending) return;
    setPending(true);
    setActionFailed(false);
    try {
      const result = await invoke<BotDelegationCancelResult>(
        deviceId,
        'maker:bot-delegation:cancel',
        [parentSessionId, meta.delegationId],
      );
      setActionFailed(!result.ok);
      refresh();
    } catch {
      setActionFailed(true);
    } finally {
      setPending(false);
    }
  };
  const rememberActionWidth = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent?.layout?.width;
    if (typeof width !== 'number' || !Number.isFinite(width)) return;
    const measuredWidth = Math.ceil(width);
    setActionWidth((current) => Math.max(current, measuredWidth));
  };
  return (
    <View style={styles.card} testID="companion.taskCard">
      <View style={styles.header}>
        <Text numberOfLines={2} style={[styles.title, styles.taskTitle]}>
          {title}
        </Text>
        <View style={styles.status}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.note, { color: statusColor }]}>
            {t(`devices.companions.status.${status}`)}
          </Text>
        </View>
      </View>
      <View style={styles.metadata}>
        {duration ? <Text style={styles.note}>{duration}</Text> : null}
        {Array.isArray(row?.artifacts) && row.artifacts.length > 0 ? (
          <Text style={styles.note}>
            {t('devices.companions.artifactCount', {
              count: row.artifacts.length,
            })}
          </Text>
        ) : null}
        {prs.length === 1 ? (
          <Text numberOfLines={1} style={styles.note}>
            {prs[0].owner}/{prs[0].repo} #{prs[0].prNumber}
          </Text>
        ) : prs.length > 1 ? (
          <Text style={styles.note}>{t('devices.companions.prCount', { count: prs.length })}</Text>
        ) : null}
      </View>
      {(!online ||
        error ||
        associated.error ||
        prStatuses.error ||
        (Array.isArray(prStatuses.value) && prStatuses.value.some((status) => !status.ok))) &&
      row ? (
        <View style={styles.messageTrace}>
          <TriangleAlert size={iconSize.xs} color={colors.textTertiary} style={styles.traceIcon} />
          <Text style={[styles.note, styles.tertiary, styles.traceLabel]}>{t('devices.companions.stale')}</Text>
        </View>
      ) : !online ? (
        <Text style={styles.note}>{t('devices.resources.hostOffline')}</Text>
      ) : null}
      {row?.status === 'waiting' ? (
        <Text numberOfLines={2} style={styles.note}>
          {row.pendingInteraction?.summary || t('devices.companions.retrying')}
        </Text>
      ) : null}
      {row?.lastError && (row.status === 'failed' || row.status === 'timed-out') ? (
        <Text numberOfLines={2} style={styles.error}>
          {row.lastError.replace(/^[A-Z_]+:\s*/, '')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {prs.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={prs.length > 1 ? { expanded: showPrs } : undefined}
            style={styles.touchTarget}
            onPress={() => (prs.length === 1 ? openPr(sessionPrUrl(prs[0])) : setShowPrs(!showPrs))}
          >
            {({ pressed }) => (
              <View
                onLayout={rememberActionWidth}
                style={[
                  styles.action,
                  { minWidth: actionWidth },
                  pressed && mobileInteractionStyles.pressed,
                ]}
              >
                {prs.length === 1 ? (
                  prIcon(prs[0])
                ) : (
                  <GitPullRequest size={iconSize.sm} color={colors.textPrimary} />
                )}
                <Text style={styles.actionLabel}>{t('devices.companions.viewPr')}</Text>
              </View>
            )}
          </Pressable>
        ) : null}
        {childSessionId ? (
          <Pressable
            accessibilityRole="button"
            style={styles.touchTarget}
            onPress={() =>
              router.push({
                pathname: '/sessions/[sessionId]',
                params: { deviceId, sessionId: childSessionId },
              })
            }
          >
            {({ pressed }) => (
              <View
                onLayout={rememberActionWidth}
                style={[
                  styles.action,
                  { minWidth: actionWidth },
                  pressed && mobileInteractionStyles.pressed,
                ]}
              >
                <FileText size={iconSize.sm} color={colors.textPrimary} />
                <Text style={styles.actionLabel}>{t('devices.companions.openTask')}</Text>
              </View>
            )}
          </Pressable>
        ) : null}
        {active ? (
          <Pressable
            accessibilityRole="button"
            disabled={!online || pending}
            style={[styles.touchTarget, (!online || pending) && styles.disabled]}
            onPress={() => void stop()}
          >
            {({ pressed }) => (
              <View
                onLayout={rememberActionWidth}
                style={[
                  styles.action,
                  { minWidth: actionWidth },
                  pressed && mobileInteractionStyles.pressed,
                ]}
              >
                <Square size={iconSize.sm} color={colors.textPrimary} />
                <Text style={styles.actionLabel}>{t('devices.companions.stopTask')}</Text>
              </View>
            )}
          </Pressable>
        ) : null}
        {error ? (
          <Pressable accessibilityRole="button" style={styles.touchTarget} onPress={refresh}>
            <View style={[styles.action, { minWidth: actionWidth }]}>
              <Text style={styles.actionLabel}>{t('devices.resources.retry')}</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
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
                {pr.owner}/{pr.repo} #{pr.prNumber}
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

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    privateTrace: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    traceLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    traceTouchTarget: { minHeight: 44, maxWidth: '90%', justifyContent: 'center', flexShrink: 1 },
    traceAction: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
    traceLabel: { flexShrink: 1 },
    // Quiet persisted traces (Desktop BotSessionTaskMessageTrace): tertiary, icon aligned to the first line.
    messageTrace: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginVertical: spacing.xs },
    traceIcon: { marginTop: 3, flexShrink: 0 },
    tertiary: { color: colors.textTertiary },
    status: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
    statusDot: { width: 6, height: 6, borderRadius: radius.pill },
    card: {
      marginVertical: spacing.sm,
      padding: spacing.md,
      gap: spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.container,
    },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    taskTitle: { flex: 1, minWidth: 0 },
    title: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
    note: { color: colors.textSecondary, fontSize: typeScale.footnote },
    actionLabel: { color: colors.textPrimary, fontSize: typeScale.footnote },
    // Paragraph errors follow errorText; red is reserved for the status dot.
    error: { color: colors.errorText, fontSize: typeScale.footnote },
    metadata: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.sm },
    touchTarget: { minHeight: 44, justifyContent: 'center' },
    action: {
      minHeight: 32,
      minWidth: 104,
      paddingHorizontal: 12,
      paddingVertical: 5,
      gap: 6,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceElevated,
    },
    prOption: { minHeight: 44, justifyContent: 'center' },
    disabled: { opacity: 0.5 },
  });
