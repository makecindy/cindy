import { Pressable } from "react-native";
import { ChevronLeft, X } from "lucide-react-native";
import { iconSize, iconStroke, useTheme } from "@/theme";

export interface PanelButtonProps {
  back?: boolean;
  label: string;
  onPress(): void;
}
export function RemoteDesktopPanelButton({
  back,
  label,
  onPress,
}: PanelButtonProps) {
  const { colors } = useTheme();
  const Icon = back ? ChevronLeft : X;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon
        size={iconSize.action}
        strokeWidth={iconStroke.regular}
        color={colors.textPrimary}
      />
    </Pressable>
  );
}
