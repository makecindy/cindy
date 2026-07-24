/**
 * MobileChoicePickerList —— 通用「选项 + 选中态」下拉行列表(纯文字,无图标)。
 * 用于运行设置里 effort 这类简单单选。模型 / 权限有各自带图标的专用列表
 * (MobileModelPickerList / MobilePermissionPickerList),本组件只覆盖纯文字选项。
 */
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { Check } from 'lucide-react-native';

import type { MobileChoiceOption } from '@/session/agentCapabilities';
import { fontWeight, iconSize, iconStroke, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

export interface MobileChoicePickerListProps {
  options: readonly MobileChoiceOption[];
  activeId: string;
  disabled?: boolean;
  onSelect(id: string): void;
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

export function MobileChoicePickerList({
  options,
  activeId,
  disabled = false,
  onSelect,
  rowStyle,
  testID = 'choicePicker.option',
}: MobileChoicePickerListProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <>
      {options.map((option) => {
        const selected = option.id === activeId;
        return (
          <Pressable
            accessibilityLabel={t('shared.selectOption', { label: option.label })}
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
            <Text numberOfLines={1} style={styles.optionText}>{option.label}</Text>
            {selected ? <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} /> : null}
          </Pressable>
        );
      })}
    </>
  );
}
