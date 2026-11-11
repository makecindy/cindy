/**
 * MobilePermissionPickerList —— 权限模式选择的行列表(新建会话页 + 会话内 composer 共用;
 * iOS 见 MobilePermissionPickerList.ios.tsx)。
 *
 * 每行 = 权限图标(`permissionPresentation`,与桌面 PermissionSelector 对齐)+ 文案 + 选中勾号。
 * 所有模式保持中性，以勾号标记当前选择，每项直接显示说明。
 */
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { Check } from 'lucide-react-native';

import type { MobileChoiceOption } from '@/session/agentCapabilities';
import { permissionOptionsForDisplay } from '@/session/mobilePermissionPickerOptions';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import { fontWeight, iconSize, iconStroke, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

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
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    optionContent: { flex: 1, minWidth: 0, paddingVertical: spacing.sm },
    description: {
      color: c.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    separator: {
      backgroundColor: c.border,
      height: StyleSheet.hairlineWidth,
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
  const visibleOptions = permissionOptionsForDisplay(options, activeMode);
  return (
    <>
      {visibleOptions.map((option, index) => {
        const presentation = permissionPresentation(option.id, option.label);
        const selected = option.id === activeMode;
        return (
          <View key={option.id}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <Pressable
              accessibilityLabel={t('interaction.permission.pickerSelect', { mode: presentation.label })}
              accessibilityHint={presentation.description}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onSelect(option.id)}
              style={({ pressed }) => [
                styles.optionRow,
                rowStyle,
                pressed && mobileInteractionStyles.pressed,
              ]}
              testID={testID}
            >
              <presentation.Icon
                color={selected ? permissionAccentColor(presentation.accent, colors) : colors.textSecondary}
                size={iconSize.action}
                strokeWidth={iconStroke.regular}
              />
              <View style={styles.optionContent}>
                <Text style={styles.optionText}>{presentation.label}</Text>
                <Text style={styles.description}>{presentation.description}</Text>
              </View>
              {selected ? (
                <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
              ) : null}
            </Pressable>
          </View>
        );
      })}
    </>
  );
}
