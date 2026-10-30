import { ChevronLeft } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";
import { useTheme, iconSize, iconStroke } from "@/theme";

export function RemoteDesktopBackButton({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID="remoteDesktop.back"
      style={({ pressed }) => [styles.button, pressed && mobileInteractionStyles.pressed]}
    >
      {/* 与共享 ScreenBackButton 同档:iconSize.action + iconStroke.regular。 */}
      <ChevronLeft size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
