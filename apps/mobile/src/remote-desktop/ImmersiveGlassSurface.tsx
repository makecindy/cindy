import { StyleSheet, View } from "react-native";
import { radius, useTheme } from "@/theme";

/** Backing of the immersive preview controls; this file is the one without glass. */
export function useImmersiveGlass(): boolean {
  return false;
}

export function ImmersiveGlassSurface() {
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
