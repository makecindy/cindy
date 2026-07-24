import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import type { DeviceLinkConnectionIssue, DeviceLinkStatus } from '@cindy/device-link';
import {
  connectionIssueHint,
  connectionIssueTitle,
  describeRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@/device-link/remoteStatus';
import { MainWindowActionButton, StatusDot } from '@/components/MobilePrimitives';
import { fontWeight, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 普通断线(无分类 issue)转为可见提示前的静默窗口:健康重连通常 <1s 完成,不闪 banner。 */
const OFFLINE_BANNER_DELAY_MS = 1_200;

/**
 * 条件挂载 ConnectionBanner 的统一可见性判定:
 * - 请求级 error / 可分类连接问题(鉴权失效、被顶号等)→ 立即显示;
 * - 普通弱网断线(status 非 online 且无分类 issue)→ 持续超过静默窗口才显示,
 *   既让用户看得到「正在重连」(否则消息流静默停更没有任何信号),又不因
 *   一次快速重连闪一下布局(规则 7:杜绝跳变)。
 */
export function useShowConnectionBanner(
  status: DeviceLinkStatus,
  error: string | null,
  issue: DeviceLinkConnectionIssue | null,
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
  return Boolean(error) || (offline && (issue !== null || offlineLongEnough));
}

export function ConnectionBanner({
  status,
  loading,
  density = 'default',
  error,
  issue = null,
  lastSyncedAt,
  onSync,
  variant = 'bar',
}: {
  status: DeviceLinkStatus;
  loading: boolean;
  density?: 'default' | 'compact';
  error: string | null;
  /** 连接层失败原因(useDeviceLink().connectionIssue);比请求级 error 更根因,优先展示 */
  issue?: DeviceLinkConnectionIssue | null;
  lastSyncedAt: number | null;
  onSync(): void;
  variant?: 'bar' | 'inline';
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // 链路已 online 说明 issue 已过期(client 侧 online 会清除,这里兜底不展示)。
  // issue 优先于请求级 error:链路断因明确时,invoke 失败都是它的下游症状(NOT_CONNECTED)。
  const activeIssue = status !== 'online' ? issue : null;
  const friendlyError = activeIssue ? null : describeRemoteError(error);
  const tone = activeIssue
    ? 'off'
    : friendlyError ? 'muted' : status === 'online' ? 'ready' : status === 'connecting' ? 'busy' : 'off';
  const compact = density === 'compact';
  const title = activeIssue
    ? connectionIssueTitle(activeIssue.kind)
    : friendlyError ? t('deviceLink.syncFailed') : relayStatusLabel(status);
  const copy = activeIssue
    ? connectionIssueHint(activeIssue.kind)
    : friendlyError ?? relayStatusHint(status, lastSyncedAt);
  return (
    <View
      style={[
        styles.root,
        compact && styles.rootCompact,
        variant === 'inline' && styles.rootInline,
        (friendlyError || activeIssue) && styles.rootError,
      ]}
      testID="connection.banner"
    >
      <StatusDot tone={tone} pulsing={!activeIssue && status === 'connecting'} />
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
            numberOfLines={friendlyError || activeIssue ? 2 : 1}
            style={styles.copy}
            testID="connection.copy"
          >
            {copy}
          </Text>
        ) : null}
      </View>
      <ConnectionSyncButton
        compact={compact}
        loading={loading}
        onPress={onSync}
        testID="connection.syncButton"
      />
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
