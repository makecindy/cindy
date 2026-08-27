import { Host, Switch } from "@expo/ui";
import { View } from "react-native";
import { useTheme } from "@/theme";

/** 收起时仍占原来的开关位;iOS/Android 点开是系统 Switch。 */
export function NativeSwitch({
  accessibilityLabel,
  disabled,
  onValueChange,
  seedColor,
  testID,
  value,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  onValueChange(value: boolean): void;
  seedColor?: string;
  testID?: string;
  value: boolean;
}) {
  const { mode } = useTheme();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      accessible={Boolean(accessibilityLabel)}
      onAccessibilityTap={
        accessibilityLabel && !disabled
          ? () => onValueChange(!value)
          : undefined
      }
    >
      <Host colorScheme={mode} matchContents seedColor={seedColor}>
        <Switch
          disabled={disabled}
          onValueChange={onValueChange}
          testID={testID}
          value={value}
        />
      </Host>
    </View>
  );
}
