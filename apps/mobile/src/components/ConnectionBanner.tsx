import { ConnectionNoticeOverlay, useDelayedConnectionNotice } from './ConnectionNoticeOverlay';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { Text } from '@/components/AppText';
import type { DeviceLinkConnectionIssue, DeviceLinkStatus } from '@cindy/device-link';
import {
  connectionIssueHint,
  connectionIssueTitle,
  describeRemoteError,
  isAutoRecoveringRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@/device-link/remoteStatus';
import { MainWindowActionButton, StatusDot } from '@/components/MobilePrimitives';
import {
  resolveConnectionBannerSyncActionVisibility,
  resolveConnectionBannerVisibility,
  resolveEffectiveConnectionError,
} from '@/components/connectionBannerVisibility';
import { fontWeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Eligibility only. ConnectionBanner owns the shared one-second display delay,
 * including screens that mount the component unconditionally. */
export function useShowConnectionBanner(
  status: DeviceLinkStatus,
  error: string | null,
  issue: DeviceLinkConnectionIssue | null,
  deviceUnresponsive = false,
  recovery?: 'syncing' | 'recovered',
): boolean {
  const offline = status !== 'online' || recovery === 'syncing';
  return resolveConnectionBannerVisibility({
    offline,
    offlineLongEnough: true,
    // 熔断已关后屏幕残留的 DEVICE_UNRESPONSIVE 错误按陈旧丢弃(review P1),
    // 否则恢复后 banner 会带着"自动重试中"文案常驻到用户手动同步。
    hasError: Boolean(resolveEffectiveConnectionError(error, deviceUnresponsive)),
    hasIssue: issue !== null,
    hasUnstableIssue: issue?.kind === 'unstable',
    deviceUnresponsive,
  });
}

export function ConnectionBanner({
  status,
  loading,
  density = 'default',
  deviceUnresponsive = false,
  error,
  requestErrorAutoRecovering,
  issue = null,
  lastSyncedAt,
  onSync,
  variant = 'bar',
  recovery,
  cachedOnly = false,
}: {
  status: DeviceLinkStatus;
  loading: boolean;
  density?: 'default' | 'compact';
  /** 当前关联设备熔断 open(电脑端未响应);relay 可能仍 online,单独入参 */
  deviceUnresponsive?: boolean;
  error: string | null;
  /** Request owners with local retry (e.g. history pagination) can opt out of connection recovery. */
  requestErrorAutoRecovering?: boolean;
  /** 连接层失败原因(useDeviceLink().connectionIssue);比请求级 error 更根因,优先展示 */
  issue?: DeviceLinkConnectionIssue | null;
  lastSyncedAt: number | null;
  onSync(): void;
  variant?: 'bar' | 'inline';
  recovery?: 'syncing' | 'recovered';
  cachedOnly?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const active = useShowConnectionBanner(status, error, issue, deviceUnresponsive, recovery);
  const visible = useDelayedConnectionNotice(cachedOnly || active);
  // 链路已 online 说明普通 issue 已过期;unstable 描述跨连接抖动,online 时仍展示。
  // issue 优先于请求级 error:链路断因明确时,invoke 失败都是它的下游症状(NOT_CONNECTED)。
  const activeIssue = status !== 'online' || issue?.kind === 'unstable' ? issue : null;
  // 熔断 open 优先于请求级 error:open 期间的请求失败绝大多数就是熔断快速失败本身,
  // 状态级提示(未响应 + 自动重试中)比单次请求的错误原文更能解释现状。
  const showUnresponsive = !cachedOnly && !activeIssue && deviceUnresponsive;
  // 熔断已关后残留的 DEVICE_UNRESPONSIVE 错误是陈旧快照,按 null 处理(与
  // useShowConnectionBanner 同一判定,否则会出现可见但无内容的空壳 banner)。
  const effectiveError = resolveEffectiveConnectionError(error, deviceUnresponsive);
  const friendlyError = cachedOnly || activeIssue || showUnresponsive ? null : describeRemoteError(effectiveError);
  const autoRecoveringRequest = requestErrorAutoRecovering ?? isAutoRecoveringRemoteError(effectiveError);
  const showRecoveryProgress = !cachedOnly && (!activeIssue || activeIssue.kind === 'unstable' || activeIssue.kind === 'replaced')
    && (status === 'connecting' || deviceUnresponsive || recovery === 'syncing'
      || (friendlyError !== null && autoRecoveringRequest));
  const showSyncAction = !cachedOnly && resolveConnectionBannerSyncActionVisibility({
    online: status === 'online',
    hasActiveIssue: activeIssue !== null,
    deviceUnresponsive: showUnresponsive,
    hasRequestError: friendlyError !== null,
    requestErrorAutoRecovering: autoRecoveringRequest,
  });
  const tone = cachedOnly ? 'off' : activeIssue
    ? 'off'
    : showUnresponsive
      ? 'busy'
      : friendlyError ? 'muted' : recovery === 'syncing' ? 'busy' : status === 'online' ? 'ready' : status === 'connecting' ? 'busy' : 'off';
  const compact = density === 'compact';
  const title = cachedOnly && !activeIssue ? t('deviceLink.cachedHistory.title') : activeIssue
    ? activeIssue.kind === 'unstable'
      ? t('deviceLink.unstableTitle')
      : connectionIssueTitle(activeIssue.kind)
    : showUnresponsive
      ? t('deviceLink.deviceUnresponsiveTitle')
      : friendlyError ? t('deviceLink.syncFailed') : status === 'online' && recovery
        ? t(`deviceLink.recovery.${recovery}`) : relayStatusLabel(status);
  const copy = cachedOnly && !activeIssue ? t('deviceLink.cachedHistory.hint') : activeIssue
    ? activeIssue.kind === 'unstable'
      ? t('deviceLink.unstableHint')
      : connectionIssueHint(activeIssue.kind)
    : showUnresponsive
      ? t('deviceLink.deviceUnresponsiveHint')
      : friendlyError ?? (status === 'online' && recovery === 'syncing'
        ? t('deviceLink.recovery.syncingHint') : relayStatusHint(status, lastSyncedAt));
  if (!visible) return null;
  return (
    <ConnectionNoticeOverlay>
    <View
      style={[
        styles.root,
        compact && styles.rootCompact,
        variant === 'inline' && styles.rootInline,
        (friendlyError || activeIssue || showUnresponsive) && styles.rootError,
      ]}
      testID="connection.banner"
    >
      <StatusDot tone={tone} pulsing={!cachedOnly && !activeIssue && (status === 'connecting' || showUnresponsive || recovery === 'syncing')} />
      <View style={[styles.textBlock, compact && styles.textBlockCompact]}>
        <Text
          ellipsizeMode="tail"
          numberOfLines={1}
          style={styles.title}
          testID="connection.title"
        >
          {compact ? `${title} · ${copy}` : title}
        </Text>
        {!compact ? (
          <Text
            ellipsizeMode="tail"
            numberOfLines={friendlyError || activeIssue || showUnresponsive ? 2 : 1}
            style={styles.copy}
            testID="connection.copy"
          >
            {copy}
          </Text>
        ) : null}
      </View>
      {showSyncAction ? (
        <ConnectionSyncButton
          compact={compact}
          loading={loading}
          onPress={onSync}
          testID="connection.syncButton"
        />
      ) : showRecoveryProgress ? (
        <ConnectionRecoveryProgress />
      ) : null}
    </View>
    </ConnectionNoticeOverlay>
  );
}

/** Shared by the Home connection row and detail banners; never a press target. */
export function ConnectionRecoveryProgress() {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotionEnabled();
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {reduceMotion === false ? (
    <ActivityIndicator
      color={colors.textSecondary}
      size="small"
      testID="connection.recoveryProgress"
    />
  ) : (
    <LoaderCircle
      color={colors.textSecondary}
      size={iconSize.action}
      testID="connection.recoveryProgressStatic"
    />
    )}
  </View>;
}

function ConnectionSyncButton({
  compact,
  loading,
  onPress,
  testID,
}: {
  compact: boolean;
  loading: boolean;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <MainWindowActionButton
      action={{
        accessibilityLabel: loading ? t('deviceLink.resyncing') : t('deviceLink.resync'),
        busy: loading,
        disabled: loading,
        label: compact ? t('deviceLink.syncShort') : t('deviceLink.resync'),
        onPress,
        testID,
      }}
      density="compact"
      style={styles.button}
    />
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.container,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  rootCompact: {
    minHeight: 36,
    paddingVertical: 2,
  },
  rootInline: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 42,
    paddingHorizontal: spacing.md,
  },
  rootError: {
    backgroundColor: colors.surfaceElevated,
  },
  textBlock: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 0,
  },
  textBlockCompact: {
    gap: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  copy: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  button: {
    minHeight: 30,
    minWidth: 0,
    paddingHorizontal: spacing.sm,
  },
});
