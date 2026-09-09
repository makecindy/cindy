import { Host } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  frame,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { useTheme } from "@/theme";

export function RemoteDesktopBackButton({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  const { colors, mode } = useTheme();
  const liquidGlass = useLiquidGlassAvailable();

  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: 44, height: 44 }}
    >
      <Button
        label={label}
        systemImage="chevron.backward"
        onPress={onPress}
        testID="remoteDesktop.back"
        modifiers={[
          labelStyle("iconOnly"),
          buttonStyle(liquidGlass ? "glass" : "bordered"),
          buttonBorderShape("circle"),
          controlSize("large"),
          frame({ width: 44, height: 44 }),
        ]}
      />
    </Host>
  );
}
