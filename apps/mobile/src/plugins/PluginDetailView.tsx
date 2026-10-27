import { useEffect, useState, type ReactNode } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  ActivityIndicator,
} from "react-native";
import { useTranslation } from "react-i18next";
import { resolveRemoteText } from "@cindy/device-link";
import { Puzzle, ChevronRight } from "lucide-react-native";
import { Text } from "@/components/AppText";
import { NativeSwitch } from "@/platform/chrome/NativeSwitch";
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
import type { PluginPageSurface } from "@cindy/device-link";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";
import type { PluginDetailModel } from "./pluginDetailModel";
import { useMobileKeyboardState } from "@/session/useMobileKeyboardState";
import { PluginPermissionCard } from "./PluginPermissionCard";
import { PluginToolChips } from "./PluginToolChips";
import { PluginNotice, type PluginNoticeProps } from "./PluginNotice";
import { pluginDetailNotices } from "./pluginDetailNotices";

export interface PluginDetailViewProps {
  row: HostedRemoteCollectionItem;
  enabled: boolean;
  busy: boolean;
  /** Navigation/read recovery may remain available during a pending management transaction. */
  statusRecoveryBusy?: boolean;
  online: boolean;
  model: PluginDetailModel;
  settingsOpen: boolean;
  previewLabel?: string;
  settingsContent?: ReactNode;
  managementNotice?: PluginNoticeProps;
  onEnabledChange(enabled: boolean): void;
  onOpen(surface: PluginPageSurface): void;
  onNewTask(): void;
  onChooseTask(): void;
  onResolveStatus(): void;
}

