import {
  Button, HStack, Image, Menu, Picker, ProgressView, RNHostView, Spacer, Text, VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel, buttonBorderShape, buttonStyle, contentShape, disabled, fixedSize, font, foregroundStyle,
  frame, lineLimit, listRowBackground, listRowInsets, listRowSeparator, onAppear, padding, pickerStyle, shapes, tag,
  background, clipShape,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { iconSize, spacing, useTheme } from "@/theme";
import { PluginMarketIcon } from "./PluginMarketIcon";
import { pluginMarketOrigin } from "./pluginMarketCatalog";
import type { ManagedMarketItem } from "./pluginManagementTypes";
import type { PluginMarketRowsProps } from "./PluginMarketRows";

/** Market rows for the native plugin List: header, states, rows and the paging footer. */
export function PluginMarketRows({ market, onConnectComputer }: PluginMarketRowsProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const device = market.target?.deviceName ?? "";
  const rowModifiers = [
    listRowBackground(colors.surface),
    listRowInsets({ leading: spacing.lg + spacing.xs, trailing: spacing.lg + spacing.xs, top: spacing.md, bottom: spacing.md }),
  ];
  const quiet = [...rowModifiers, listRowSeparator("hidden")];
  const note = (value: string, id?: string) => (
    <Text testID={id} modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary),
      fixedSize({ horizontal: false, vertical: true })]}>{value}</Text>
  );
  const menu = (label: string, testID: string, enabled: boolean, picker: ReactNode) => {
    const content = (
      <HStack spacing={spacing.xs} modifiers={[frame({ minHeight: 44 }), contentShape(shapes.rectangle())]}>
        <Text modifiers={[font({ textStyle: "footnote" }), lineLimit(1), foregroundStyle(colors.textSecondary)]}>{label}</Text>
        {enabled ? <Image systemName="chevron.down" size={iconSize.xs} modifiers={[foregroundStyle(colors.textSecondary)]} /> : null}
      </HStack>
    );
    return enabled ? <Menu testID={testID} label={content} modifiers={[accessibilityLabel(label)]}>{picker}</Menu> : content;
  };
  const header = (
    <HStack testID="plugins.market.header" modifiers={[...quiet, frame({ minHeight: 44 }),
      listRowInsets({ leading: spacing.lg + spacing.xs, trailing: spacing.lg + spacing.xs, top: 0, bottom: 0 })]}>
      {market.searching ? (
        <Text modifiers={[font({ textStyle: "footnote", weight: "semibold" }), foregroundStyle(colors.textTertiary)]}>
          {t("plugins.market.title") + (market.total !== undefined ? " " + market.total : "")}
        </Text>
      ) : null}
      {market.searching ? <Spacer /> : null}
      {market.target ? menu(t("plugins.market.installTo", { device }), "plugins.market.computer",
        market.targets.length > 1 && !market.installBusy, (
          <Picker label={t("plugins.computer")} selection={market.target.deviceId}
            onSelectionChange={(id: string) => market.selectDevice(id)} modifiers={[pickerStyle("inline")]}>
            {market.targets.map((host) => <Text key={host.deviceId} modifiers={[tag(host.deviceId)]}>{host.deviceName}</Text>)}
          </Picker>
        )) : null}
      {!market.searching ? <Spacer /> : null}
      {!market.searching && market.status === "ready" ? menu(t("plugins.market.filter." + market.filter), "plugins.market.filter", true, (
        <Picker label={t("plugins.market.filterLabel")} selection={market.filter}
          onSelectionChange={(value: string) => market.setFilter(value as typeof market.filter)} modifiers={[pickerStyle("inline")]}>
          {market.filters.map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {t("plugins.market.filter." + option.value) + (option.count !== undefined ? " " + option.count : "")}
            </Text>
          ))}
        </Picker>
      )) : null}
    </HStack>
  );
  const status = (() => {
    switch (market.status) {
      case "noComputer":
        return (
          <VStack alignment="leading" spacing={spacing.md} modifiers={quiet}>
            {note(t("plugins.noComputer"))}
            <Button label={t("plugins.connectComputer")} onPress={onConnectComputer} />
          </VStack>
        );
      case "offline": return <VStack alignment="leading" modifiers={quiet}>{note(t("plugins.market.offline", { device }), "plugins.market.offline")}</VStack>;
      case "outdated": return <VStack alignment="leading" modifiers={quiet}>{note(t("plugins.market.outdated", { device }), "plugins.market.outdated")}</VStack>;
      case "failed":
        return (
          <VStack alignment="leading" spacing={spacing.md} modifiers={quiet}>
            {note(t("plugins.market.readFailed"), "plugins.market.failed")}
            <Button label={t("plugins.retry")} testID="plugins.market.retry" onPress={() => { void market.refresh(); }} />
          </VStack>
        );
      case "loading": return <ProgressView testID="plugins.market.loading" modifiers={quiet} />;
      default: return null;
    }
  })();
  const trailing = (item: ManagedMarketItem) => {
    const state = market.rowState(item);
    if (state.kind === "waiting" || state.kind === "installing")
      return (
        <HStack spacing={spacing.xs} testID={`plugins.market.progress.${item.pluginId}`}>
          <ProgressView />
          <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), lineLimit(2)]}>
            {t(state.kind === "waiting" ? "plugins.market.waiting" : "plugins.market.installing")}
          </Text>
        </HStack>
      );
    if (state.kind === "conflict") return null;
    const label = state.kind === "unknown" ? t("plugins.management.checkResult")
      : state.kind === "failed" ? t("plugins.retry") : t("plugins.market.install");
    return (
      <Button testID={`plugins.market.install.${item.pluginId}`}
        onPress={() => state.kind === "unknown" ? market.checkResult() : market.install(item)}
        modifiers={[buttonStyle("bordered"), buttonBorderShape("capsule"), frame({ minHeight: 44 }),
          disabled(state.kind === "unknown" ? !market.online : !market.canInstall),
          accessibilityLabel(state.kind === "idle" ? t("plugins.market.installAria", { name: item.name }) : label)]}>
        <Text modifiers={[font({ textStyle: "subheadline", weight: "medium" }), foregroundStyle(colors.textPrimary)]}>{label}</Text>
      </Button>
    );
  };
  const row = (item: ManagedMarketItem, first: boolean) => {
    const state = market.rowState(item);
    const origin = pluginMarketOrigin(item);
    const line = state.kind === "failed" ? t(state.messageKey)
      : state.kind === "conflict" ? t("plugins.market.conflict")
        : state.kind === "unknown" ? t("plugins.market.resultUnknownDetail") : item.description ?? "";
    return (
      <HStack key={item.pluginId} spacing={spacing.md}
        modifiers={[...rowModifiers, ...(first ? [listRowSeparator("hidden", "top")] : [])]}>
        <Button testID={`plugins.market.row.${item.pluginId}`} onPress={() => market.openDetail(item)}
          modifiers={[buttonStyle("plain"), frame({ maxWidth: Infinity }),
            accessibilityLabel(t("plugins.detailsFor", { name: item.name }))]}>
          <HStack spacing={spacing.md} modifiers={[frame({ maxWidth: Infinity, minHeight: 54, alignment: "leading" }),
            contentShape(shapes.rectangle())]}>
            <RNHostView matchContents><PluginMarketIcon item={item} variant="row" /></RNHostView>
            <VStack alignment="leading" spacing={3} modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
              <HStack spacing={6}>
                <Text modifiers={[font({ textStyle: "body" }), lineLimit(1)]}>{item.name}</Text>
                {origin ? (
                  <Text modifiers={[font({ textStyle: "caption2", weight: "semibold" }), foregroundStyle(colors.textSecondary),
                    padding({ horizontal: spacing.sm, vertical: 2 }), background(colors.surfaceChip), clipShape("capsule")]}>
                    {t("plugins.market.filter." + origin)}
                  </Text>
                ) : null}
              </HStack>
              {line ? (
                <Text modifiers={[font({ textStyle: state.kind === "idle" ? "subheadline" : "footnote" }),
                  foregroundStyle(colors.textSecondary), lineLimit(state.kind === "idle" ? 2 : 3)]}>{line}</Text>
              ) : null}
            </VStack>
          </HStack>
        </Button>
        {trailing(item)}
      </HStack>
    );
  };
  const ready = market.status === "ready";
  return (
    <>
      {header}
      {status}
      {ready && market.notices.unavailable ? <VStack alignment="leading" modifiers={quiet}>{note(t("plugins.market.unavailable"))}</VStack> : null}
      {ready && market.notices.organizationKey ? <VStack alignment="leading" modifiers={quiet}>{note(t(market.notices.organizationKey))}</VStack> : null}
      {ready && market.notices.unavailableCustomSources.length ? (
        <VStack alignment="leading" modifiers={quiet}>
          {note(t("plugins.market.customSourcesUnavailable", { names: market.notices.unavailableCustomSources.join(", ") }))}
        </VStack>
      ) : null}
      {ready ? market.items.map((item, index) => row(item, index === 0)) : null}
      {ready && !market.items.length && !market.hasMore && !market.loadingMore && !market.notices.unavailable
        ? <VStack alignment="leading" modifiers={quiet}>{note(t("plugins.noResults"), "plugins.market.empty")}</VStack> : null}
      {ready && (market.hasMore || market.loadingMore || market.refreshing) ? (
        // A new key per page length re-arms onAppear when the footer stays on screen.
        <HStack key={`more-${market.items.length}`} modifiers={[...quiet, frame({ maxWidth: Infinity, minHeight: 44 }),
          onAppear(market.loadMore)]}>
          <Spacer />
          {market.loadingMore || market.refreshing ? <ProgressView /> : (
            <Button testID="plugins.market.loadMore" label={t("plugins.market.loadMore")} onPress={market.loadMore} />
          )}
          <Spacer />
        </HStack>
      ) : null}
      {ready && !market.hasMore && !market.loadingMore && market.items.length && market.total !== undefined ? (
        <HStack modifiers={quiet}>
          <Spacer />
          <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle(colors.textTertiary)]}>
            {t("plugins.market.allLoaded", { count: market.total })}
          </Text>
          <Spacer />
        </HStack>
      ) : null}
    </>
  );
}
