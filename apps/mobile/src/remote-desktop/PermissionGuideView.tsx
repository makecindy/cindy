import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  radius,
  spacing,
  textStyles,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export interface PermissionGuideViewProps {
  title: string;
  intro: string;
  rows: { label: string; value: string }[];
  guideLabel?: string;
  pending: boolean;
  onGuide(): void;
  reconnectLabel: string;
  onReconnect(): void;
  notice?: string;
}

export function PermissionGuideView(props: PermissionGuideViewProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
      <Text style={styles.caption}>{props.intro}</Text>
      {props.rows.length > 0 && (
        <View style={styles.group}>
          {props.rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.text}>{row.label}</Text>
              <Text style={styles.caption}>{row.value}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.actions}>
        {props.guideLabel && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              disabled: props.pending,
              busy: props.pending,
            }}
            disabled={props.pending}
            onPress={props.onGuide}
            style={[
              styles.button,
              styles.primary,
              props.pending && styles.pending,
            ]}
          >
            <Text style={styles.primaryText}>{props.guideLabel}</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={props.onReconnect}
          style={[styles.button, !props.guideLabel && styles.primary]}
        >
          <Text style={props.guideLabel ? styles.text : styles.primaryText}>
            {props.reconnectLabel}
          </Text>
        </Pressable>
      </View>
      {props.notice && (
        <Text accessibilityRole="alert" style={styles.caption}>
          {props.notice}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    panel: {
      padding: spacing.md,
      gap: spacing.md,
      backgroundColor: colors.surface,
    },
    title: {
      ...textStyles.title,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    text: { ...textStyles.body, color: colors.textPrimary, flexShrink: 1 },
    caption: {
      ...textStyles.caption,
      color: colors.textSecondary,
      flexShrink: 1,
    },
    group: {
      padding: spacing.md,
      gap: spacing.lg,
      borderRadius: radius.container,
      backgroundColor: colors.surfaceElevated,
    },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    actions: { gap: spacing.sm },
    button: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    primary: { backgroundColor: colors.cta },
    primaryText: {
      ...textStyles.body,
      color: colors.ctaText,
      textAlign: "center",
    },
    pending: { opacity: 0.5 },
  });
