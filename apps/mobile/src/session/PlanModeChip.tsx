/**
 * PlanModeChip —— composer 工具排的计划模式激活指示(对照桌面 PR#494 PlanModeIndicator
 * 与 Cursor 的「Plan ×」chip)。计划模式不再体现在权限按钮 / 权限下拉位置,激活态由
 * 本 chip 表达;点 × 退出并恢复进入前的权限档。中性 chip token(与 GoalIndicator 同精神)。
 */
import { ListTodo, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export interface PlanModeChipProps {
  onExit: () => void;
  disabled?: boolean;
  testID?: string;
}

export function PlanModeChip({ onExit, disabled, testID }: PlanModeChipProps) {
  const styles = useThemedStyles(makeChipStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.chip} testID={testID}>
      <ListTodo color={colors.textPrimary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <Text style={styles.label}>{t('interaction.planMode.label')}</Text>
      <Pressable
        accessibilityLabel={t('interaction.planMode.exit')}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={onExit}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        testID={testID ? `${testID}.exit` : undefined}
      >
        <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.bold} />
      </Pressable>
    </View>
  );
}

function makeChipStyles(colors: ThemeColors) {
  return {
    chip: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flexDirection: 'row' as const,
      gap: spacing.xs,
      height: 28,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
    },
    label: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    close: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pressed: {
      opacity: 0.6,
    },
  };
}
