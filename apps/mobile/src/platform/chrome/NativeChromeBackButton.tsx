import { ChevronLeft } from "lucide-react-native";
import { HomeHeaderGlassButton } from "@/session/HomeHeaderGlassButton";
import { iconSize, iconStroke, useTheme } from "@/theme";

/** Non-iOS fallback for the system back chevron, at the chrome glyph size. */
export function NativeChromeBackButton({ label, onPress, testID }: { label: string; onPress(): void; testID: string }) {
  const { colors } = useTheme();
  return <HomeHeaderGlassButton testID={testID} accessibilityLabel={label} onPress={onPress}>
    <ChevronLeft size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
  </HomeHeaderGlassButton>;
}
