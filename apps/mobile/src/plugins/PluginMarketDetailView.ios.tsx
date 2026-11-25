import { useState } from "react";
import {
  Button, Divider, HStack, Host, List, ProgressView, RNHostView, Section, Text, VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel, background, buttonStyle, clipShape, contentShape, disabled, fixedSize, font, foregroundStyle,
  frame, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, padding,
  scrollContentBackground, shapes,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing, useTheme } from "@/theme";
import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { PluginNativeNotice } from "./PluginNotice.ios";
import { PluginMarketIcon } from "./PluginMarketIcon";
import { PluginToolChips } from "./PluginToolChips";
import {
  pluginMarketFacts, pluginMarketOrigin, pluginMarketPublisherKey, pluginMarketSubtitle, pluginMarketTools,
} from "./pluginMarketCatalog";
import type { PluginMarketDetailViewProps } from "./PluginMarketDetailView";

/** iOS market detail: same native List hierarchy as the installed detail, with Install in place of the toggle. */
export function PluginMarketDetailView({ detail, market }: PluginMarketDetailViewProps) {
  const { t } = useTranslation();
  const { mode, colors } = useTheme();
  const { width } = useWindowDimensions();
  const [hostWidth, setHostWidth] = useState(width);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  const primaryStyle = useNativeGlassButtonStyle({ prominent: true });
  const secondaryStyle = useNativeGlassButtonStyle();
  const item = detail.item;
  const state = market.rowState(item);
  const origin = pluginMarketOrigin(item);
  const publisher = pluginMarketPublisherKey(item);
  const tools = pluginMarketTools(detail.detail?.manifest);
  const device = detail.target.deviceName;
  const online = market.online && market.target?.deviceId === detail.target.deviceId;
  const pending = state.kind === "waiting" || state.kind === "installing";
  const contentWidth = Math.max(0, hostWidth - (spacing.lg + spacing.xs) * 2);
  const text = (value: string, style: "subheadline" | "footnote" = "subheadline", id?: string) => (
    <Text testID={id} modifiers={[font({ textStyle: style }), foregroundStyle(colors.textSecondary),
      fixedSize({ horizontal: false, vertical: true })]}>{value}</Text>
  );
  const heading = (value: string) => (
    <Text modifiers={[font({ textStyle: "title3", weight: "semibold" }), foregroundStyle(colors.textPrimary),
      frame({ maxWidth: Infinity, alignment: "leading" })]}>{value}</Text>
  );
  const primaryLabel = state.kind === "unknown" ? t("plugins.management.checkResult")
    : state.kind === "failed" ? t("plugins.retry") : t("plugins.market.install");
  const quiet = [listRowSeparator("hidden")];
  return (
    <Host onLayoutContent={({ nativeEvent }) => setHostWidth(nativeEvent.width)} colorScheme={mode}
      seedColor={colors.textPrimary} style={styles.root} ignoreSafeArea="container">
      <List testID="plugins.market.detail" modifiers={[listStyle("plain"), scrollContentBackground("hidden"),
        background(colors.surface), listRowSeparatorTint(colors.border)]}>
        <Section modifiers={[listRowBackground(colors.surface), listRowInsets({ leading: spacing.lg + spacing.xs,
          trailing: spacing.lg + spacing.xs, top: spacing.md, bottom: spacing.md })]}>
          {!online ? (
            <VStack modifiers={quiet}>
              <PluginNativeNotice icon="offline" testID="plugins.market.detailOffline" title={t("plugins.market.offline", { device })} />
            </VStack>
          ) : null}
          {detail.failed ? (
            <VStack modifiers={quiet}>
              <PluginNativeNotice icon="warning" testID="plugins.market.detailFailed" title={t("plugins.loadFailed")}
                actions={[{ label: t("plugins.retry"), onPress: market.retryDetail, disabled: !online }]} />
            </VStack>
          ) : null}
          {state.kind === "unknown" ? (
            <VStack modifiers={quiet}>
              <PluginNativeNotice icon="warning" testID="plugins.market.resultUnknown" title={t("plugins.notice.title.resultUnknown")}
                detail={t("plugins.market.resultUnknownDetail")} />
            </VStack>
          ) : null}
          <VStack alignment="leading" spacing={spacing.lg} testID="plugins.market.identity"
            modifiers={[...quiet, listRowInsets({ leading: spacing.lg + spacing.xs, trailing: spacing.lg + spacing.xs,
              top: spacing.sm, bottom: spacing.md })]}>
            <HStack spacing={spacing.lg}>
              <VStack modifiers={[frame({ width: 72, height: 72 })]}>
                <RNHostView matchContents><PluginMarketIcon item={item} variant="hero" /></RNHostView>
              </VStack>
              <VStack alignment="leading" spacing={spacing.xs} modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
                <HStack spacing={spacing.sm}>
                  <Text modifiers={[font({ textStyle: "title2", weight: "semibold" }), lineLimit(2)]}>{item.name}</Text>
                  {origin ? (
                    <Text modifiers={[font({ textStyle: "caption2", weight: "semibold" }), foregroundStyle(colors.textSecondary),
                      padding({ horizontal: spacing.sm, vertical: 2 }), background(colors.surfaceChip), clipShape("capsule")]}>
                      {t("plugins.market.filter." + origin)}
                    </Text>
                  ) : null}
                </HStack>
                {text(pluginMarketSubtitle(item, t))}
              </VStack>
            </HStack>
            {pending ? (
              <HStack spacing={spacing.sm} testID="plugins.market.detailProgress"
                modifiers={[frame({ maxWidth: Infinity, minHeight: 44 })]}>
                <ProgressView />
                {text(t(state.kind === "waiting" ? "plugins.market.waiting" : "plugins.market.installing"))}
              </HStack>
            ) : state.kind !== "conflict" && state.kind !== "installed" ? (
              <Button testID="plugins.market.detailInstall"
                onPress={() => { if (state.kind === "unknown") void market.checkResult(); else market.install(item, detail.detail); }}
                modifiers={[...(state.kind === "unknown" ? secondaryStyle : primaryStyle), frame({ maxWidth: Infinity }),
                  disabled(state.kind === "unknown" ? !online : state.kind === "sourceUnverified" || !online || !market.canInstall),
                  accessibilityLabel(state.kind === "idle" ? t("plugins.market.installAria", { name: item.name }) : primaryLabel)]}>
                <Text modifiers={[font({ textStyle: "body", weight: "semibold" }),
                  foregroundStyle(state.kind === "unknown" ? colors.textPrimary : colors.ctaText),
                  frame({ maxWidth: Infinity, minHeight: 36 }), padding({ horizontal: spacing.xs })]}>{primaryLabel}</Text>
              </Button>
            ) : null}
            <HStack modifiers={[frame({ maxWidth: Infinity })]}>
              {text(t("plugins.market.installDestination", { device }), "footnote", "plugins.market.destination")}
            </HStack>
            {state.kind === "failed" ? text(t(state.messageKey), "footnote", "plugins.market.detailError") : null}
            {state.kind === "conflict" ? text(t("plugins.market.conflict"), "footnote", "plugins.market.detailConflict") : null}
            {state.kind === "sourceUnverified"
              ? text(t("plugins.market.sourceUnverified"), "footnote", "plugins.market.detailSourceUnverified") : null}
            {state.kind === "installed" ? text(t("plugins.market.alreadyInstalled"), "footnote", "plugins.market.detailInstalled") : null}
          </VStack>
          {publisher || item.description ? (
            <VStack alignment="leading" spacing={spacing.sm} modifiers={quiet}>
              {publisher ? text(t(publisher)) : null}
              {item.description ? text(item.description) : null}
            </VStack>
          ) : null}
          {detail.loading ? (
            <VStack testID="plugins.market.detailLoading" modifiers={[...quiet, frame({ maxWidth: Infinity, alignment: "center" })]}>
              <ProgressView />
            </VStack>
          ) : null}
          {tools.length ? (
            <VStack alignment="leading" spacing={spacing.md} testID="plugins.market.tools" modifiers={quiet}>
              <HStack spacing={spacing.md}>
                {heading(t("plugins.detail.tools") + " · " + tools.length)}
                {toolsOverflow ? (
                  <Button onPress={() => setToolsExpanded(!toolsExpanded)} modifiers={[buttonStyle("plain"),
                    frame({ minWidth: 44, minHeight: 44 }), contentShape(shapes.rectangle())]}>
                    <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(colors.textSecondary)]}>
                      {t(toolsExpanded ? "plugins.detail.showLess" : "plugins.detail.showAll")}
                    </Text>
                  </Button>
                ) : null}
              </HStack>
              <RNHostView matchContents>
                <PluginToolChips key={item.pluginId} tools={tools} expanded={toolsExpanded} width={contentWidth}
                  onOverflowChange={setToolsOverflow} />
              </RNHostView>
            </VStack>
          ) : null}
          {/* "After you tap Install…" does not apply while Install is unavailable here (the note above says why). */}
          {state.kind !== "sourceUnverified" ? (
            <VStack testID="plugins.market.security" alignment="leading" spacing={spacing.md} modifiers={quiet}>
              {heading(t("plugins.market.securityTitle"))}
              <VStack alignment="leading" modifiers={[frame({ maxWidth: Infinity, alignment: "leading" }),
                padding({ all: spacing.lg }), background(colors.surfaceElevated), clipShape("roundedRectangle", radius.container)]}>
                {text(t("plugins.market.securityBody"), "footnote")}
              </VStack>
            </VStack>
          ) : null}
          <VStack alignment="leading" spacing={spacing.md} testID="plugins.market.facts" modifiers={quiet}>
            {heading(t("plugins.detail.details"))}
            <VStack alignment="leading" spacing={0}>
              {pluginMarketFacts(item, t).map((fact, index, facts) => (
                <VStack key={fact.key} alignment="leading" spacing={0}>
                  <HStack spacing={spacing.lg} modifiers={[frame({ maxWidth: Infinity, minHeight: 50 })]}>
                    <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{fact.title}</Text>
                    <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.textPrimary), lineLimit(1),
                      frame({ maxWidth: Infinity, alignment: "trailing" })]}>{fact.value}</Text>
                  </HStack>
                  {index < facts.length - 1 ? <Divider /> : null}
                </VStack>
              ))}
            </VStack>
          </VStack>
        </Section>
      </List>
    </Host>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
