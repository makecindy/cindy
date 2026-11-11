// 启动阻断错误屏:远程端点清单拉取失败时全屏展示(CenteredScreen 的错误态姊妹件)。
// 阻断语义:没有"跳过 / 稍后再说",只有重试——拉不到清单应用不能继续。
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

export function StartupBlockedScreen({
  title,
  subtitle,
  retryLabel,
  onRetry,
}: {
  title: string;
  subtitle?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
      >
        <Text style={styles.retryLabel}>{retryLabel}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flex: 1,
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    lineHeight: lineHeight.title,
    fontWeight: fontWeight.semibold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: colors.textPrimary,
    borderRadius: radius.control,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  retryButtonPressed: {
    opacity: 0.7,
  },
  retryLabel: {
    color: colors.ctaText,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    fontWeight: fontWeight.medium,
  },
});
