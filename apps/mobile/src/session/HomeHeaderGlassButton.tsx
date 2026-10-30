/**
 * 首页顶栏图标钮:iOS 26+ 走系统 Liquid Glass(UIGlassEffect),其它环境回退成无底图标热区。
 */
import { GlassView } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { navigationChrome, radius } from "@/theme/tokens";

export function HomeHeaderGlassButton({
  accessibilityLabel,
  children,
  onPress,
  testID,
  disabled = false,
  prominent = false,
  size = navigationChrome.target,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  onPress(): void;
  testID: string;
  disabled?: boolean;
  prominent?: boolean;
  size?: number;
  artworkSize?: number;
}) {
  const { mode, colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, { width: size, height: size }, prominent && { backgroundColor: colors.cta, borderRadius: radius.pill }, pressed && styles.pressed, disabled && styles.disabled]}
      testID={testID}
    >
      {liquidGlass ? (
        <GlassView
          colorScheme={mode}
          glassEffectStyle="regular"
          isInteractive
          style={styles.glass}
        >
          <View pointerEvents="none" style={styles.iconSlot}>
            {children}
          </View>
        </GlassView>
      ) : (
        <View style={styles.iconSlot}>{children}</View>
      )}
    </Pressable>
  );
}

const makeStyles = (_colors: ThemeColors) =>
  StyleSheet.create({
    hit: {
      flexShrink: 0,
      height: navigationChrome.target,
      width: navigationChrome.target,
    },
    glass: {
      alignItems: "center",
      borderRadius: radius.pill,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
    },
    iconSlot: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    disabled: { opacity: 0.46 },
    pressed: {
      opacity: 0.72,
    },
  });
