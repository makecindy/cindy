import { TaskMenuHeading, TaskTagsPanel } from "./TaskTags";
import { SessionActionSheetFrame } from "./SessionActionSheetFrame";
import type { RemoteSession } from "./types";
/** Task actions share content; Android presents them in a Compose bottom sheet. */
import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import {
  Archive,
  ArchiveRestore,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { BlurBackdrop } from "@/session/BlurBackdrop";
import {
  buildSessionActionMenu,
  type SessionSwipeAction,
} from "@/session/swipeRowRegistry";
import {
  iconSize,
  iconStroke,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";

const ACTION_ICONS: Record<SessionSwipeAction, LucideIcon> = {
  archive: Archive,
  delete: Trash2,
  pin: Pin,
  rename: Pencil,
  restore: ArchiveRestore,
  unpin: PinOff,
};

export function SessionActionSheet({
  session,
  onAction,
  onClose,
  onClosed,
  pinnedAt,
  status,
  visible,
}: {
  session?: RemoteSession | null;
  /** 点菜单项:父级负责关 sheet 并串后续(删除 Alert / 重命名弹窗 / 直接执行)。 */
  onAction(action: SessionSwipeAction): void;
  onClose(): void;
  /** 关闭动画完成、Modal 真正卸载后触发(兄弟 Modal 时序,同 DeviceMenuModal.onClosed)。 */
  onClosed?(): void;
  pinnedAt: string | null | undefined;
  status?: string | null;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  useEffect(() => {
    if (!visible) setTagsExpanded(false);
  }, [visible]);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const nativeSheet = Platform.OS === "android";
  const menu = buildSessionActionMenu(pinnedAt, status);

  return (
    <SessionActionSheetFrame
      visible={visible}
      onClose={onClose}
      onClosed={onClosed}
    >
      <View style={[styles.actionCard, nativeSheet && styles.nativeCard]}>
        {!nativeSheet && (
          <BlurBackdrop
            intensity={32}
            overlayColor={colors.sheetActionSurface}
          />
        )}
        {session && <TaskMenuHeading session={session} />}
        {!tagsExpanded &&
          menu
            .filter(
              (item) =>
                !item.destructive &&
                item.action !== "archive" &&
                item.action !== "restore",
            )
            .map((item) => {
              const IconComponent = ACTION_ICONS[item.action];
              const color = item.destructive
                ? colors.destructive
                : colors.textPrimary;
              return (
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="button"
                  key={item.action}
                  onPress={() => onAction(item.action)}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                  testID={`home.sessionActions.${item.action}`}
                >
                  <IconComponent
                    color={color}
                    size={iconSize.lg}
                    strokeWidth={iconStroke.regular}
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.actionLabel,
                      item.destructive && styles.actionLabelDanger,
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
        {visible && session && (
          <TaskTagsPanel
            key={`${session.canonicalDeviceId ?? session.deviceLinkDeviceId}:${session.id}`}
            session={session}
            expanded={tagsExpanded}
            onExpandedChange={setTagsExpanded}
          />
        )}
        {!tagsExpanded &&
          menu
            .filter(
              (item) =>
                item.destructive ||
                item.action === "archive" ||
                item.action === "restore",
            )
            .map((item) => {
              const IconComponent = ACTION_ICONS[item.action];
              const color = item.destructive
                ? colors.destructive
                : colors.textPrimary;
              return (
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="button"
                  key={item.action}
                  onPress={() => onAction(item.action)}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                  testID={`home.sessionActions.${item.action}`}
                >
                  <IconComponent
                    color={color}
                    size={iconSize.lg}
                    strokeWidth={iconStroke.regular}
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.actionLabel,
                      item.destructive && styles.actionLabelDanger,
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
      </View>
      <Pressable
        accessibilityLabel={t("session.common.cancel")}
        accessibilityRole="button"
        onPress={onClose}
        style={({ pressed }) => [
          styles.cancelCard,
          nativeSheet && styles.nativeCancel,
          pressed && styles.pressed,
        ]}
        testID="home.sessionActions.cancel"
      >
        {!nativeSheet && (
          <BlurBackdrop
            intensity={32}
            overlayColor={colors.sheetActionSurface}
          />
        )}
        <Text style={styles.cancelText}>{t("session.common.cancel")}</Text>
      </Pressable>
    </SessionActionSheetFrame>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    nativeCard: {
      borderWidth: 0,
    },
    nativeCancel: {
      backgroundColor: colors.surfaceChip,
      borderWidth: 0,
      borderRadius: radius.pill,
    },
    actionCard: {
      backgroundColor: "transparent",
      borderColor: colors.sheetActionBorder,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    actionRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 54,
      paddingHorizontal: spacing.lg,
    },
    actionLabel: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.bodySmall,
    },
    actionLabelDanger: {
      color: colors.destructive,
    },
    cancelCard: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderColor: colors.sheetActionBorder,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 54,
    },
    cancelText: {
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.bodySmall,
    },
    pressed: {
      opacity: 0.72,
    },
  });
