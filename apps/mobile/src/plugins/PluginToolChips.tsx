import { useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Wrench } from "lucide-react-native";
import { MAX_FONT_SIZE_MULTIPLIER, Text } from "@/components/AppText";
import {
  iconSize,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
} from "@/theme";
import type { PluginDetailModel } from "./pluginDetailModel";

/** Keep full flow layout for measurement while hiding rows after the second. */
export function PluginToolChips({
  tools,
  expanded,
  width,
  onOverflowChange,
}: {
  tools: NonNullable<PluginDetailModel["tools"]>;
  expanded: boolean;
  width?: number;
  onOverflowChange(overflow: boolean): void;
}) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const chipHeight =
    lineHeight.bodySmall * Math.min(fontScale, MAX_FONT_SIZE_MULTIPLIER) +
    spacing.xs * 2;
  const collapsedHeight = chipHeight * 2 + spacing.sm;
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  return (
    <View
      testID="plugins.toolChips"
      style={[
        styles.clip,
        width !== undefined && { width },
        !expanded && { maxHeight: collapsedHeight },
      ]}
    >
      <View
        testID="plugins.toolChipsFlow"
        style={styles.flow}
        onLayout={({ nativeEvent: { layout } }) =>
          onOverflowChange(layout.height > collapsedHeight + 0.5)
        }
      >
        {tools.map((tool, index) => {
          const clipped = !expanded && hidden.has(index);
          return (
            <View
              key={tool.name + index}
              testID={"plugins.toolChip." + index}
              accessibilityElementsHidden={clipped}
              importantForAccessibility={
                clipped ? "no-hide-descendants" : "auto"
              }
              onLayout={({ nativeEvent: { layout } }) => {
                const beyondSecondRow =
                  layout.y + layout.height > collapsedHeight + 0.5;
                setHidden((previous) => {
                  if (previous.has(index) === beyondSecondRow) return previous;
                  const next = new Set(previous);
                  if (beyondSecondRow) next.add(index);
                  else next.delete(index);
                  return next;
                });
              }}
              style={[
                styles.chip,
                { height: chipHeight, backgroundColor: colors.surfaceChip },
                clipped && styles.hidden,
              ]}
            >
              <Wrench size={iconSize.xs} color={colors.textSecondary} />
              <Text
                numberOfLines={1}
                style={[styles.name, { color: colors.textSecondary }]}
              >
                {tool.name}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  flow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    flexShrink: 0,
  },
  chip: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  name: {
    flexShrink: 1,
    fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall,
  },
  hidden: { opacity: 0 },
});
