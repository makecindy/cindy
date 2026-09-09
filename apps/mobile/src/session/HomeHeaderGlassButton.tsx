/**
 * 首页顶栏图标钮:iOS 26+ 走系统 Liquid Glass(UIGlassEffect),其它环境回退成无底图标热区。
 */
import { GlassView } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { radius } from "@/theme/tokens";

export function HomeHeaderGlassButton({
  accessibilityLabel,
  children,
  onPress,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  onPress(): void;
  testID: string;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
      testID={testID}
    >
      {liquidGlass ? (
        <GlassView
          colorScheme={mode}
          glassEffectStyle="regular"
          isInteractive
          style={styles.glass}
          tintColor={colors.surface}
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
      height: 44,
      width: 44,
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
    pressed: {
      opacity: 0.72,
    },
  });
