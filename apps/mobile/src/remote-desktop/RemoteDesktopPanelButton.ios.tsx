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
import type { PanelButtonProps } from "./RemoteDesktopPanelButton";

export function RemoteDesktopPanelButton({
  back,
  label,
  onPress,
}: PanelButtonProps) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: 44, height: 44 }}
    >
      <Button
        label={label}
        systemImage={back ? "chevron.backward" : "xmark"}
        onPress={onPress}
        modifiers={[
          labelStyle("iconOnly"),
          buttonStyle(glass ? "glass" : "bordered"),
          buttonBorderShape("circle"),
          controlSize("large"),
          frame({ width: 44, height: 44 }),
        ]}
      />
    </Host>
  );
}