/** Android shares the page hierarchy and Host facts, with its platform Switch. */
export function PluginDetailView(p: PluginDetailViewProps) {
  const { t, i18n } = useTranslation(),
    { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { model } = p;
  const facts = (model.details ?? []).filter((fact) => fact.value.trim());
  if (model.version?.trim() && !facts.some((fact) => fact.key === "version")) {
    facts.push({
      key: "version",
      title: t("plugins.detail.version"),
      value: model.version,
    });
  }
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  useEffect(() => { setToolsExpanded(false); setPermissionsExpanded(false); }, [p.row.key]);
  const { visible: keyboardVisible } = useMobileKeyboardState();
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const uri = p.row.item.display.avatar?.value;
  const note = (value: string) => <Text style={styles.note}>{value}</Text>;
  const button = (
    label: string,
    onPress: () => void,
    primary: boolean,
    testID: string,
  ) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={p.busy}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.primary : styles.secondary,
        p.busy && styles.unavailable,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>
        {label}
      </Text>
    </Pressable>
  );
  const row = (
    label: string,
    onPress: () => void,
    unavailable: boolean,
    testID: string,
  ) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={unavailable}
      onPress={onPress}
      style={[styles.row, unavailable && styles.unavailable]}
    >
      <Text style={styles.rowText}>{label}</Text>
      <ChevronRight size={iconSize.md} color={colors.textTertiary} />
    </Pressable>
  );
  const notices = pluginDetailNotices(model);
  return (
    <View style={styles.root}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        testID={p.settingsOpen ? "plugins.settingsPage" : "plugins.detail"}
        contentContainerStyle={styles.content}
      >
        {p.previewLabel ? note(p.previewLabel) : null}
        {notices.top ? (
          <PluginNotice
            testID="plugins.status"
            icon={notices.top === "offline" ? "offline" : "warning"}
            title={t("plugins.notice.title." + notices.top)}
            detail={["offline", "loadFailed"].includes(notices.top) ? undefined : t(
              notices.top === "fused"
                ? "plugins.detail.runtimeFused"
                : "plugins.detail.status." + notices.top,
            )}
            actions={
              model.statusAction &&
              ["connect", "retry"].includes(model.statusAction)
                ? [
                    {
                      label: t("plugins.detail.action." + model.statusAction),
                      onPress: p.onResolveStatus,
                      disabled: p.statusRecoveryBusy ?? p.busy,
                      testID: "plugins.resolveStatus",
                    },
                  ]
                : undefined
            }
          />
        ) : null}
        {p.managementNotice ? <PluginNotice {...p.managementNotice} /> : null}
        {notices.loading ? (
          <ActivityIndicator
            testID="plugins.loading"
            color={colors.textSecondary}
          />
        ) : null}
        {!p.settingsOpen ? (
          <View style={styles.identity}>
            <View style={styles.hero}>
              {uri &&
              /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(uri) ? (
                <Image source={{ uri }} style={styles.icon} />
              ) : (
                <View style={[styles.icon, styles.fallback]}>
                  <Puzzle size={iconSize.xxl} color={colors.textSecondary} />
                </View>
              )}
              <View style={styles.identityText}>
                <View style={styles.titleRow}>
                  <Text style={[styles.title, styles.titleText]}>
                    {text(p.row.item.display.title)}
                  </Text>
                  <NativeSwitch
                    testID="plugins.enabled"
                    accessibilityLabel={t("plugins.enabled")}
                    value={p.enabled}
                    disabled={p.busy || !p.online || !model.canToggle}
                    onValueChange={p.onEnabledChange}
                  />
                </View>
                {note(p.row.host.deviceName)}
              </View>
            </View>
            {model.description || p.row.item.display.subtitle ? (
              <Text numberOfLines={3} style={styles.note}>
                {model.description || text(p.row.item.display.subtitle!)}
              </Text>
            ) : null}
          </View>
        ) : null}
        {p.settingsContent ? (
          <View style={styles.information}>
            <Text style={styles.sectionHeading}>{t("plugins.settings")}</Text>
            <View testID="plugins.settingsCard">
              {p.settingsContent}
            </View>
          </View>
        ) : null}
        {!p.settingsOpen && model.mainSurface
          ? row(
              t("plugins.detail.openPlugin"),
              () => p.onOpen(model.mainSurface!),
              p.busy || !p.online || !p.enabled || !model.canToggle,
              "plugins.openPlugin",
            )
          : null}
        {model.tools?.length ? (
          <View style={styles.information} testID="plugins.tools">
            <View style={styles.titleRow}>
              <Text style={[styles.sectionHeading, styles.titleText]}>
                {t("plugins.detail.tools") + " · " + model.tools.length}
              </Text>
              {toolsOverflow ? (
                <Pressable
                  testID="plugins.toolsDisclosure"
                  accessibilityRole="button"
                  accessibilityState={{ expanded: toolsExpanded }}
                  onPress={() => setToolsExpanded(!toolsExpanded)}
                  style={styles.toolsToggle}
                >
                  <Text style={styles.toolsToggleText}>
                    {t(
                      toolsExpanded
                        ? "plugins.detail.showLess"
                        : "plugins.detail.showAll",
                    )}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <PluginToolChips
              key={p.row.key + model.tools.map((tool) => tool.name).join("|")}
              tools={model.tools}
              expanded={toolsExpanded}
              onOverflowChange={setToolsOverflow}
            />
          </View>
        ) : null}
        {model.permissions?.length ? (
          <View style={styles.information}>
            <View style={styles.titleRow}>
              <Text style={[styles.sectionHeading, styles.titleText]}>{t("plugins.detail.permissions")}</Text>
              {model.permissions.length > 4 ? <Pressable
                testID="plugins.permissionsDisclosure" accessibilityRole="button"
                accessibilityState={{ expanded: permissionsExpanded }}
                onPress={() => setPermissionsExpanded(!permissionsExpanded)} style={styles.toolsToggle}>
                <Text style={styles.toolsToggleText}>{t(permissionsExpanded ? "plugins.collapseFields" : "plugins.expandFields")}</Text>
              </Pressable> : null}
            </View>
            <PluginPermissionCard
              permissions={permissionsExpanded ? model.permissions : model.permissions.slice(0, 4)}
              showHeading={false}
            />
          </View>
        ) : null}
        {facts.length ? (
          <View style={styles.information} testID="plugins.metadata">
            <Text style={styles.sectionHeading}>
              {t("plugins.detail.details")}
            </Text>
            {facts.map((fact) => (
              <View
                key={fact.key}
                style={styles.metadataRow}
                testID={"plugins.fact." + fact.key}
              >
                {note(fact.title)}
                <Text
                  style={[styles.note, styles.titleText, styles.metadataValue]}
                >
                  {fact.value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
      {!p.settingsOpen && model.canUseTasks && !keyboardVisible ? (
        <View style={styles.use} testID="plugins.use">
          <View style={[styles.actions, styles.verticalActions]}>
            {button(t("plugins.newTask"), p.onNewTask, true, "plugins.newTask")}
            {button(
              t("plugins.chooseTask"),
              p.onChooseTask,
              false,
              "plugins.chooseTask",
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    content: {
      paddingHorizontal: spacing.lg + spacing.xs,
      paddingVertical: spacing.lg,
      paddingBottom: spacing.xxl,
    },
    identity: {
      gap: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
    },
    hero: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
    identityText: { flex: 1, gap: spacing.xs },
    icon: { width: 72, height: 72, borderRadius: radius.container },
    fallback: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceChip,
    },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    note: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      color: c.textSecondary,
    },
    use: {
      paddingHorizontal: spacing.lg + spacing.xs,
      paddingVertical: spacing.md,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    titleText: { flex: 1 },
    information: {
      gap: spacing.md,
      paddingVertical: spacing.lg,
    },
    toolsToggle: {
      minWidth: 44,
      minHeight: 44,
      alignItems: "flex-end",
      justifyContent: "center",
    },
    toolsToggleText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      color: c.inputCaret,
    },
    metadataValue: { textAlign: "right" },
    metadataRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    sectionHeading: {
      fontSize: typeScale.subtitle,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    actions: { flexDirection: "row", gap: spacing.md },
    verticalActions: { flexDirection: "column" },
    button: {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    primary: { backgroundColor: c.cta },
    secondary: { backgroundColor: c.surfaceChip },
    buttonText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
      textAlign: "center",
    },
    primaryText: { color: c.ctaText },
    row: {
      minHeight: 60,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingVertical: spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowText: {
      flex: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      color: c.textPrimary,
    },
    unavailable: { opacity: 0.5 },
  });
