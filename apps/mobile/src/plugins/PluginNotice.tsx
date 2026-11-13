import { Pressable, StyleSheet, View } from "react-native";
import { CircleAlert, Info, WifiOff } from "lucide-react-native";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  iconSize,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
export interface PluginNoticeProps {
  title: string;
  compact?: boolean;
  unavailable?: boolean;
  detail?: string;
  icon?: "info" | "warning" | "offline";
  testID?: string;
  actions?: Array<{
    label: string;
    onPress(): void;
    disabled?: boolean;
    testID?: string;
  }>;
}
export function PluginNotice({
  title,
  compact,
  detail,
  icon = "info",
  testID,
  actions,
}: PluginNoticeProps) {
  const { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const Icon =
    icon === "offline" ? WifiOff : icon === "warning" ? CircleAlert : Info;
  const renderActions = () => (
    <>
      {actions?.length ? (
        <View style={[styles.actions, actions.length === 1 && styles.inlineActions]}>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              testID={action.testID}
              accessibilityRole="button"
              disabled={action.disabled}
              onPress={action.onPress}
              style={[styles.button, compact && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control }]}
            >
              <Text
                style={[
                  styles.action,
                  action.disabled && { color: colors.textTertiary },
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
  return (
    <View testID={testID} style={[styles.card, compact && { backgroundColor: "transparent", paddingHorizontal: 0, paddingVertical: spacing.xs }]} accessibilityLiveRegion="polite">
      <View style={[styles.row, compact && { alignItems: "baseline", flexWrap: "wrap" }]}>
        <Icon size={iconSize.sm} color={colors.textSecondary} />
        <View style={styles.content}>
          <Text style={styles.title}>{title}</Text>
          {detail ? <Text style={styles.body}>{detail}</Text> : null}
        </View>
        {actions?.length === 1 ? renderActions() : null}
      </View>
      {actions && actions.length > 1 ? renderActions() : null}
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      padding: spacing.md,
      gap: spacing.sm,
      backgroundColor: c.surfaceChip,
      borderRadius: radius.container,
    },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    content: { flex: 1, minWidth: 0, gap: spacing.xs },
    title: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    body: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textSecondary,
    },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    inlineActions: { maxWidth: "48%", flexShrink: 0 },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
      maxWidth: "100%",
    },
    action: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
  });
