import { StyleSheet, View } from "react-native";
import { radius, useTheme } from "@/theme";

/**
 * The glass-less backing of the immersive preview controls. A file of its own so that
 * `ImmersiveGlassSurface.ios.tsx` can fall back to it: from there `./ImmersiveGlassSurface`
 * resolves to the `.ios` file itself.
 */
export function ImmersivePlainSurface() {
  const { colors } = useTheme();
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: radius.pill, backgroundColor: colors.surfaceElevated },
      ]}
    />
  );
}
