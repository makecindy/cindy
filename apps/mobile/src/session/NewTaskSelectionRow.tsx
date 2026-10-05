import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Check } from "lucide-react-native";
import { Text } from "@/components/AppText";
import {
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
} from "@/theme";

/** RN content shared by the Android device, workspace and directory pickers. */
export function NewTaskSelectionRow({
  title,
  subtitle,
  value,
  leading,
  trailing,
  selected,
  disabled,
  onPress,
  testID,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(", ")}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        padding: spacing.md,
        minHeight: 56,
        gap: spacing.sm,
        opacity: disabled ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{
            color: colors.textPrimary,
            fontSize: typeScale.body,
            lineHeight: lineHeight.body,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              color: colors.textSecondary,
              fontSize: typeScale.footnote,
              lineHeight: lineHeight.caption,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text
          numberOfLines={1}
          style={{
            maxWidth: "45%",
            color: colors.textSecondary,
            fontSize: typeScale.bodySmall,
            lineHeight: lineHeight.bodySmall,
          }}
        >
          {value}
        </Text>
      ) : null}
      {selected ? (
        <Check
          color={colors.textPrimary}
          size={iconSize.lg}
          strokeWidth={iconStroke.medium}
        />
      ) : null}
      {trailing}
    </Pressable>
  );
}
