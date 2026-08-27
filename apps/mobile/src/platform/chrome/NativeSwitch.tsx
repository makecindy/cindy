import { Host, Switch } from "@expo/ui";
import { useTheme } from "@/theme";

/** 收起时仍占原来的开关位;iOS/Android 点开是系统 Switch。 */
export function NativeSwitch({
  disabled,
  onValueChange,
  seedColor,
  testID,
  value,
}: {
  disabled?: boolean;
  onValueChange(value: boolean): void;
  seedColor?: string;
  testID?: string;
  value: boolean;
}) {
  const { mode } = useTheme();
  return (
    <Host colorScheme={mode} matchContents seedColor={seedColor}>
      <Switch
        disabled={disabled}
        onValueChange={onValueChange}
        testID={testID}
        value={value}
      />
    </Host>
  );
}
