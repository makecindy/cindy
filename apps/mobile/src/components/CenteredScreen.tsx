import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { MobileLoginHandoffStage } from '@/components/MobileLoginHandoffStage';
import {
  fontWeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

/**
 * CenteredScreen —— 启动期全屏占位屏。
 *
 * splash 变体(PR4a 白底体系重写,implementation-plan Step 5 WHAT1):
 * 复用 MobileLoginHandoffStage 唯一品牌宿主(主题 surface 底 + wave4 双红渐变 +
 * 立绘/SLOGAN/字标静态品牌,750 stage 几何)。旧红底 splash 体系(brandSplash
 * 主题族铺底 + assets/splash/ 下 fade 立绘·白版字标·script 资产的 375×812 画布
 * 几何)已随 wave4 改判整体退役:渲染层不再 require 任何旧 splash 资产,
 * 文件暂留原目录待后续清理批次统一处置(splashPreview.test 校验其存在性)。
 *
 * default 变体保持原样(通用 loading/占位)。
 */
export function CenteredScreen({
  title,
  subtitle,
  variant = 'default',
}: {
  title: string;
  subtitle?: string;
  variant?: 'default' | 'splash';
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();

  if (variant === 'splash') {
    return (
      <MobileLoginHandoffStage
        accessibilityLabel={title}
        testID="startup.splash"
      />
    );
  }

  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
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
    fontWeight: fontWeight.medium,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    textAlign: 'center',
  },
});
