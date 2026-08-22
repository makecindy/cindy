import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
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
import { fontWeight, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 普通断线(无分类 issue)转为可见提示前的静默窗口:健康重连通常 <1s 完成,不闪 banner。 */
const OFFLINE_BANNER_DELAY_MS = 1_200;

/**
 * 条件挂载 ConnectionBanner 的统一可见性判定:
 * - 请求级 error / 可分类连接问题(鉴权失效、被顶号等)→ 立即显示;
 * - 当前关联设备熔断 open(电脑端未响应,relay 可能仍 online)→ 立即显示;
 * - 普通弱网断线(status 非 online 且无分类 issue)→ 持续超过静默窗口才显示,
 *   既让用户看得到「正在重连」(否则消息流静默停更没有任何信号),又不因
 *   一次快速重连闪一下布局(规则 7:杜绝跳变)。
 * 判定核在 resolveConnectionBannerVisibility(纯函数,单测覆盖)。
 */
export function useShowConnectionBanner(
  status: DeviceLinkStatus,
  error: string | null,
  issue: DeviceLinkConnectionIssue | null,
  deviceUnresponsive = false,
): boolean {
  const offline = status !== 'online';
  const [offlineLongEnough, setOfflineLongEnough] = useState(false);
  useEffect(() => {
    if (!offline) {
      setOfflineLongEnough(false);
      return;
    }
    const timer = setTimeout(() => setOfflineLongEnough(true), OFFLINE_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [offline]);
  return resolveConnectionBannerVisibility({
    offline,
    offlineLongEnough,
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
  issue = null,
  lastSyncedAt,
  onSync,
  variant = 'bar',
}: {
  status: DeviceLinkStatus;
  loading: boolean;
  density?: 'default' | 'compact';
  /** 当前关联设备熔断 open(电脑端未响应);relay 可能仍 online,单独入参 */
  deviceUnresponsive?: boolean;
  error: string | null;
  /** 连接层失败原因(useDeviceLink().connectionIssue);比请求级 error 更根因,优先展示 */
  issue?: DeviceLinkConnectionIssue | null;
  lastSyncedAt: number | null;
  onSync(): void;
  variant?: 'bar' | 'inline';
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // 链路已 online 说明普通 issue 已过期;unstable 描述跨连接抖动,online 时仍展示。
  // issue 优先于请求级 error:链路断因明确时,invoke 失败都是它的下游症状(NOT_CONNECTED)。
  const activeIssue = status !== 'online' || issue?.kind === 'unstable' ? issue : null;
  // 熔断 open 优先于请求级 error:open 期间的请求失败绝大多数就是熔断快速失败本身,
  // 状态级提示(未响应 + 自动重试中)比单次请求的错误原文更能解释现状。
  const showUnresponsive = !activeIssue && deviceUnresponsive;
  // 熔断已关后残留的 DEVICE_UNRESPONSIVE 错误是陈旧快照,按 null 处理(与
  // useShowConnectionBanner 同一判定,否则会出现可见但无内容的空壳 banner)。
  const effectiveError = resolveEffectiveConnectionError(error, deviceUnresponsive);
  const friendlyError = activeIssue || showUnresponsive ? null : describeRemoteError(effectiveError);
  const showSyncAction = resolveConnectionBannerSyncActionVisibility({
    online: status === 'online',
    hasActiveIssue: activeIssue !== null,
    deviceUnresponsive: showUnresponsive,
    hasRequestError: friendlyError !== null,
    requestErrorAutoRecovering: isAutoRecoveringRemoteError(effectiveError),
  });
  const tone = activeIssue
    ? 'off'
    : showUnresponsive
      ? 'busy'
      : friendlyError ? 'muted' : status === 'online' ? 'ready' : status === 'connecting' ? 'busy' : 'off';
  const compact = density === 'compact';
  const title = activeIssue
    ? connectionIssueTitle(activeIssue.kind)
    : showUnresponsive
      ? t('deviceLink.deviceUnresponsiveTitle')
      : friendlyError ? t('deviceLink.syncFailed') : relayStatusLabel(status);
  const copy = activeIssue
    ? connectionIssueHint(activeIssue.kind)
    : showUnresponsive
      ? t('deviceLink.deviceUnresponsiveHint')
      : friendlyError ?? relayStatusHint(status, lastSyncedAt);
  return (
    <View
      style={[
        styles.root,
        compact && styles.rootCompact,
        variant === 'inline' && styles.rootInline,
        (friendlyError || activeIssue || showUnresponsive) && styles.rootError,
      ]}
      testID="connection.banner"
    >
      <StatusDot tone={tone} pulsing={!activeIssue && (status === 'connecting' || showUnresponsive)} />
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
      ) : null}
    </View>
  );
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
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
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
