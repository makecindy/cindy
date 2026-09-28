/**
 * MobilePermissionPickerList —— 权限模式选择的行列表(新建会话页 + 会话内 composer 共用;
 * iOS 见 MobilePermissionPickerList.ios.tsx)。
 *
 * 每行 = 权限图标(`permissionPresentation`,与桌面 PermissionSelector 对齐)+ 文案 + 选中勾号。
 * 选中态与 iOS 同口径:只有选中行的图标按档位着色(`permissionAccentColor`,auto / bypass
 * 有语义色,其余中性),文字与勾号不着色,也不铺整行底色。不含容器/ScrollView —— 由调用方套。
 */
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
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
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onSelect(option.id)}
              style={({ pressed }) => [
                styles.optionRow,
                rowStyle,
                pressed && { opacity: 0.65 },
              ]}
              testID={testID}
            >
              <presentation.Icon
                color={selected ? permissionAccentColor(presentation.accent, colors) : colors.textSecondary}
                size={iconSize.action}
                strokeWidth={iconStroke.regular}
              />
              <Text numberOfLines={1} style={styles.optionText}>
                {presentation.label}
              </Text>
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
