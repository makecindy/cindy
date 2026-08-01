/**
 * 队列状态横幅(消息流末尾,作为消息列表 footer 随内容滚动)。
 *
 * 待发送的**气泡**不在这里 —— 它们是消息流的一等渲染项(`pending_send`,见
 * `pendingSendItems.ts` / `PendingSendBubble.tsx`)。原先气泡挂在 footer,消息回流时要跨
 * footer↔data 搬家,位置会从「footer 落点」跳到「列表末项」,空会话时还被撑满高度的居中
 * 同步占位顶到屏幕中间,用户看到的是「气泡在中间 → 消失 → 在底部重新出现」。
 *
 * 留在 footer 的只有**整组队列的状态横幅**:队列错误(可重试 / 清除)、凭证切换等待、
 * 停止确认中、队列已暂停(可继续)。它们描述的是队列整体而非某一条消息,没有身份连续性
 * 问题,留在 footer 最自然。
 */
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { ReactNode } from 'react';
import { Text } from '@/components/AppText';
import { Pause, Play } from 'lucide-react-native';
import { describeAgentAuthError } from '@/device-link/remoteStatus';
import type { InputProjection } from '@/session/types';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

export interface InlineQueueSectionProps {
  projection: InputProjection;
  busy?: boolean;
  readOnlyReason?: string | null;
  onResume(): void;
  onRetryError(): void;
  onClearError(): void;
}

export function InlineQueueSection({
  projection,
  busy,
  readOnlyReason,
  onResume,
  onRetryError,
  onClearError,
}: InlineQueueSectionProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();

  const hasBanner = !!projection.error
    || !!projection.credentialSwitchWait
    || projection.queueAbortPending
    || projection.queuePaused;
  if (!hasBanner) return null;

  const controlsDisabled = busy || !!readOnlyReason;

  return (
    <View style={styles.container} testID="queue.inline.section">
      {projection.error ? (
        <View style={styles.errorBox} testID="queue.inline.error">
          {/* agent 未鉴权错误换成带引导的中文提示;其它错误维持原文 */}
          <Text style={styles.errorText}>{describeAgentAuthError(projection.error) ?? projection.error}</Text>
          <View style={styles.errorActions}>
            <ActionPill
              busy={busy}
              disabled={controlsDisabled || !projection.errorRetryText}
              label={t('message.queue.retrySend')}
              onPress={onRetryError}
              testID="queue.inline.retryButton"
            />
            <ActionPill
              busy={busy}
              disabled={controlsDisabled}
              label={t('message.queue.clearError')}
              onPress={onClearError}
              testID="queue.inline.clearErrorButton"
            />
          </View>
        </View>
      ) : null}

      {projection.credentialSwitchWait ? (
        <View style={styles.banner} testID="queue.inline.credentialSwitchWaitBanner">
          <ActivityIndicator color={colors.textTertiary} size="small" />
          <Text style={styles.bannerText}>{t('message.queue.credentialSwitchWait')}</Text>
        </View>
      ) : null}

      {projection.queueAbortPending ? (
        <View style={styles.banner} testID="queue.inline.abortBanner">
          <ActivityIndicator color={colors.textTertiary} size="small" />
          <Text style={styles.bannerText}>{t('message.queue.aborting')}</Text>
        </View>
      ) : projection.queuePaused ? (
        <View style={styles.banner} testID="queue.inline.pausedBanner">
          <Pause color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          <Text style={styles.bannerText}>{t('message.queue.paused')}</Text>
          <QueueTouchButton
            accessibilityLabel={t('message.queue.resumeSendQueue')}
            busy={busy}
            disabled={controlsDisabled}
            disabledReason={readOnlyReason}
            onPress={onResume}
            style={styles.resumePill}
            testID="queue.inline.resumeButton"
          >
            <Play color={colors.ctaText} fill={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.regular} />
            <Text style={styles.resumePillText}>{t('message.queue.resume')}</Text>
          </QueueTouchButton>
        </View>
      ) : null}
    </View>
  );
}

function ActionPill({
  busy,
  disabled,
  disabledReason,
  label,
  onPress,
  testID,
}: {
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  label: string;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <QueueTouchButton
      accessibilityLabel={label}
      busy={busy}
      disabled={disabled}
      disabledReason={disabledReason}
      onPress={onPress}
      style={styles.actionPill}
      testID={testID}
    >
      <Text style={styles.actionPillText}>{label}</Text>
    </QueueTouchButton>
  );
}

function QueueTouchButton({
  accessibilityLabel,
  busy = false,
  children,
  disabled = false,
  disabledReason,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  busy?: boolean;
  children: ReactNode;
  disabled?: boolean;
  disabledReason?: string | null;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityHint={disabledReason ?? undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: busy || undefined, disabled: interactionDisabled }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        style,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { gap: spacing.sm, paddingTop: spacing.sm, width: '100%' },
  banner: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  resumePill: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: spacing.md,
  },
  resumePillText: { color: colors.ctaText, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  errorBox: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  errorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actionPill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  actionPillText: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
});
