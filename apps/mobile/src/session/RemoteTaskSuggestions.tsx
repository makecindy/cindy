import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  ChevronRight,
  FileText,
  FolderDown,
  Gauge,
  HardDrive,
  Shuffle,
} from "lucide-react-native";
import { Text } from "@/components/AppText";
import {
  MainWindowActionButton,
  MainWindowRowButton,
  StatusDot,
} from "@/components/MobilePrimitives";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  typeScale,
} from "@/theme/tokens";
import {
  REMOTE_TASK_SUGGESTION_BATCHES,
  type RemoteTaskSuggestionId,
} from "./remoteTaskSuggestionsModel";

const ICONS = {
  findFile: FileText,
  computerStatus: Gauge,
  projectProgress: BookOpen,
  downloads: FolderDown,
  summarizeDocument: FileText,
  storageUsage: HardDrive,
};

export function RemoteTaskSuggestions({
  mode,
  onNewSession,
  onSelect,
}: {
  mode: "empty" | "footer";
  onNewSession(): void;
  onSelect(id: RemoteTaskSuggestionId): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [batch, setBatch] = useState(0);
  const empty = mode === "empty";
  return (
    <View style={styles.root} testID={`home.taskSuggestions.${mode}`}>
      {empty ? (
        <View style={styles.connection}>
          <StatusDot tone="ready" />
          <Text style={styles.caption}>
            {t("devices.list.taskSuggestions.connected")}
          </Text>
        </View>
      ) : null}
      <Text style={empty ? styles.title : styles.footerTitle}>
        {t(`devices.list.taskSuggestions.${empty ? "title" : "footerTitle"}`)}
      </Text>
      <Text style={styles.copy}>
        {t(`devices.list.taskSuggestions.${empty ? "copy" : "footerCopy"}`)}
      </Text>
      {empty ? (
        <MainWindowActionButton
          action={{
            label: t("devices.list.taskSuggestions.newTask"),
            tone: "primary",
            onPress: onNewSession,
            testID: "home.taskSuggestions.newTask",
          }}
          style={styles.newTask}
        />
      ) : null}
      <View style={styles.heading}>
        <Text style={styles.caption}>
          {t("devices.list.taskSuggestions.tryThese")}
        </Text>
        <MainWindowRowButton
          accessibilityLabel={t("devices.list.taskSuggestions.shuffle")}
          onPress={() =>
            setBatch(
              (current) =>
                (current + 1) % REMOTE_TASK_SUGGESTION_BATCHES.length,
            )
          }
          style={styles.shuffle}
          testID="home.taskSuggestions.shuffle"
        >
          <Shuffle
            color={colors.textSecondary}
            size={iconSize.sm}
            strokeWidth={iconStroke.regular}
          />
          <Text style={styles.caption}>
            {t("devices.list.taskSuggestions.shuffle")}
          </Text>
        </MainWindowRowButton>
      </View>
      {REMOTE_TASK_SUGGESTION_BATCHES[batch].map((id) => {
        const Icon = ICONS[id];
        return (
          <MainWindowRowButton
            key={id}
            accessibilityLabel={t(
              `devices.list.taskSuggestions.items.${id}.label`,
            )}
            onPress={() => onSelect(id)}
            style={styles.row}
            testID={`home.taskSuggestions.${id}`}
          >
            <Icon
              color={colors.textSecondary}
              size={iconSize.lg}
              strokeWidth={iconStroke.regular}
            />
            <View style={styles.rowContent}>
              <Text style={styles.label}>
                {t(`devices.list.taskSuggestions.items.${id}.label`)}
              </Text>
              <Text style={styles.caption}>
                {t(`devices.list.taskSuggestions.items.${id}.hint`)}
              </Text>
            </View>
            <ChevronRight
              color={colors.textTertiary}
              size={iconSize.md}
              strokeWidth={iconStroke.regular}
            />
          </MainWindowRowButton>
        );
      })}
      {empty ? (
        <Text style={styles.footnote}>
          {t("devices.list.taskSuggestions.syncHint")}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xxl,
      paddingBottom: spacing.xl,
    },
    connection: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.headline,
      lineHeight: lineHeight.headline,
      fontWeight: fontWeight.medium,
    },
    footerTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.medium,
    },
    copy: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      marginTop: spacing.sm,
    },
    newTask: { marginTop: spacing.xl },
    heading: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: spacing.lg,
    },
    shuffle: {
      width: "auto",
      borderBottomWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      minHeight: 44,
      paddingHorizontal: spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingVertical: spacing.lg,
      minHeight: 44,
    },
    rowContent: { flex: 1, gap: spacing.xs },
    label: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    caption: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    footnote: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      textAlign: "center",
      marginTop: spacing.xl,
    },
  });
