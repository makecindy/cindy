import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { Puzzle } from "lucide-react-native";
import { iconSize, radius, useTheme } from "@/theme";
import type { ManagedMarketItem } from "./pluginManagementTypes";
import { pluginMarketIconUri } from "./pluginMarketCatalog";

/** Market icons are short-lived HTTPS links; an expired, missing or failed one shows the placeholder. */
/** Row icons match the installed list (54pt); the detail hero matches the installed detail (72pt). */
const EDGE = { row: 54, hero: 72 } as const;
export function PluginMarketIcon({ item, variant }: { item: Pick<ManagedMarketItem, "icon">; variant: keyof typeof EDGE }) {
  const { colors } = useTheme();
  const uri = pluginMarketIconUri(item);
  const [failed, setFailed] = useState<string>();
  const box = { width: EDGE[variant], height: EDGE[variant], borderRadius: radius.container };
  return uri && failed !== uri ? (
    <Image source={{ uri }} style={box} onError={() => setFailed(uri)} accessibilityIgnoresInvertColors />
  ) : (
    <View style={[box, styles.fallback, { backgroundColor: colors.surfaceChip }]}>
      <Puzzle size={variant === "hero" ? iconSize.xxl : iconSize.lg} color={colors.textSecondary} />
    </View>
  );
}
const styles = StyleSheet.create({
  fallback: { alignItems: "center", justifyContent: "center" },
});
