import {
  Host,
  Button,
  Circle,
  HStack,
  Image,
  List,
  Menu,
  Picker,
  ProgressView,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  contentShape,
  font,
  fixedSize,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparatorTint,
  listRowSeparator,
  listStyle,
  pickerStyle,
  refreshable,
  scrollContentBackground,
  scrollDismissesKeyboard,
  shapes,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { Image as RNImage, StyleSheet, View, useWindowDimensions } from "react-native";
import { Puzzle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { resolveRemoteText } from "@cindy/device-link";
import { ComposerNativeRow } from "@/session/ComposerNativeRow";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import type { PluginDirectoryViewProps } from "./PluginDirectoryView";
import { PluginMarketRows } from "./PluginMarketRows";
import { PluginNativeNotice } from "./PluginNotice.ios";

export function PluginDirectoryView(p: PluginDirectoryViewProps) {
  const { t, i18n } = useTranslation();
  const { mode, colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const listFailed = p.error;
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const row = (
    item: PluginDirectoryViewProps["items"][number],
    first = false,
  ) => {
    const uri = item.item.display.avatar?.value;
    const preview = item.item.display.preview ?? item.item.display.subtitle;
    const subtitle = [
      !p.isOnline(item) ? t("plugins.notConnected") : "",
      p.targets.length > 1 ? item.host.deviceName : "",
      preview ? text(preview) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <VStack
        key={item.key}
        modifiers={[
          ...sectionModifiers,
          ...(first ? [listRowSeparator("hidden", "top")] : []),
        ]}
      >
        <ComposerNativeRow
          key={item.key}
          testID={`plugins.row.${item.item.ref.id}`}
          title={text(item.item.display.title)}
          subtitle={subtitle}
          subtitleContent={
            subtitle ? (
              <Text
                modifiers={[
                  font({ textStyle: "subheadline" }),
                  foregroundStyle(colors.textSecondary),
                  lineLimit(1),
                ]}
              >
                {subtitle}
              </Text>
            ) : undefined
          }
          selected={p.selectedKey === item.key}
          titleAccessory={
            item.item.display.badges?.length ? (
              <Circle
                modifiers={[
                  frame({ width: 6, height: 6 }),
                  foregroundStyle(colors.statusDone),
                  accessibilityLabel(t("plugins.unread")),
                ]}
              />
            ) : undefined
          }
          leading={
            uri &&
            /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(uri) ? (
              <RNHostView matchContents>
                <RNImage source={{ uri }} style={styles.icon} />
              </RNHostView>
            ) : (
              <RNHostView matchContents>
                <View
                  style={[
                    styles.icon,
                    styles.fallback,
                    { backgroundColor: colors.surfaceChip },
                  ]}
                >
                  <Puzzle size={iconSize.lg} color={colors.textSecondary} />
                </View>
              </RNHostView>
            )
          }
          onPress={() => p.onOpen(item)}
          onOptions={() => p.onDetail(item)}
          optionsLabel={t("plugins.detailsFor", {
            name: text(item.item.display.title),
          })}
          optionsIcon={
            <Image
              systemName="info.circle"
              size={iconSize.lg}
              modifiers={[foregroundStyle(colors.textSecondary)]}
            />
          }
        />
      </VStack>
    );
  };
  const sectionModifiers = [
    listRowBackground(colors.surface),
    listRowInsets({
      leading: spacing.lg + spacing.xs,
      trailing: spacing.lg + spacing.xs,
      top: spacing.md,
      bottom: spacing.md,
    }),
  ];
  const installedHeader = (
    <HStack
      testID="plugins.installedHeader"
      modifiers={[
        listRowBackground(colors.surface),
        listRowSeparator("hidden"),
        fixedSize({ horizontal: false, vertical: true }),
        frame({ height: 44 }),
        listRowInsets({
          leading: spacing.lg + spacing.xs,
          trailing: spacing.lg + spacing.xs,
          top: 0,
          bottom: 0,
        }),
      ]}
    >
      <Text
        modifiers={[
          font({ textStyle: "footnote", weight: "semibold" }),
          foregroundStyle(colors.textTertiary),
        ]}
      >
        {t("plugins.installed")}
      </Text>
      <Spacer />
      <Menu
        testID="plugins.computer"
        label={
          <HStack
            spacing={spacing.xs}
            modifiers={[
              frame({ minHeight: 44 }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Text
              modifiers={[
                font({ textStyle: "footnote" }),
                lineLimit(1),
                foregroundStyle(colors.textSecondary),
              ]}
            >
              {p.targets.find((host) => host.deviceId === p.deviceId)
                ?.deviceName ?? t("plugins.allComputers")}
            </Text>
            <Image
              systemName="chevron.down"
              size={iconSize.xs}
              modifiers={[foregroundStyle(colors.textSecondary)]}
            />
          </HStack>
        }
        modifiers={[accessibilityLabel(t("plugins.computer"))]}
      >
        <Picker
          label={t("plugins.computer")}
          selection={p.deviceId}
          onSelectionChange={p.onDeviceChange}
          modifiers={[pickerStyle("inline")]}
          testID="plugins.computer.options"
        >
          <Text modifiers={[tag("")]}>{t("plugins.allComputers")}</Text>
          {p.targets.map((host) => (
            <Text key={host.deviceId} modifiers={[tag(host.deviceId)]}>
              {host.deviceName}
            </Text>
          ))}
        </Picker>
      </Menu>
    </HStack>
  );
  const searching = !!p.query.trim();
  const showInstalled = searching || p.segment === "installed";
  const showMarket = searching || p.segment === "market";
  const installedRows = (
    <>
      {installedHeader}
      {p.loading && !p.items.length ? (
        <ProgressView
          modifiers={[...sectionModifiers, listRowSeparator("hidden")]}
        />
      ) : null}
      {p.items.map((item, index) => row(item, index === 0))}
      {!p.loading && !listFailed && !p.items.length ? (
        <VStack
          alignment="leading"
          spacing={spacing.md}
          modifiers={[...sectionModifiers, listRowSeparator("hidden")]}
        >
          <Text>
            {t(
              p.query
                ? "plugins.noResults"
                : p.targets.length
                  ? "plugins.noPlugins"
                  : "plugins.noComputer",
            )}
          </Text>
          {!p.targets.length ? (
            <Button
              label={t("plugins.connectComputer")}
              onPress={p.onConnectComputer}
            />
          ) : null}
        </VStack>
      ) : null}
      {listFailed ? (
        <VStack
          alignment="leading"
          spacing={spacing.md}
          modifiers={[...sectionModifiers, listRowSeparator("hidden")]}
        >
          <Text
            modifiers={[
              font({ textStyle: "footnote" }),
              foregroundStyle(colors.textSecondary),
            ]}
          >
            {t(
              p.items.length
                ? "plugins.listUnavailable"
                : "plugins.listLoadFailed",
            )}
          </Text>
          {!p.items.length && !p.loading ? (
            <Button
              label={t("plugins.detail.action.retry")}
              onPress={() => void p.onRefresh()}
              testID="plugins.retryList"
            />
          ) : null}
        </VStack>
      ) : null}
    </>
  );
  return (
    <Host
      // A new text size lays the list out again from the top inset it has now (dispatcher P-2), not the one measured at
      // the old size (the search bar above it grows with the text).
      key={`text-${Math.round(fontScale * 100)}`}
      colorScheme={mode}
      style={styles.root}
      seedColor={colors.textPrimary}
      ignoreSafeArea="container"
    >
      <List
        modifiers={[
          // Ordinary title rows scroll with the list and have no section boundary.
          listStyle("plain"),
          scrollContentBackground("hidden"),
          background(colors.surface),
          listRowSeparatorTint(colors.border),
          scrollDismissesKeyboard("interactively"),
          refreshable(async () => {
            await Promise.all([
              showInstalled ? p.onRefresh() : undefined,
              showMarket ? p.market.refresh() : undefined,
            ]);
          }),
        ]}
        testID="plugins.list"
      >
        {p.pageNotice ? (
          <VStack modifiers={[listRowBackground(colors.surface), listRowSeparator("hidden"), listRowInsets({
            leading: spacing.lg + spacing.xs, trailing: spacing.lg + spacing.xs, top: spacing.sm, bottom: 0 })]}>
            <PluginNativeNotice {...p.pageNotice} />
          </VStack>
        ) : null}
        {!searching ? (
          // Native segmented control as an ordinary list row, like the computer range row.
          <Picker
            testID="plugins.segment"
            label={t("plugins.market.segmentsLabel")}
            selection={p.segment}
            onSelectionChange={(value: string) =>
              p.onSegmentChange(value === "market" ? "market" : "installed")
            }
            modifiers={[
              pickerStyle("segmented"),
              accessibilityLabel(t("plugins.market.segmentsLabel")),
              listRowBackground(colors.surface),
              listRowSeparator("hidden"),
              listRowInsets({
                leading: spacing.lg + spacing.xs,
                trailing: spacing.lg + spacing.xs,
                top: spacing.sm,
                bottom: spacing.sm,
              }),
            ]}
          >
            <Text modifiers={[tag("installed")]}>{t("plugins.installed")}</Text>
            <Text modifiers={[tag("market")]}>{t("plugins.market.title")}</Text>
          </Picker>
        ) : null}
        {showInstalled ? installedRows : null}
        {showMarket ? (
          <PluginMarketRows
            market={p.market}
            onConnectComputer={p.onConnectComputer}
          />
        ) : null}
      </List>
    </Host>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  icon: { width: 54, height: 54, borderRadius: radius.container },
  fallback: { alignItems: "center", justifyContent: "center" },
});
