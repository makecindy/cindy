/**
 * The one visible trace a 代输入 leaves in the task (matches Desktop): who
 * finished how many steps, where, and when. Never values or screen text.
 */
import { StyleSheet, View } from "react-native";
import { KeyRound } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  inputHandoffRecordHost,
  inputHandoffRecordMessage,
  type InputHandoffEndRecord,
} from "@cindy/maker-shared/synthetic-trigger";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export function InputHandoffRecordRow({ data }: { data?: Record<string, unknown> }) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const record = readRecord(data);
  if (!record) return null;
  const message = inputHandoffRecordMessage(record);
  const at = typeof data?.at === "string" ? new Date(data.at) : null;
  const time =
    at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })
      : undefined;
  const text = [
    t(`interaction.inputHandoff.record.${message.key}`, message.params),
    inputHandoffRecordHost(record.origin),
    time,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.row} accessibilityLabel={text} testID="message.systemCard.input-handoff">
      <View style={styles.divider} />
      <View style={styles.pill}>
        <KeyRound color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
        <Text style={styles.text} numberOfLines={1}>
          {text}
        </Text>
      </View>
      <View style={styles.divider} />
    </View>
  );
}

function readRecord(data?: Record<string, unknown>): InputHandoffEndRecord | null {
  if (!data) return null;
  if (!["succeeded", "cancelled", "failed", "expired"].includes(String(data.status))) return null;
  if (typeof data.steps !== "number" || !Number.isSafeInteger(data.steps) || data.steps < 0) return null;
  return data as unknown as InputHandoffEndRecord;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    divider: {
      backgroundColor: colors.border,
      flex: 1,
      height: StyleSheet.hairlineWidth,
    },
    pill: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      flexShrink: 1,
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    text: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.micro,
      lineHeight: lineHeight.micro,
      fontWeight: fontWeight.medium,
    },
  });
