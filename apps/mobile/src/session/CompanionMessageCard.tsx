import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { FileText, GitPullRequest, Square } from 'lucide-react-native';
import { extractPrRefs } from '@cindy/maker-shared';
import { useTranslation } from 'react-i18next';
import type {
  BotDelegationListResult,
  BotDelegationCancelResult,
} from '@cindy/maker-shared/botDelegation';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, radius, typeScale, iconSize } from '@/theme/tokens';
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
      <Text style={styles.note}>
        {t('devices.companions.messageSent')}
        {message.body ? ` · ${message.body}` : ''}
      </Text>
    );
  const meta = card.meta;
  return (
    <Pressable
      accessibilityRole="button"
      style={styles.card}
      onPress={() =>
        router.push({
          pathname: '/companions/direct/[threadId]',
          params: { deviceId, threadId: meta.threadId, botId: meta.viewerBotId },
        })
      }
    >
      <Text style={styles.title}>
        {t('devices.companions.privateChat', { name: meta.peerBotName })}
      </Text>
      <Text numberOfLines={2} style={styles.note}>
        {meta.preview}
      </Text>
    </Pressable>
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
  const row = value?.ok ? value.delegations.find((item) => item.id === meta.delegationId) : null;
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
          ? t('devices.companions.duration.minutes', { n: Math.floor(seconds / 60) })
          : t('devices.companions.duration.hoursMinutes', {
              h: Math.floor(seconds / 3600),
              m: Math.floor(seconds / 60) % 60,
            });
  const prs = extractPrRefs(row?.resultSummary ?? '');
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
  return (
    <View style={styles.card} testID="companion.taskCard">
      <View style={styles.header}>
        <Text numberOfLines={2} style={[styles.title, styles.taskTitle]}>
          {row?.title || meta.objective.trim().split('\n')[0]}
        </Text>
        <Text
          style={[
            styles.note,
            row?.status === 'completed' && styles.success,
            (row?.status === 'failed' || row?.status === 'timed-out') && styles.error,
          ]}
        >
          {t(`devices.companions.status.${row?.status || 'unknown'}`)}
        </Text>
      </View>
      <View style={styles.metadata}>
        {duration ? <Text style={styles.note}>{duration}</Text> : null}
        {(row?.artifacts?.length ?? 0) > 0 ? (
          <Text style={styles.note}>
            {t('devices.companions.artifactCount', { count: row!.artifacts.length })}
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
      {(!online || error) && row ? (
        <Text style={styles.note}>{t('devices.companions.stale')}</Text>
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
            onPress={() => (prs.length === 1 ? openPr(prs[0].url) : setShowPrs(!showPrs))}
          >
            {({ pressed }) => (
              <View
                onLayout={(event) =>
                  setActionWidth((width) =>
                    Math.max(width, Math.ceil(event.nativeEvent.layout.width)),
                  )
                }
                style={[styles.action, { minWidth: actionWidth }, pressed && mobileInteractionStyles.pressed]}
              >
                <GitPullRequest size={iconSize.sm} color={colors.textPrimary} />
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
                onLayout={(event) =>
                  setActionWidth((width) =>
                    Math.max(width, Math.ceil(event.nativeEvent.layout.width)),
                  )
                }
                style={[styles.action, { minWidth: actionWidth }, pressed && mobileInteractionStyles.pressed]}
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
                onLayout={(event) =>
                  setActionWidth((width) =>
                    Math.max(width, Math.ceil(event.nativeEvent.layout.width)),
                  )
                }
                style={[styles.action, { minWidth: actionWidth }, pressed && mobileInteractionStyles.pressed]}
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
              onPress={() => openPr(pr.url)}
            >
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
    title: { color: colors.textPrimary, fontSize: typeScale.body },
    note: { color: colors.textSecondary, fontSize: typeScale.footnote },
    actionLabel: { color: colors.textPrimary, fontSize: typeScale.footnote },
    error: { color: colors.statusError, fontSize: typeScale.footnote },
    success: { color: colors.statusDone },
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
