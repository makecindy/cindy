import { iconSize } from '@/theme';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome/NativePullDownMenu';
import { spacing, useTheme } from '@/theme';
export function CompanionChoice({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void; disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false); const { colors } = useTheme();
  const select = (value: string) => { if (!disabled) { setExpanded(false); onChange(value); } };
  return <View><NativePullDownMenu actions={options.map(option => ({ id: option.value, title: option.label, state: option.value === value ? 'on' : 'off', disabled }))} onAction={select}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }} onPress={() => { if (!usesNativePullDownMenu()) setExpanded(!expanded); }}>
      <Text style={{ color: colors.textPrimary }}>{label}</Text><Text style={{ flex: 1, textAlign: 'right', color: colors.textSecondary }} numberOfLines={1}>{options.find(option => option.value === value)?.label ?? value}</Text><ChevronDown size={iconSize.md} color={colors.textSecondary} />
    </Pressable>
  </NativePullDownMenu>{expanded && !usesNativePullDownMenu() ? options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: value === option.value }} disabled={disabled} onPress={() => select(option.value)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
    <Text style={{ color: colors.textPrimary, flex: 1 }}>{option.label}</Text>{option.value === value ? <Check size={iconSize.lg} color={colors.textPrimary} /> : null}
  </Pressable>) : null}</View>;
}
