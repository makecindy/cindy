/**
 * 会话尾部收尾提示条(error-tail / interrupted)—— 对齐桌面 ErrorTailErrorBanner /
 * InterruptedTurnBanner 的核心语义,状态推导在 sessionTailBanner.ts(纯函数),
 * 本组件只渲染 + 回调。视觉沿用 InlineQueueSection 错误框的同款 token(surfaceElevated
 * 容器 + errorText 文案 + pill 操作行),渲染位置也在消息列表 footer(队列区上方)。
 *
 * 操作语义(与桌面一致):
 *  - 主按钮(重试 / 继续任务)→ 父屏发隐藏续跑指令(带 [UI_ACTION_TRIGGER] 前缀,
 *    消息流不渲染,用户只看到任务继续跑);
 *  - 「忽略」→ error-tail 持久化 dismiss / interrupted 写 ack,不再提示。
 */
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { View } from 'react-native';
import type { SessionTailBannerState } from '@/session/sessionTailBannerModel';
import { fontWeight, lineHeight, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

export interface SessionTailBannerProps {
  state: NonNullable<SessionTailBannerState>;
  busy?: boolean;
  /**
   * 只读信息版(协同只读 worker 会话):只显示文案不渲染操作行——interrupted
   * 状态没有任何消息行可回落,不显示会让用户不知道任务为何停了(review P2);
   * 操作(续跑/忽略)是写行为,只读会话不给入口。
   */
  readOnly?: boolean;
  onContinue(): void;
  onDismiss(): void;
}

export function SessionTailBanner({ state, busy, readOnly, onContinue, onDismiss }: SessionTailBannerProps) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const isInterrupted = state.kind === 'interrupted' || state.continueKind === 'interrupted';
  const text = state.kind === 'error-tail' && state.continueKind === 'error'
    ? state.text
    : t('session.tail.interrupted');
  const showContinue = state.kind === 'interrupted' || state.retryable;
  return (
    <View style={styles.box} testID="session.tailBanner">
      <Text
        style={isInterrupted ? styles.infoText : styles.errorText}
        testID="session.tailBanner.text"
      >
        {text}
      </Text>
      {readOnly ? null : (
        <View style={styles.actions}>
          {showContinue ? (
            <TailPill
              busy={busy}
              cta
              label={isInterrupted ? t('session.tail.continueTask') : t('session.tail.retry')}
              onPress={onContinue}
              testID="session.tailBanner.continue"
            />
          ) : null}
          <TailPill
            busy={busy}
            label={t('session.tail.ignore')}
            onPress={onDismiss}
            testID="session.tailBanner.dismiss"
          />
        </View>
      )}
    </View>
  );
}

function TailPill({
  busy,
  cta,
  label,
  onPress,
  testID,
}: {
  busy?: boolean;
  cta?: boolean;
  label: string;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: busy || undefined, disabled: busy || undefined }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        cta && styles.pillCta,
        pressed && styles.pressed,
        busy && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.pillText, cta && styles.pillTextCta]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  box: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    // 与 InlineQueueSection container 的 paddingTop 同档,footer 区两块内容间距一致。
    marginTop: spacing.sm,
    padding: spacing.md,
    width: '100%',
  },
  errorText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  infoText: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: spacing.md,
  },
  pillCta: { backgroundColor: colors.cta },
  pillText: { color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  pillTextCta: { color: colors.ctaText },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
