import {
  Host,
  Background,
  Divider,
  Rectangle,
  ZStack,
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
} from "@expo/ui/swift-ui";
import {
  Animation,
  animation,
  accessibilityHidden,
  clipped,
  fixedSize,
  onGeometryChange,
  rotationEffect,
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
import { iconSize, motionDuration, radius, spacing, useTheme } from "@/theme";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import type { PluginDetailViewProps } from "./PluginDetailView";
import { useMobileKeyboardState } from "@/session/useMobileKeyboardState";
import { PluginToolChips } from "./PluginToolChips";
import { PluginPermissionCard } from "./PluginPermissionCard";
import { PluginNativeNotice } from "./PluginNotice.ios";
import { pluginDetailNotices } from "./pluginDetailNotices";

export function PluginDetailView(p: PluginDetailViewProps) {
  const { t, i18n } = useTranslation();
  const { mode, colors } = useTheme();
  const reduceMotion = useReduceMotionEnabled();
  const { width, fontScale } = useWindowDimensions();
  const primaryStyle = useNativeGlassButtonStyle({ prominent: true });
  const secondaryStyle = useNativeGlassButtonStyle();
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const { model } = p;
  const facts = (model.details ?? []).filter((fact) => fact.value.trim());
  if (model.version?.trim() && !facts.some((fact) => fact.key === "version")) {
    facts.push({
      key: "version",
      title: t("plugins.detail.version"),
      value: model.version,
    });
  }
  const [factHeights, setFactHeights] = useState<Record<string, number>>({});
  useEffect(() => setFactHeights({}), [p.row.key]);
  const [expandedFacts, setExpandedFacts] = useState<Record<string, boolean>>(
    {},
  );
  useEffect(() => setExpandedFacts({}), [p.row.key]);
  const factsAnimation = Animation.easeInOut({
    duration: reduceMotion === false ? motionDuration.base / 1000 : 0,
  });
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  const [hostWidth, setHostWidth] = useState(width);
  useEffect(() => { setToolsExpanded(false); setPermissionsExpanded(false); }, [p.row.key]);
  const { visible: keyboardVisible } = useMobileKeyboardState();
  const uri = p.row.item.display.avatar?.value;
  const showActions = !p.settingsOpen && model.canUseTasks && !keyboardVisible;
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
          frame({ maxWidth: Infinity, minHeight: 36 }),
          padding({ horizontal: spacing.xs }),
        ]}
      >
        {label}
      </Text>
    </Button>
  );
  const sectionTitle = (title: string) => (
    <Text
      modifiers={[
        font({ textStyle: "title3", weight: "semibold" }),
        foregroundStyle(colors.textPrimary),
        frame({ maxWidth: Infinity, alignment: "leading" }),
      ]}
    >
      {title}
    </Text>
  );
  const chevron = (
    <NativeImage
      systemName="chevron.right"
      size={iconSize.xs}
      modifiers={[foregroundStyle(colors.textTertiary)]}
    />
  );
  const notices = pluginDetailNotices(model);
  const status = notices.top ? (
    <VStack modifiers={[listRowSeparator("hidden")]}>
      <PluginNativeNotice
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
    </VStack>
  ) : null;
  return (
    <Host
      onLayoutContent={({ nativeEvent }) => setHostWidth(nativeEvent.width)}
      colorScheme={mode}
      seedColor={colors.textPrimary}
      style={styles.root}
      ignoreSafeArea="container"
    >
      <ZStack
        alignment="bottom"
        modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}
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
            {status}
            {p.managementNotice ? (
              <VStack modifiers={[listRowSeparator("hidden")]}>
                <PluginNativeNotice {...p.managementNotice} />
              </VStack>
            ) : null}
            {notices.loading ? (
              <VStack
                testID="plugins.loading"
                modifiers={[
                  listRowSeparator("hidden"),
                  frame({ maxWidth: Infinity, alignment: "center" }),
                ]}
              >
                <ProgressView />
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
                  <VStack modifiers={[frame({ width: 72, height: 72 })]}>
                    <RNHostView matchContents>
                      <View collapsable={false} style={styles.icon}>
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
                      </View>
                    </RNHostView>
                  </VStack>
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
            {p.settingsContent ? (
              <VStack
                alignment="leading"
                spacing={spacing.md}
                modifiers={[listRowSeparator("hidden")]}
              >
                {sectionTitle(t("plugins.settings"))}
                <RNHostView matchContents>
                  <View
                    collapsable={false}
                    style={[
                      styles.settings,
                      {
                        width: Math.max(
                          0,
                          hostWidth - (spacing.lg + spacing.xs) * 2,
                        ),
                      },
                    ]}
                    testID="plugins.settingsCard"
                  >
                    {p.settingsContent}
                  </View>
                </RNHostView>
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
                modifiers={[listRowSeparator("hidden")]}
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
                        p.row.key +
                        model.tools.map((tool) => tool.name).join("|")
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
              <VStack alignment="leading" spacing={spacing.md}
                modifiers={[listRowSeparator("hidden"), animation(factsAnimation, permissionsExpanded)]}>
                <HStack alignment="center" spacing={spacing.sm}>
                  {sectionTitle(t("plugins.detail.permissions"))}
                  {model.permissions.length > 4 ? <Button
                    testID="plugins.permissionsDisclosure"
                    label={t(permissionsExpanded ? "plugins.collapseFields" : "plugins.expandFields")}
                    onPress={() => setPermissionsExpanded(!permissionsExpanded)}
                    modifiers={[buttonStyle("plain"), font({ textStyle: "subheadline" }), foregroundStyle(colors.inputCaret), frame({ minWidth: 44, minHeight: 44 }), contentShape(shapes.rectangle())]}
                  /> : null}
                </HStack>
                <RNHostView matchContents>
                  <PluginPermissionCard
                    permissions={permissionsExpanded ? model.permissions : model.permissions.slice(0, 4)}
                    showHeading={false}
                    width={Math.max(0, hostWidth - (spacing.lg + spacing.xs) * 2)}
                  />
                </RNHostView>
              </VStack>
            ) : null}
            {facts.length ? (
              <VStack
                alignment="leading"
                spacing={spacing.md}
                testID="plugins.metadata"
                modifiers={[
                  listRowSeparator("hidden"),
                  fixedSize({ horizontal: false, vertical: true }),
                  frame({ maxWidth: Infinity, alignment: "topLeading" }),
                  animation(
                    factsAnimation,
                    (expandedFacts.contents ? 1 : 0) |
                      (expandedFacts.location ? 2 : 0),
                  ),
                ]}
              >
                {sectionTitle(t("plugins.detail.details"))}
                <VStack alignment="leading" spacing={0}>
                  {facts.map((fact, index) => {
                    const expandable =
                      fact.key === "contents" || fact.key === "location";
                    const summary =
                      fact.key === "location"
                        ? fact.value
                            .replace(/[\\/]+$/, "")
                            .split(/[\\/]/)
                            .pop() || fact.value
                        : fact.key === "contents" && fact.value.includes(" · ")
                          ? fact.value.split(" · ")[0] + "…"
                          : fact.value;
                    const label = (
                      <HStack
                        spacing={spacing.lg}
                        modifiers={[
                          frame({ maxWidth: Infinity, minHeight: 50 }),
                        ]}
                      >
                        <Text
                          modifiers={[
                            font({ textStyle: "subheadline" }),
                            foregroundStyle(colors.textSecondary),
                            lineLimit(1),
                          ]}
                        >
                          {fact.title}
                        </Text>
                        <Text
                          modifiers={[
                            font({ textStyle: "subheadline" }),
                            foregroundStyle(colors.textPrimary),
                            lineLimit(1),
                            frame({
                              maxWidth: Infinity,
                              alignment: "trailing",
                            }),
                          ]}
                        >
                          {summary}
                        </Text>
                      </HStack>
                    );
                    return (
                      <VStack
                        key={p.row.key + ":" + fact.key}
                        alignment="leading"
                        spacing={0}
                      >
                        {expandable ? (
                          <VStack
                            testID={"plugins.fact." + fact.key}
                            alignment="leading"
                            spacing={0}
                          >
                            <Button
                              testID={"plugins.fact." + fact.key + ".toggle"}
                              onPress={() =>
                                setExpandedFacts((current) => ({
                                  ...current,
                                  [fact.key]: !current[fact.key],
                                }))
                              }
                              modifiers={[
                                buttonStyle("plain"),
                                contentShape(shapes.rectangle()),
                              ]}
                            >
                              <HStack
                                spacing={spacing.sm}
                                modifiers={[
                                  fixedSize({
                                    horizontal: false,
                                    vertical: true,
                                  }),
                                ]}
                              >
                                {label}
                                <NativeImage
                                  systemName="chevron.down"
                                  size={iconSize.xs}
                                  modifiers={[
                                    foregroundStyle(colors.textSecondary),
                                    rotationEffect(
                                      expandedFacts[fact.key] ? 180 : 0,
                                    ),
                                  ]}
                                />
                              </HStack>
                            </Button>
                            <VStack
                              testID={"plugins.fact." + fact.key + ".content"}
                              alignment="leading"
                              spacing={0}
                              modifiers={[
                                fixedSize({
                                  horizontal: false,
                                  vertical: true,
                                }),
                                frame({
                                  height: expandedFacts[fact.key]
                                    ? (factHeights[fact.key] ?? 0)
                                    : 0,
                                  alignment: "topLeading",
                                }),
                                clipped(),
                                accessibilityHidden(!expandedFacts[fact.key]),
                              ]}
                            >
                              <Text
                                testID={"plugins.fact." + fact.key + ".value"}
                                modifiers={[
                                  font({ textStyle: "subheadline" }),
                                  foregroundStyle(colors.textPrimary),
                                  frame({
                                    maxWidth: Infinity,
                                    alignment: "leading",
                                  }),
                                  fixedSize({
                                    horizontal: false,
                                    vertical: true,
                                  }),
                                  padding({ bottom: spacing.md }),
                                  onGeometryChange(({ height }) => {
                                    if (height > 0)
                                      setFactHeights((current) =>
                                        current[fact.key] === height
                                          ? current
                                          : { ...current, [fact.key]: height },
                                      );
                                  }),
                                ]}
                              >
                                {fact.value}
                              </Text>
                            </VStack>
                          </VStack>
                        ) : (
                          <VStack testID={"plugins.fact." + fact.key}>
                            {label}
                          </VStack>
                        )}
                        {index < facts.length - 1 ? <Divider /> : null}
                      </VStack>
                    );
                  })}
                </VStack>
              </VStack>
            ) : null}
            {showActions ? (
              <Rectangle
                modifiers={[
                  foregroundStyle("clear"),
                  frame({ height: 180 * Math.max(1, fontScale) }),
                  listRowSeparator("hidden"),
                ]}
              />
            ) : null}
          </Section>
        </List>
        {showActions ? (
          <Background>
            <VStack
              alignment="leading"
              spacing={spacing.md}
              modifiers={[
                padding({
                  horizontal: spacing.lg + spacing.xs,
                  top: spacing.xl,
                  bottom: spacing.md,
                }),
              ]}
              testID="plugins.use"
            >
              {button(
                t("plugins.newTask"),
                p.onNewTask,
                true,
                "plugins.newTask",
              )}
              {button(
                t("plugins.chooseTask"),
                p.onChooseTask,
                false,
                "plugins.chooseTask",
              )}
            </VStack>
            <Background.Content>
              <Rectangle
                modifiers={[
                  foregroundStyle({
                    type: "linearGradient",
                    colors: [
                      "transparent",
                      colors.surface,
                      colors.surface,
                      colors.surface,
                    ],
                    startPoint: { x: 0.5, y: 0 },
                    endPoint: { x: 0.5, y: 1 },
                  }),
                ]}
              />
            </Background.Content>
          </Background>
        ) : null}
      </ZStack>
    </Host>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  settings: {
    minHeight: 44,
  },
  icon: { width: 72, height: 72, borderRadius: radius.container },
  fallback: { alignItems: "center", justifyContent: "center" },
});
