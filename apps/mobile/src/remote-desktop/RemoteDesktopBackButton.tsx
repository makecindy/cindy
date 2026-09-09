import { ChevronLeft } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import { useTheme, iconSize } from "@/theme";

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
      style={styles.button}
    >
      <ChevronLeft size={iconSize.xl} color={colors.textPrimary} />
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
