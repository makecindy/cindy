import { Host, Switch as ExpoSwitch } from "@expo/ui";
import { Platform, Switch as RNSwitch, View } from "react-native";
import { useTheme } from "@/theme";

/** iOS/Android 点开是系统 Switch;Web 没有原生 toolkit,继续用 RN Switch。 */
export function usesExpoNativeSwitch(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

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

  if (!usesExpoNativeSwitch()) {
    return (
      <RNSwitch
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onValueChange={onValueChange}
        testID={testID}
        value={value}
      />
    );
  }

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
        <ExpoSwitch
          disabled={disabled}
          onValueChange={onValueChange}
          testID={testID}
          value={value}
        />
      </Host>
    </View>
  );
}
