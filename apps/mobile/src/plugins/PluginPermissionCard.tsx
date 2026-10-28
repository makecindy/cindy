import { View, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import {
  AppWindow,
  Bot,
  Cpu,
  FileCode2,
  FilePen,
  FolderOpen,
  FolderPlus,
  Globe,
  GraduationCap,
  KeyRound,
  LayoutTemplate,
  Library,
  MapPin,
  Megaphone,
  MessageCircleQuestion,
  PanelLeft,
  PanelRight,
  Radio,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react-native";
import { Text } from "@/components/AppText";
import {
  iconSize,
  iconStroke,
  spacing,
  radius,
  typeScale,
  lineHeight,
  fontWeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import type { PluginDetailModel } from "./pluginDetailModel";

const icons = {
  cindy: Sparkles,
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  "main-view": AppWindow,
  code: FileCode2,
  subscribe: Radio,
  card: LayoutTemplate,
  network: Globe,
  notify: Megaphone,
  confirm: MessageCircleQuestion,
  fs: FilePen,
  library: Library,
  "session-context": MapPin,
  pick: FolderOpen,
  preview: AppWindow,
  skill: GraduationCap,
  workspace: FolderPlus,
};

/** Host owns the copy and permission meaning. Older Hosts retain a neutral icon. */
export function PluginPermissionCard({
  permissions,
  showHeading = true,
  width,
}: {
  permissions: NonNullable<PluginDetailModel["permissions"]>;
  showHeading?: boolean;
  width?: number;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      testID="plugins.permissions"
      style={[styles.card, width !== undefined && { width }]}
    >
      {showHeading ? (
        <Text style={styles.heading}>{t("plugins.detail.permissions")}</Text>
      ) : null}
      {permissions.map((permission, index) => {
        const Icon =
          permission.labelKey === "panelLeft"
            ? PanelLeft
            : [
                  "networkSecret",
                  "networkSecretOauth",
                  "networkSecretGhCli",
                  "networkSecretIdentity",
                ].includes(permission.labelKey ?? "")
              ? KeyRound
              : Object.prototype.hasOwnProperty.call(
                    icons,
                    permission.kind ?? "",
                  )
                ? icons[permission.kind as keyof typeof icons]
                : Shield;
        return (
          <View key={index} style={styles.row}>
            <Icon
              size={iconSize.action}
              strokeWidth={iconStroke.thin}
              color={colors.textSecondary}
            />
            <View style={styles.copy}>
              <Text style={styles.title}>{permission.title}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      padding: spacing.lg,
      gap: spacing.lg,
      backgroundColor: c.surfaceElevated,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    heading: {
      fontSize: typeScale.subtitle,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    row: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
    copy: { flex: 1, gap: spacing.xs },
    title: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
  });
