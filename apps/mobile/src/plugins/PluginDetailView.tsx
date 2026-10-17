import { useEffect, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  ActivityIndicator,
  useWindowDimensions,
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
import { PluginToolChips } from "./PluginToolChips";

export interface PluginDetailViewProps {
  row: HostedRemoteCollectionItem;
  enabled: boolean;
  busy: boolean;
  online: boolean;
  model: PluginDetailModel;
  settingsOpen: boolean;
  previewLabel?: string;
  onEnabledChange(enabled: boolean): void;
  onOpen(surface: PluginPageSurface): void;
  onNewTask(): void;
  onChooseTask(): void;
  onSettings(): void;
  onResolveStatus(): void;
}

function InformationRow({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.informationRow}
      >
        <Text style={styles.rowText}>{title}</Text>
        <Text style={styles.note}>{expanded ? "−" : "+"}</Text>
      </Pressable>
      {expanded ? <Text style={styles.note}>{description}</Text> : null}
    </View>
  );
}

/** Android shares the page hierarchy and Host facts, with its platform Switch. */
export function PluginDetailView(p: PluginDetailViewProps) {
  const { t, i18n } = useTranslation(),
    { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width, fontScale } = useWindowDimensions();
  const { model } = p;
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  useEffect(() => setToolsExpanded(false), [p.row.key]);
  const detailFacts = (
    model.details ?? [
      ...(model.version
        ? [
            {
              key: "version",
              title: t("plugins.detail.version"),
              value: "v" + model.version,
            },
          ]
        : []),
      {
        key: "identifier",
        title: t("plugins.detail.identifier"),
        value: p.row.item.ref.id,
      },
    ]
  ).filter((fact) => fact.title.trim() && fact.value.trim());
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
  const statusKey =
    model.status === "approvalRequired" && model.builtin
      ? "builtinRecovery"
      : model.status === "setupRequired" &&
          !model.missing.length &&
          model.expired.length
        ? "setupExpired"
        : model.status;
  return (
    <ScrollView
      testID={p.settingsOpen ? "plugins.settingsPage" : "plugins.detail"}
      contentContainerStyle={styles.content}
    >
      {p.previewLabel ? note(p.previewLabel) : null}
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
      {model.status && !(p.settingsOpen && model.status === "setupRequired") ? (
        <View testID="plugins.status" style={styles.status}>
          {model.status === "loading" ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : null}
          {note(t("plugins.detail.status." + statusKey))}
          {!p.settingsOpen &&
          model.statusAction &&
          model.statusAction !== "enable"
            ? button(
                t("plugins.detail.action." + model.statusAction),
                p.onResolveStatus,
                true,
                "plugins.resolveStatus",
              )
            : null}
        </View>
      ) : model.runtimeIssue ? (
        note(
          t(
            model.runtimeIssue === "fused"
              ? "plugins.detail.runtimeFused"
              : "plugins.detail.runtimeIssue",
          ),
        )
      ) : null}
      {!p.settingsOpen && model.canUseTasks ? (
        <View style={styles.use}>
          <Text style={styles.sectionHeading} testID="plugins.useHeading">
            {t("plugins.detail.useItIn")}
          </Text>
          <View
            style={[
              styles.actions,
              (fontScale > 1.2 || width < 380) && styles.verticalActions,
            ]}
          >
            {button(
              t("plugins.newTask"),
              p.onNewTask,
              false,
              "plugins.newTask",
            )}
            {button(
              t("plugins.chooseTask"),
              p.onChooseTask,
              false,
              "plugins.chooseTask",
            )}
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
        <View style={styles.information} testID="plugins.permissions">
          <Text style={styles.sectionHeading}>
            {t("plugins.detail.permissions")}
          </Text>
          {model.permissions?.map((permission, index) =>
            permission.description ? (
              <InformationRow
                key={index}
                title={permission.title}
                description={permission.description}
              />
            ) : (
              <Text key={index} style={styles.rowText}>
                {permission.title}
              </Text>
            ),
          )}
        </View>
      ) : null}
      {detailFacts.length || model.hasSettings ? (
        <View style={styles.information} testID="plugins.metadata">
          <Text style={styles.sectionHeading}>
            {t("plugins.detail.details")}
          </Text>
          {detailFacts.map((fact, index) => (
            <View
              key={fact.key}
              testID={"plugins.fact." + fact.key}
              style={
                fact.key === "contents" || fact.key === "location"
                  ? [
                      styles.toolDescription,
                      index < detailFacts.length - 1 && styles.factSeparator,
                    ]
                  : [
                      styles.metadataRow,
                      index < detailFacts.length - 1 && styles.factSeparator,
                    ]
              }
            >
              {note(fact.title)}
              <Text
                style={[
                  styles.rowText,
                  fact.key !== "contents" &&
                    fact.key !== "location" &&
                    styles.metadataValue,
                ]}
              >
                {fact.value}
              </Text>
            </View>
          ))}
          {model.hasSettings ? (
            <View testID="plugins.computerSettings">
              {note(t("plugins.detail.computerSettings"))}
            </View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
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
    status: { gap: spacing.md, paddingVertical: spacing.lg },
    use: { gap: spacing.md, paddingBottom: spacing.lg },
    titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    titleText: { flex: 1 },
    information: {
      gap: spacing.md,
      paddingVertical: spacing.lg,
    },
    factSeparator: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      paddingBottom: spacing.md,
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
    informationRow: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 44,
      gap: spacing.sm,
    },
    toolDescription: { gap: spacing.xs },
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
