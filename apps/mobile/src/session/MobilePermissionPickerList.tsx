/**
 * MobilePermissionPickerList —— 权限模式下拉的行列表(新建会话页 + 会话内 composer 共用)。
 *
 * 每行 = 权限图标(`permissionPresentation`,与桌面 PermissionSelector 对齐)+ 文案 + 选中 Check;
 * auto / bypass 着色(`permissionAccentColor`),其余中性。不含容器/ScrollView —— 由调用方套
 * (新建页 in-flow panel,会话内 composer 浮层)。
 */
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { Check } from 'lucide-react-native';

import type { MobileChoiceOption } from '@/session/agentCapabilities';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import { fontWeight, iconSize, iconStroke, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

export interface MobilePermissionPickerListProps {
  options: readonly MobileChoiceOption[];
  activeMode: string;
  disabled?: boolean;
  onSelect(mode: string): void;
  rowStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    optionRow: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    optionRowSelected: {
      backgroundColor: c.surfaceChip,
    },
    optionText: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
      minWidth: 0,
    },
  });

export function MobilePermissionPickerList({
  options,
  activeMode,
  disabled = false,
  onSelect,
  rowStyle,
  testID = 'permissionPicker.option',
}: MobilePermissionPickerListProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 计划模式已迁移到 + 号 Context 面板的专属入口(点击即进入),权限下拉不再展示 plan;
  // 当前模式为 plan 时列表无高亮行,从这里选任意模式即退出计划模式。
  const visibleOptions = options.filter((option) => option.id !== 'plan');
  return (
    <>
      {visibleOptions.map((option) => {
        const presentation = permissionPresentation(option.id, option.label);
        const selected = option.id === activeMode;
        const accent = permissionAccentColor(presentation.accent, colors);
        const tinted = selected && presentation.accent !== 'neutral';
        return (
          <Pressable
            accessibilityLabel={t('interaction.permission.pickerSelect', { mode: presentation.label })}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            key={option.id}
            onPress={() => onSelect(option.id)}
            style={({ pressed }) => [
              styles.optionRow,
              rowStyle,
              selected && styles.optionRowSelected,
              pressed && { opacity: 0.65 },
            ]}
            testID={testID}
          >
            <presentation.Icon
              color={tinted ? accent : selected ? colors.textPrimary : colors.textSecondary}
              size={iconSize.action}
              strokeWidth={iconStroke.regular}
            />
            <Text numberOfLines={1} style={[styles.optionText, tinted && { color: accent }]}>
              {presentation.label}
            </Text>
            {selected ? (
              <Check color={tinted ? accent : colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
            ) : null}
          </Pressable>
        );
      })}
    </>
  );
}
