import {
  Host,
  List,
  HStack,
  Image as NativeImage,
  RNHostView,
  Section,
  Text,
  Toggle,
  VStack,
  Button,
  ProgressView,
  DisclosureGroup,
  Divider,
} from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  labelsHidden,
  accessibilityLabel,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listRowSeparatorTint,
  listStyle,
  padding,
  scrollContentBackground,
  tint,
  scaleEffect,
  contentShape,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { Image, StyleSheet, View, useWindowDimensions } from "react-native";
import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { resolveRemoteText } from "@cindy/device-link";
import { ComposerNativeRow } from "@/session/ComposerNativeRow";
import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import type { PluginDetailViewProps } from "./PluginDetailView";
import { PluginToolChips } from "./PluginToolChips";

export function PluginDetailView(p: PluginDetailViewProps) {
  const { t, i18n } = useTranslation();
  const { mode, colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const primaryStyle = useNativeGlassButtonStyle({ prominent: true });
  const secondaryStyle = useNativeGlassButtonStyle();
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const { model } = p;
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  const [hostWidth, setHostWidth] = useState(width);
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
  const uri = p.row.item.display.avatar?.value;
  const Actions = fontScale > 1.2 || width < 380 ? VStack : HStack;
  const note = (value: string, id?: string) => (
    <Text
      testID={id}
      modifiers={[
        font({ textStyle: "subheadline" }),
        foregroundStyle(colors.textSecondary),
      ]}
    >
      {value}
    </Text>
  );
  const button = (
    label: string,
    onPress: () => void,
    prominent: boolean,
    id: string,
  ) => (
    <Button
      key={id}
      testID={id}
      onPress={onPress}
      modifiers={[
        ...(prominent ? primaryStyle : secondaryStyle),
        frame({ maxWidth: Infinity }),
        disabled(p.busy),
      ]}
    >
      <Text
        modifiers={[
          font({ textStyle: "body", weight: "semibold" }),
          foregroundStyle(prominent ? colors.ctaText : colors.textPrimary),
          frame({ maxWidth: Infinity, minHeight: 28 }),
          padding({ horizontal: spacing.xs }),
        ]}
      >
        {label}
      </Text>
    </Button>
  );
  const chevron = (
    <NativeImage
      systemName="chevron.right"
      size={iconSize.xs}
      modifiers={[foregroundStyle(colors.textTertiary)]}
    />
  );
  const statusKey =
    model.status === "approvalRequired" && model.builtin
      ? "builtinRecovery"
      : model.status === "setupRequired" &&
          !model.missing.length &&
          model.expired.length
        ? "setupExpired"
        : model.status;
  const status = model.status ? (
    <VStack
      alignment="leading"
      spacing={spacing.md}
      modifiers={[
        listRowSeparator("hidden"),
        padding({ vertical: spacing.sm }),
      ]}
      testID="plugins.status"
    >
      {model.status === "loading" ? <ProgressView /> : null}
      {note(t("plugins.detail.status." + statusKey))}
      {!p.settingsOpen && model.statusAction && model.statusAction !== "enable"
        ? button(
            t("plugins.detail.action." + model.statusAction),
            p.onResolveStatus,
            true,
            "plugins.resolveStatus",
          )
        : null}
    </VStack>
  ) : model.runtimeIssue ? (
    note(
      t(
        model.runtimeIssue === "fused"
          ? "plugins.detail.runtimeFused"
          : "plugins.detail.runtimeIssue",
      ),
      "plugins.runtimeIssue",
    )
  ) : null;
  return (
    <Host
      onLayoutContent={({ nativeEvent }) => setHostWidth(nativeEvent.width)}
      colorScheme={mode}
      seedColor={colors.textPrimary}
      style={styles.root}
      ignoreSafeArea="container"
    >
      <List
        key={p.settingsOpen ? "settings" : "detail"}
        modifiers={[
          listStyle("plain"),
          scrollContentBackground("hidden"),
          background(colors.surface),
          listRowSeparatorTint(colors.border),
        ]}
        testID={p.settingsOpen ? "plugins.settingsPage" : "plugins.detail"}
      >
        <Section
          modifiers={[
            listRowBackground(colors.surface),
            listRowInsets({
              leading: spacing.lg + spacing.xs,
              trailing: spacing.lg + spacing.xs,
              top: spacing.md,
              bottom: spacing.md,
            }),
          ]}
        >
          {p.previewLabel ? (
            <VStack
              alignment="leading"
              modifiers={[listRowSeparator("hidden")]}
            >
              {note(p.previewLabel)}
            </VStack>
          ) : null}
          {!p.settingsOpen ? (
            <VStack
              alignment="leading"
              spacing={spacing.lg}
              modifiers={[
                listRowSeparator("hidden"),
                listRowInsets({
                  leading: spacing.lg + spacing.xs,
                  trailing: spacing.lg + spacing.xs,
                  top: spacing.sm,
                  bottom: spacing.lg,
                }),
              ]}
              testID="plugins.identity"
            >
              <HStack spacing={spacing.lg}>
                <RNHostView matchContents>
                  {uri &&
                  /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(
                    uri,
                  ) ? (
                    <Image source={{ uri }} style={styles.icon} />
                  ) : (
                    <View
                      style={[
                        styles.icon,
                        styles.fallback,
                        { backgroundColor: colors.surfaceChip },
                      ]}
                    >
                      <Puzzle
                        size={iconSize.xxl}
                        color={colors.textSecondary}
                      />
                    </View>
                  )}
                </RNHostView>
                <VStack
                  alignment="leading"
                  spacing={spacing.xs}
                  modifiers={[
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                  ]}
                >
                  <HStack
                    spacing={spacing.sm}
                    modifiers={[frame({ maxWidth: Infinity })]}
                  >
                    <Text
                      modifiers={[
                        font({ textStyle: "title2", weight: "semibold" }),
                        frame({ maxWidth: Infinity, alignment: "leading" }),
                      ]}
                    >
                      {text(p.row.item.display.title)}
                    </Text>
                    <Toggle
                      label={t("plugins.enabled")}
                      isOn={p.enabled}
                      onIsOnChange={p.onEnabledChange}
                      modifiers={[
                        labelsHidden(),
                        frame({ width: 61, height: 28 }),
                        scaleEffect({ x: 48 / 61, y: 24 / 28 }),
                        frame({ width: 56, height: 44 }),
                        contentShape(shapes.rectangle()),
                        accessibilityLabel(t("plugins.enabled")),
                        disabled(p.busy || !p.online || !model.canToggle),
                        tint(colors.inputCaret),
                      ]}
                      testID="plugins.enabled"
                    />
                  </HStack>
                  {note(p.row.host.deviceName)}
                </VStack>
              </HStack>
              {model.description || p.row.item.display.subtitle ? (
                <Text
                  modifiers={[
                    font({ textStyle: "subheadline" }),
                    foregroundStyle(colors.textSecondary),
                    lineLimit(3),
                  ]}
                >
                  {model.description || text(p.row.item.display.subtitle!)}
                </Text>
              ) : null}
            </VStack>
          ) : null}
          {p.settingsOpen && model.status === "setupRequired" ? null : status}
          {!p.settingsOpen && model.canUseTasks ? (
            <VStack
              alignment="leading"
              spacing={spacing.md}
              modifiers={[
                listRowSeparator("hidden"),
                // List cells clip the native glass shadow; reserve its tail inside this row.
                padding({ bottom: spacing.xl }),
              ]}
              testID="plugins.use"
            >
              <Text
                modifiers={[font({ textStyle: "title3", weight: "semibold" })]}
                testID="plugins.useHeading"
              >
                {t("plugins.detail.useItIn")}
              </Text>
              <Actions
                spacing={spacing.md}
                modifiers={[frame({ maxWidth: Infinity })]}
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
              </Actions>
            </VStack>
          ) : null}
          {!p.settingsOpen && model.mainSurface ? (
            <ComposerNativeRow
              title={t("plugins.detail.openPlugin")}
              accessory={chevron}
              disabled={p.busy || !p.online || !p.enabled || !model.canToggle}
              onPress={() => p.onOpen(model.mainSurface!)}
              testID="plugins.openPlugin"
            />
          ) : null}
          {model.tools?.length ? (
            <VStack
              alignment="leading"
              spacing={spacing.md}
              modifiers={[
                listRowSeparator("hidden"),
                ...(model.canUseTasks && !p.settingsOpen && !model.mainSurface
                  ? [
                      listRowInsets({
                        leading: spacing.lg + spacing.xs,
                        trailing: spacing.lg + spacing.xs,
                        top: 0,
                        bottom: spacing.md,
                      }),
                    ]
                  : []),
              ]}
              testID="plugins.tools"
            >
              <HStack spacing={spacing.md}>
                <Text
                  modifiers={[
                    font({ textStyle: "title3", weight: "semibold" }),
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                  ]}
                >
                  {t("plugins.detail.tools") + " · " + model.tools.length}
                </Text>
                {toolsOverflow ? (
                  <Button
                    testID="plugins.toolsDisclosure"
                    onPress={() => setToolsExpanded(!toolsExpanded)}
                    modifiers={[
                      buttonStyle("plain"),
                      frame({ minWidth: 44, minHeight: 44 }),
                      contentShape(shapes.rectangle()),
                      accessibilityLabel(
                        t(
                          toolsExpanded
                            ? "plugins.detail.showLess"
                            : "plugins.detail.showAll",
                        ),
                      ),
                    ]}
                  >
                    <Text
                      modifiers={[
                        font({ textStyle: "body" }),
                        foregroundStyle(colors.inputCaret),
                      ]}
                    >
                      {t(
                        toolsExpanded
                          ? "plugins.detail.showLess"
                          : "plugins.detail.showAll",
                      )}
                    </Text>
                  </Button>
                ) : null}
              </HStack>
              <VStack
                alignment="leading"
                spacing={0}
                modifiers={[frame({ maxWidth: Infinity })]}
              >
                <RNHostView matchContents>
                  <PluginToolChips
                    key={
                      p.row.key + model.tools.map((tool) => tool.name).join("|")
                    }
                    tools={model.tools}
                    expanded={toolsExpanded}
                    width={Math.max(
                      0,
                      hostWidth - (spacing.lg + spacing.xs) * 2,
                    )}
                    onOverflowChange={setToolsOverflow}
                  />
                </RNHostView>
              </VStack>
            </VStack>
          ) : null}
          {model.permissions?.length ? (
            <VStack
              alignment="leading"
              spacing={spacing.md}
              modifiers={[listRowSeparator("hidden")]}
              testID="plugins.permissions"
            >
              <Text
                modifiers={[font({ textStyle: "title3", weight: "semibold" })]}
              >
                {t("plugins.detail.permissions")}
              </Text>
              {model.permissions?.map((permission, index) =>
                permission.description ? (
                  <DisclosureGroup
                    key={index}
                    label={permission.title}
                    modifiers={[tint(colors.textSecondary)]}
                  >
                    {note(permission.description)}
                  </DisclosureGroup>
                ) : (
                  <Text key={index}>{permission.title}</Text>
                ),
              )}
            </VStack>
          ) : null}
          {detailFacts.length || model.hasSettings ? (
            <VStack
              alignment="leading"
              spacing={spacing.md}
              modifiers={[listRowSeparator("hidden")]}
              testID="plugins.metadata"
            >
              <Text
                modifiers={[font({ textStyle: "title3", weight: "semibold" })]}
              >
                {t("plugins.detail.details")}
              </Text>
              {detailFacts.map((fact, index) => (
                <VStack
                  key={fact.key}
                  alignment="leading"
                  spacing={spacing.md}
                  modifiers={[
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                  ]}
                >
                  {fact.key === "contents" || fact.key === "location" ? (
                    <VStack
                      key={fact.key}
                      alignment="leading"
                      spacing={spacing.xs}
                      testID={"plugins.fact." + fact.key}
                    >
                      {note(fact.title)}
                      <Text
                        modifiers={[
                          font({
                            textStyle:
                              fact.key === "location" ? "footnote" : "body",
                          }),
                        ]}
                      >
                        {fact.value}
                      </Text>
                    </VStack>
                  ) : (
                    <HStack
                      key={fact.key}
                      spacing={spacing.md}
                      testID={"plugins.fact." + fact.key}
                    >
                      {note(fact.title)}
                      <Text
                        modifiers={[
                          font({ textStyle: "body" }),
                          frame({ maxWidth: Infinity, alignment: "trailing" }),
                        ]}
                      >
                        {fact.value}
                      </Text>
                    </HStack>
                  )}
                  {index < detailFacts.length - 1 ? <Divider /> : null}
                </VStack>
              ))}
              {model.hasSettings ? (
                <VStack alignment="leading" testID="plugins.computerSettings">
                  {note(t("plugins.detail.computerSettings"))}
                </VStack>
              ) : null}
            </VStack>
          ) : null}
        </Section>
      </List>
    </Host>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  icon: { width: 72, height: 72, borderRadius: radius.container },
  fallback: { alignItems: "center", justifyContent: "center" },
});
