import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome/NativePullDownMenu';
import { fontWeight, iconSize, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export interface CompanionChoiceOption { value: string; label: string; disabled?: boolean }

/**
 * Inline "label · value" picker, the Android counterpart of the iOS `Picker(menu)` rows.
 * The system menu (UIMenu / Android PopupMenu) marks the current value; a build without
 * MenuView falls back to an inline option list. A disabled control never opens a menu.
 */
export function CompanionChoice({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: CompanionChoiceOption[]; onChange(value: string): void; disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false); const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const native = usesNativePullDownMenu();
  // 没有能选的项时整行按禁用呈现,与下拉菜单「无可操作项不挂菜单」同一判据。
  const inactive = disabled || !options.some(option => !option.disabled);
  const select = (option: CompanionChoiceOption | undefined) => {
    if (disabled || !option || option.disabled) return;
    setExpanded(false); onChange(option.value);
  };
  const trigger = <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive, expanded: !native && expanded }} disabled={inactive}
    style={[styles.row, inactive && styles.disabled]} onPress={() => { if (!native) setExpanded(!expanded); }}>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.value} numberOfLines={1}>{options.find(option => option.value === value)?.label ?? value}</Text>
    <ChevronDown size={iconSize.md} color={colors.textSecondary} />
  </Pressable>;
  return <View>
    {/* Menu IDs are positions: an empty option value (e.g. "none") is still a selectable item. */}
    {inactive ? trigger : <NativePullDownMenu actions={options.map((option, index) => ({ id: String(index), title: option.label, state: option.value === value ? 'on' : 'off', disabled: !!option.disabled }))}
      onAction={id => select(options[Number(id)])}>
      {trigger}
    </NativePullDownMenu>}
    {expanded && !native && !inactive ? options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: value === option.value, disabled: !!option.disabled }}
      disabled={!!option.disabled} onPress={() => select(option)} style={[styles.row, option.disabled && styles.disabled]}>
      <Text style={styles.option}>{option.label}</Text>{option.value === value ? <Check size={iconSize.lg} color={colors.textPrimary} /> : null}
    </Pressable>) : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  disabled: { opacity: 0.4 },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: colors.textPrimary },
  value: { flex: 1, textAlign: 'right', fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textSecondary },
  option: { flex: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
});
