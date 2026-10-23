import { StyleSheet } from "react-native";
import { GlassView } from "expo-glass-effect";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { navigationChrome, radius, useTheme } from "@/theme";
import { ImmersiveGlassSurface as PlainSurface } from "./ImmersiveGlassSurface";

/** Whether the controls sit on liquid glass (and so use the clear-glass palette). */
export function useImmersiveGlass(): boolean {
  return useLiquidGlassAvailable();
}

/**
 * The same material as the native glass buttons (clear glass with a scrim
 * behind it), drawn by a UIVisualEffectView instead of a SwiftUI Host. A Host
 * hangs a hosting controller on the root view controller, and while one is
 * mounted react-native-screens cannot reach the screen that asks to hide the
 * status bar; see previewImmersive.ts.
 */
export function ImmersiveGlassSurface() {
  const { mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  if (!glass) return <PlainSurface />;
  return (
    <GlassView
      glassEffectStyle="clear"
      colorScheme={mode}
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: radius.pill,
          backgroundColor: navigationChrome.clear[mode].scrim,
        },
      ]}
    />
  );
}
