import { StyleSheet, View } from "react-native";
import { quotaLevelFromRemaining } from "@cindy/maker-shared/quota-level";
import { radius, useTheme } from "@/theme";

/** Both pickers draw the real remainder, without a native minimum fill width. */
export function ModelQuotaBar({
  remaining,
  label,
  testID,
}: {
  remaining: number;
  label: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const now = Math.max(0, Math.min(100, remaining));
  // Shared with every quota surface: 30% or less left is yellow, 10% or less is red.
  const level = quotaLevelFromRemaining(now);
  const fillColor =
    level === "crit"
      ? colors.quotaBarCrit
      : level === "warn"
        ? colors.quotaBarWarn
        : colors.textSecondary;

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now }}
      style={[styles.track, { backgroundColor: colors.surfaceChip }]}
      testID={testID}
    >
      <View
        style={[styles.fill, { width: `${now}%`, backgroundColor: fillColor }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    borderRadius: radius.pill,
    height: 3,
    overflow: "hidden",
    width: 24,
  },
  fill: {
    height: "100%",
  },
});
