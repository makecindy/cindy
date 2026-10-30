import { StyleSheet, View } from "react-native";
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
  // Match the desktop provider rail: <=10% critical, <30% warning.
  const fillColor =
    now <= 10
      ? colors.quotaBarCrit
      : now < 30
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
