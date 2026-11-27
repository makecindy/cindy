import type { TextInputInstance } from 'react-native';
import { ModelSpeedIcon } from "./ModelSpeedIcon";
import { ModelQuotaBar } from "./ModelQuotaBar";
import { ErrorNotice } from "@/components/ErrorNotice";
/**
 * 统一模型选择器的 Android / 兼容呈现(iOS 见 UnifiedModelPickerView.ios.tsx)。
 *
 * 交互与 iOS 同构:顶部搜索(跨来源)+ 右侧「来源」入口进二级来源页(带周配额进度条);
 * 列表按 收藏 → 推荐(仅已有任务)→ 各来源 分组(分组与顺序由 UnifiedModelPickerSheet 产出);
 * 行内设置入口进单模型设置页:Harness 二级页选完自动回设置主页、推理强度下拉
 * (NativePullDownMenu,包里没有 MenuView 时退回行内展开)、Fast 开关、收藏 / 恢复推荐独立行。
 * 外观保持 Android:SheetModal + SheetSurface 单 Modal 内导航、RN 自绘分组行与主题 token。
 */
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  ChevronRight,
  ChevronsUpDown,
  Check,
  LayoutGrid,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  X,
  Zap,
} from "lucide-react-native";
import { Pressable, FlatList, Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { MobileAgentMark } from "@/components/MobileAgentMark";
import {
  NativePullDownMenu,
  NativeSwitch,
  usesNativePullDownMenu,
} from "@/platform/chrome";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { groupSourceFilters } from "./remoteSourceFilters";
import { SheetModal } from "./SheetModal";
import { SheetSurface } from "./SheetSurface";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "./contextSheetModel";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type {
  UnifiedMobileModelGroupRow,
  UnifiedMobilePickerViewProps,
  UnifiedMobilePluginEngineGroup,
  UnifiedMobilePluginEngineRow,
  UnifiedMobileRow,
} from "./UnifiedModelPickerSheet";
import { PluginEngineMark } from "./PluginEngineMark";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";

type Page = "sources" | "harness" | null;

/** 分组:可选小标题 + 行间 hairline(与 ContextSheetGroup 的安卓分组行同一套节奏)。 */
function Group({
  title,
  heading,
  children,
  testID,
}: {
  title?: string;
  heading?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const rows = flatten(children);
  return (
    <View style={styles.group} testID={testID}>
      {heading ?? (title ? <Text style={styles.groupLabel}>{title}</Text> : null)}
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={styles.separator} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

function flatten(children: ReactNode): ReactNode[] {
  if (
    children === null ||
    children === undefined ||
    typeof children === "boolean"
  )
    return [];
  if (Array.isArray(children)) return children.flatMap(flatten);
  return [children];
}

/** 设置页 / 来源页的单行:leading + 标题(+副标题)+ 右侧取值 / 勾号 / chevron。 */
function Row({
  title,
  subtitle,
  subtitleLines = 1,
  notice,
  value,
  leading,
  trailing,
  selected,
  disabled,
  onPress,
  accessibilityLabel,
  testID,
}: {
  title: string;
  subtitle?: string | null;
  subtitleLines?: number;
  notice?: string;
  value?: string | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={
        accessibilityLabel ??
        [title, subtitle, notice, value].filter(Boolean).join(", ")
      }
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.rowDisabled,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={subtitleLines} style={styles.rowSubtitle}>
            {subtitle}
          </Text>
        ) : null}
        {notice ? <Text style={styles.rowNotice}>{notice}</Text> : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={styles.rowValue}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {selected ? (
        <Check
          color={colors.textPrimary}
          size={iconSize.lg}
          strokeWidth={iconStroke.medium}
        />
      ) : null}
    </Pressable>
  );
}

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        screenHeight: height,
        safeAreaTopInset: insets.top,
      }),
    [height, insets.top],
  );
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  const [page, setPage] = useState<Page>(null);
  const [effortExpanded, setEffortExpanded] = useState(false);
  const searchRef = useRef<TextInputInstance>(null);
  const modelListRef = useRef<FlatList>(null);
  const pluginEngineGroupList = p.pluginEngines?.groups;
  const modelGroupList = p.modelGroups;
  const favoritesGroup = useMemo(
    () => p.groups.find((group) => group.key === "favorites"),
    [p.groups],
  );
  const otherGroups = useMemo(
    () => p.groups.filter((group) => group.key !== "favorites"),
    [p.groups],
  );
  const modelItems = useMemo(
    () => [
      // 收藏区恒置顶(混排内置模型与插件引擎收藏)。
      ...(favoritesGroup
        ? [
            { kind: "header" as const, key: `header:${favoritesGroup.key}`, group: favoritesGroup },
            ...(favoritesGroup.items ?? favoritesGroup.rows.map((row) => ({ kind: "model" as const, row }))).map(
              (item, index) =>
                item.kind === "pluginEngine"
                  ? {
                      kind: "pluginModel" as const,
                      key: `${favoritesGroup.key}:${item.row.key}`,
                      row: item.row,
                      separator: index > 0,
                    }
                  : {
                      kind: "model" as const,
                      key: `${favoritesGroup.key}:${item.row.key}`,
                      row: item.row,
                      separator: index > 0,
                    },
            ),
          ]
        : []),
      // 智能路由持续托管横幅(存在时置顶在路由区) + 模型组(被控电脑上的)列在插件引擎与内置模型之前。
      ...(modelGroupList?.managedMeta
        ? [{ kind: "modelGroupManaged" as const, key: "model-group:managed", managedMeta: modelGroupList.managedMeta }]
        : []),
      ...(modelGroupList?.rows.length
        ? [
            { kind: "modelGroupHeader" as const, key: "header:model-groups", title: modelGroupList.title },
            ...modelGroupList.rows.map((row, index) => ({
              kind: "modelGroup" as const,
              key: `model-group:${row.id}`,
              row,
              separator: index > 0,
            })),
          ]
        : []),
      // 插件引擎分组列在内置模型之前。
      ...(pluginEngineGroupList ?? []).flatMap((group) => [
        { kind: "pluginHeader" as const, key: `header:${group.key}`, group },
        ...group.rows.map((row, index) => ({
          kind: "pluginModel" as const,
          key: `${group.key}:${row.key}`,
          row,
          separator: index > 0,
        })),
      ]),
      ...otherGroups.flatMap((group) => [
        { kind: "header" as const, key: `header:${group.key}`, group },
        ...group.rows.map((row, index) => ({
          kind: "model" as const,
          key: `${group.key}:${row.key}`,
          row,
          separator: index > 0,
        })),
      ]),
    ],
    [favoritesGroup, otherGroups, pluginEngineGroupList, modelGroupList],
  );
  useEffect(() => {
    modelListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [p.query, p.filter]);
  const initialScrollPending = useRef(true);
  const initialScrollAttempts = useRef(0);
  const initialScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIndex = modelItems.findIndex(item =>
    (item.kind === "model" || item.kind === "pluginModel") && item.row.selected);
  const cancelInitialScroll = () => {
    initialScrollPending.current = false;
    if (initialScrollTimer.current !== null) clearTimeout(initialScrollTimer.current);
    initialScrollTimer.current = null;
  };
  const scrollToSelected = () => {
    if (!p.visible || !initialScrollPending.current || selectedIndex < 0 || !modelListRef.current) return;
    initialScrollPending.current = false;
    modelListRef.current.scrollToIndex({ index: selectedIndex, viewPosition: 0.5, animated: false });
  };
  useEffect(() => {
    initialScrollPending.current = true;
    initialScrollAttempts.current = 0;
    return cancelInitialScroll;
  }, [p.visible]);
  useEffect(() => {
    // The first frame lets the sheet and any freshly loaded model rows mount.
    const frame = requestAnimationFrame(scrollToSelected);
    return () => {
      cancelAnimationFrame(frame);
      if (initialScrollTimer.current !== null) clearTimeout(initialScrollTimer.current);
      initialScrollTimer.current = null;
    };
  }, [p.visible, selectedIndex, p.filter]);
  // 与 iOS 同口径:重新打开或切换设置对象都回到主页。
  useEffect(() => {
    setPage(null);
    setEffortExpanded(false);
  }, [p.visible, p.options?.row.key, p.pluginEngineOptions?.row.key]);
  useEffect(() => {
    if (p.visible) setSnap("half");
  }, [p.visible]);

  const icon = (Icon: typeof Star, filled = false) => (
    <Icon
      color={colors.textSecondary}
      fill={filled ? colors.textSecondary : "none"}
      size={iconSize.action}
      strokeWidth={iconStroke.regular}
    />
  );
  const level = (id: string) =>
    t(`models.options.effortLevels.${id}`, { defaultValue: id });
  const options = p.options;
  const pluginOptions = p.pluginEngineOptions;
  const showSecondary = !!options || !!pluginOptions || !!page;
  useEffect(() => {
    if (showSecondary) searchRef.current?.blur();
  }, [showSecondary]);
  const isFavorite = options?.isFavorite ?? !!options?.row.favorite;
  const config = options?.row.config;
  const back = page ? () => setPage(null) : p.onBack;
  const currentFilter = p.filters.find((item) => item.id === p.filter);
  const title =
    page === "sources"
      ? t("models.unified.source")
      : page === "harness"
        ? t("models.unified.harness")
        : p.title;

  const filterMark = (filter = currentFilter, selected = false) =>
    !filter || filter.id === "all" ? (
      icon(LayoutGrid)
    ) : filter.id === "favorites" ? (
      icon(Star, selected || p.filter === "favorites")
    ) : filter.pluginEngineMark ? (
      <PluginEngineMark
        iconDataUrl={filter.pluginEngineMark.iconDataUrl}
        remote={filter.remote != null}
        size={iconSize.action}
      />
    ) : filter.providerMark ? (
      <MobileProviderMark
        {...filter.providerMark}
        remote={filter.remote != null}
      />
    ) : (
      icon(LayoutGrid)
    );

  const searchHeader = (
    <View style={styles.searchRow}>
      <View style={styles.searchField}>
        <Search
          color={colors.textSecondary}
          size={iconSize.md}
          strokeWidth={iconStroke.regular}
        />
        <TextInput
          accessibilityLabel={t("models.picker.searchAccessibility")}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => { cancelInitialScroll(); p.onQuery(value); }}
          // Android adjustResize:聚焦搜索时吸到 full,边输边看列表(与旧版模型浮窗同口径)。
          onFocus={() => setSnap("full")}
          placeholder={t("models.picker.searchPlaceholder")}
          placeholderTextColor={colors.textPlaceholder}
          ref={searchRef}
          style={styles.searchInput}
          testID={`${p.testID}.search`}
          value={p.query}
        />
        {p.query ? (
          <Pressable
            accessibilityLabel={t("devices.detail.search.clearA11y")}
            accessibilityRole="button"
            hitSlop={4}
            onPress={() => p.onQuery("")}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && styles.pressed,
            ]}
            testID={`${p.testID}.search.clear`}
          >
            <X
              color={colors.textTertiary}
              size={iconSize.md}
              strokeWidth={iconStroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={t("models.unified.source")}
        accessibilityRole="button"
        accessibilityValue={{ text: currentFilter?.label ?? "" }}
        onPress={() => setPage("sources")}
        style={({ pressed }) => [
          styles.sourceButton,
          pressed && styles.pressed,
        ]}
        testID={`${p.testID}.filter`}
      >
        <View style={styles.markBox}>{filterMark()}</View>
        <Text numberOfLines={1} style={styles.sourceLabel}>
          {currentFilter?.label ?? ""}
        </Text>
        <ChevronRight
          color={colors.textTertiary}
          size={iconSize.sm}
          strokeWidth={iconStroke.regular}
        />
      </Pressable>
    </View>
  );

  const sourceRow = (item: (typeof p.filters)[number]) => (
    <Row
      key={item.id}
      leading={
        <View style={styles.sourceLeading}>
          {filterMark(
            item,
            item.id === "favorites" && p.filter === "favorites",
          )}
          {typeof item.quota?.remaining === 'number' ? (
            <ModelQuotaBar
              label={item.quota.label}
              remaining={item.quota.remaining}
              testID={`${p.testID}.source.${item.id}.quota`}
            />
          ) : null}
          {item.quota?.members?.map((member, index) => typeof member.remaining === 'number' ?
            <ModelQuotaBar key={index} label={member.label} remaining={member.remaining}
              testID={`${p.testID}.source.${item.id}.quota.${index}`} /> : null)}
        </View>
      }
      onPress={() => {
        cancelInitialScroll();
        p.onFilter(item.id);
        setPage(null);
      }}
      selected={p.filter === item.id}
      subtitle={item.quota?.label}
      subtitleLines={item.quota?.members?.length ? 0 : 1}
      notice={item.sourceUnavailableReason}
      testID={`${p.testID}.source.${item.id}`}
      title={item.remote?.providerLabel ?? item.label}
    />
  );
  // 其他电脑的供应商:每台电脑单独一块,块标题是电脑名。
  const sourceGroups = groupSourceFilters(p.filters);
  const sourcesPage = (
    <>
      <Group testID={`${p.testID}.sources`}>
        {sourceGroups.local.map(sourceRow)}
      </Group>
      {sourceGroups.devices.map((device) => (
        <Group
          key={device.deviceId}
          testID={`${p.testID}.sources.device.${device.deviceId}`}
          title={device.name}
        >
          {device.filters.map(sourceRow)}
        </Group>
      ))}
    </>
  );

  const harnessPage =
    options && config ? (
      <Group testID={`${p.testID}.harnessPage`}>
        {options.agents.map((agent) => (
          <Row
            disabled={p.busy}
            key={agent}
            leading={
              <MobileAgentMark
                agentKind={agent}
                color={colors.textSecondary}
                size={iconSize.action}
              />
            }
            onPress={() => {
              const cap = options.row.entry.capabilities[agent];
              if (!cap) return;
              options.onChange({
                ...config,
                agent,
                modelId: cap.wireModelId,
                effort: cap.defaultEffort ?? cap.efforts[0] ?? "",
                fast: false,
              });
              setPage(null);
            }}
            selected={config.agent === agent}
            testID={`${p.testID}.harness.${agent}`}
            title={mobileAgentLabel(agent)}
          />
        ))}
      </Group>
    ) : null;

  const efforts =
    options && config
      ? (options.row.entry.capabilities[config.agent]?.efforts ?? [])
      : [];
  const nativeMenu = usesNativePullDownMenu();
  const effortRow =
    options && config && efforts.length ? (
      <View>
        <NativePullDownMenu
          disabled={p.busy}
          actions={efforts.map((effort) => ({
            id: effort,
            title: level(effort),
            state: effort === config.effort ? "on" : "off",
            disabled: p.busy,
          }))}
          onAction={(id) => {
            const effort = efforts.find((item) => item === id);
            if (p.busy || !effort) return;
            options.onChange({ ...config, effort });
          }}
          testID={`${p.testID}.effortMenu`}
        >
          <Row
            accessibilityLabel={`${t("models.options.reasoningEffort")}, ${level(config.effort)}`}
            disabled={p.busy}
            onPress={() => {
              if (!nativeMenu) setEffortExpanded((open) => !open);
            }}
            leading={icon(Brain)}
            testID={`${p.testID}.effort`}
            title={t("models.options.reasoningEffort")}
            trailing={
              <ChevronsUpDown
                color={colors.textTertiary}
                size={iconSize.sm}
                strokeWidth={iconStroke.regular}
              />
            }
            value={config.effort ? level(config.effort) : null}
          />
        </NativePullDownMenu>
        {!nativeMenu && effortExpanded
          ? efforts.map((effort) => (
              <Row
                disabled={p.busy}
                key={effort}
                onPress={() => {
                  options.onChange({ ...config, effort });
                  setEffortExpanded(false);
                }}
                selected={effort === config.effort}
                testID={`${p.testID}.effort.${effort}`}
                title={level(effort)}
              />
            ))
          : null}
      </View>
    ) : null;

  const settingsPage =
    options && config ? (
      <>
        {options.context ? (
          <Text style={styles.footnote} testID={`${p.testID}.context`}>
            {options.context}
          </Text>
        ) : null}
        {options.onEditFavorite ? (
          <Group>
            <Row
              title={t("models.unified.editFavorite")}
              onPress={options.onEditFavorite}
              disabled={p.busy || options.favoritesDisabled}
              testID={`${p.testID}.editFavorite`}
            />
          </Group>
        ) : null}
        {options.editingFavorite ? (
          <Text style={styles.footnote}>
            {t("models.unified.editFavoriteHint")}
          </Text>
        ) : null}
        <Group>
          <Row
            disabled={p.busy}
            leading={
              <MobileAgentMark
                agentKind={config.agent}
                color={colors.textSecondary}
                size={iconSize.action}
              />
            }
            onPress={() => setPage("harness")}
            testID={`${p.testID}.harness`}
            title={t("models.unified.harness")}
            trailing={
              <ChevronRight
                color={colors.textTertiary}
                size={iconSize.md}
                strokeWidth={iconStroke.regular}
              />
            }
            value={mobileAgentLabel(config.agent)}
          />
          {effortRow}
          {options.fastCapable &&
          options.row.entry.capabilities[config.agent]
            ?.supportsUltrafastMode ? (
            <>
              {(["standard", "fast", "ultrafast"] as const).map((speed) => {
                const value =
                  speed === "ultrafast" ? "ultrafast" : speed === "fast";
                return (
                  <Row
                    key={speed}
                    disabled={p.busy}
                    title={t(`models.options.speed.${speed}`)}
                    onPress={() => options.onChange({ ...config, fast: value })}
                    trailing={
                      config.fast === value ? (
                        <Check
                          size={iconSize.action}
                          color={colors.textPrimary}
                        />
                      ) : null
                    }
                  />
                );
              })}
            </>
          ) : options.fastCapable ? (
            <View style={styles.row}>
              <View style={styles.leading}>{icon(Zap, true)}</View>
              <Text numberOfLines={1} style={[styles.rowTitle, styles.rowMain]}>
                {t("models.options.fastMode")}
              </Text>
              <NativeSwitch
                accessibilityLabel={t("models.options.fastMode")}
                disabled={p.busy}
                onValueChange={(fast) => options.onChange({ ...config, fast })}
                seedColor={colors.cta}
                testID={`${p.testID}.fast`}
                value={!!config.fast}
              />
            </View>
          ) : null}
        </Group>
        {!options.editingFavorite ? (
          <>
            <Text style={styles.footnote} testID={`${p.testID}.configState`}>
              {t(
                options.canReset
                  ? "models.unified.customized"
                  : "models.unified.usingRecommended",
              )}
            </Text>
            {options.canReset ? (
              <Group>
                <Row
                  title={t("models.unified.restoreRecommended")}
                  onPress={options.onReset}
                  disabled={p.busy}
                  testID={`${p.testID}.reset`}
                />
              </Group>
            ) : null}
            <Text style={styles.footnote}>
              {t("models.unified.resetScopeHint")}
            </Text>
          </>
        ) : null}
        {options.price ? (
          <Text
            style={[styles.footnote, styles.price]}
            testID={`${p.testID}.price`}
          >
            {options.price}
          </Text>
        ) : null}
        {options.editingFavorite ? (
          <Group>
            <Row
              title={t("models.unified.saveFavorite")}
              onPress={() => options.onSaveEdit?.()}
              disabled={p.busy || options.favoritesDisabled}
              testID={`${p.testID}.saveFavorite`}
            />
            <Row
              title={t("models.unified.cancelEdit")}
              onPress={() => options.onCancelEdit?.()}
              disabled={p.busy}
              testID={`${p.testID}.cancelEdit`}
            />
          </Group>
        ) : (
          <>
            <Group title={t("models.unified.currentConfiguration")}>
              <Row
                disabled={p.busy || options.favoritesDisabled}
                leading={icon(Star, isFavorite)}
                onPress={options.onFavorite}
                testID={`${p.testID}.favorite`}
                title={t(
                  isFavorite
                    ? "models.unified.savedConfiguration"
                    : "models.unified.favoriteConfiguration",
                )}
                subtitle={options.configurationSummary}
              />
            </Group>
            <Text style={styles.footnote}>
              {t(
                isFavorite
                  ? "models.unified.removeFavoriteHint"
                  : "models.unified.saveFavoriteHint",
              )}
            </Text>
          </>
        )}
        {options.notice ? (
          <Text
            style={styles.footnote}
            accessibilityLiveRegion="polite"
            testID={`${p.testID}.notice`}
          >
            {options.notice}
          </Text>
        ) : null}
      </>
    ) : null;

  const pluginEngineSettingsPage = pluginOptions ? (
    <>
      {pluginOptions.context ? (
        <Text style={styles.footnote} testID={`${p.testID}.context`}>
          {pluginOptions.context}
        </Text>
      ) : null}
      {pluginOptions.onEditFavorite ? (
        <Group>
          <Row
            title={t("models.unified.editFavorite")}
            onPress={pluginOptions.onEditFavorite}
            disabled={p.busy || pluginOptions.favoritesDisabled}
            testID={`${p.testID}.editFavorite`}
          />
        </Group>
      ) : null}
      {pluginOptions.editingFavorite ? (
        <Text style={styles.footnote}>
          {t("models.unified.editFavoriteHint")}
        </Text>
      ) : null}
      {pluginOptions.efforts.length > 1 ? (
        <Group>
          <View>
            <NativePullDownMenu
              disabled={p.busy}
              actions={pluginOptions.efforts.map((effort) => ({
                id: effort,
                title: level(effort),
                state: effort === pluginOptions.effort ? "on" : "off",
                disabled: p.busy,
              }))}
              onAction={(id) => {
                const next = pluginOptions.efforts.find((item) => item === id);
                if (!p.busy && next) pluginOptions.onChangeEffort(next);
              }}
              testID={`${p.testID}.effortMenu`}
            >
              <Row
                accessibilityLabel={`${t("models.options.reasoningEffort")}, ${pluginOptions.effort ? level(pluginOptions.effort) : ""}`}
                disabled={p.busy}
                onPress={() => {
                  if (!nativeMenu) setEffortExpanded((open) => !open);
                }}
                leading={icon(Brain)}
                testID={`${p.testID}.effort`}
                title={t("models.options.reasoningEffort")}
                trailing={
                  <ChevronsUpDown
                    color={colors.textTertiary}
                    size={iconSize.sm}
                    strokeWidth={iconStroke.regular}
                  />
                }
                value={pluginOptions.effort ? level(pluginOptions.effort) : null}
              />
            </NativePullDownMenu>
            {!nativeMenu && effortExpanded
              ? pluginOptions.efforts.map((effort) => (
                  <Row
                    disabled={p.busy}
                    key={effort}
                    onPress={() => {
                      pluginOptions.onChangeEffort(effort);
                      setEffortExpanded(false);
                    }}
                    selected={effort === pluginOptions.effort}
                    testID={`${p.testID}.effort.${effort}`}
                    title={level(effort)}
                  />
                ))
              : null}
          </View>
        </Group>
      ) : null}
      {pluginOptions.editingFavorite ? (
        <Group>
          <Row
            title={t("models.unified.saveFavorite")}
            onPress={() => pluginOptions.onSaveEdit?.()}
            disabled={p.busy || pluginOptions.favoritesDisabled}
            testID={`${p.testID}.saveFavorite`}
          />
          <Row
            title={t("models.unified.cancelEdit")}
            onPress={() => pluginOptions.onCancelEdit?.()}
            disabled={p.busy}
            testID={`${p.testID}.cancelEdit`}
          />
        </Group>
      ) : (
        <>
          <Group title={t("models.unified.currentConfiguration")}>
            <Row
              disabled={p.busy || pluginOptions.favoritesDisabled}
              leading={icon(Star, pluginOptions.isFavorite)}
              onPress={pluginOptions.onFavorite}
              testID={`${p.testID}.favorite`}
              title={t(
                pluginOptions.isFavorite
                  ? "models.unified.savedConfiguration"
                  : "models.unified.favoriteConfiguration",
              )}
              subtitle={pluginOptions.configurationSummary}
            />
          </Group>
          <Text style={styles.footnote}>
            {t(
              pluginOptions.isFavorite
                ? "models.unified.removeFavoriteHint"
                : "models.unified.saveFavoriteHint",
            )}
          </Text>
        </>
      )}
      {pluginOptions.notice ? (
        <Text
          style={styles.footnote}
          accessibilityLiveRegion="polite"
          testID={`${p.testID}.notice`}
        >
          {pluginOptions.notice}
        </Text>
      ) : null}
    </>
  ) : null;

  const modelGroupManagedRow = p.modelGroups?.managedMeta ? (
    <View style={styles.managedBanner} testID={`${p.testID}.modelGroupManaged`}>
      <View style={styles.leading}>
        <Sparkles color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
      </View>
      <Text numberOfLines={2} style={[styles.rowSubtitle, styles.rowMain]}>
        {t("models.modelGroups.picker.managedBy", { name: p.modelGroups.managedMeta.routeName })}
      </Text>
      {p.modelGroups.onDetach ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: p.busy }}
          disabled={p.busy}
          onPress={p.modelGroups.onDetach}
          style={({ pressed }) => [styles.detachButton, p.busy && styles.rowDisabled, pressed && styles.pressed]}
          testID={`${p.testID}.modelGroupDetach`}
        >
          <Text style={styles.detachButtonText}>{t("models.modelGroups.picker.detach")}</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  // 模型组行：组图标 + 组名，下方是来源数 · 选法；选中的打勾。点了由被控电脑按组的规则选来源。
  const modelGroupRow = (row: UnifiedMobileModelGroupRow) => (
    <Pressable
      key={row.id}
      accessibilityLabel={[row.title, row.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ selected: row.selected, disabled: p.busy }}
      disabled={p.busy}
      onPress={() => p.modelGroups?.onSelect(row.id)}
      style={({ pressed }) => [styles.modelMain, pressed && styles.pressed]}
      testID={`${p.testID}.modelGroup.${row.id}`}
    >
      <View style={styles.leading}>
        <Sparkles color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
      </View>
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={[styles.rowTitle, styles.titleText]}>{row.title}</Text>
        {row.subtitle ? <Text numberOfLines={1} style={styles.rowSubtitle}>{row.subtitle}</Text> : null}
      </View>
      {row.selected ? (
        <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
      ) : null}
    </Pressable>
  );

  // 插件引擎的模型行：引擎图标 + 模型名(+ 思考深度)；不可用的引擎可见但不能选，下方是插件给的说明。
  // 选中且该模型有档位时，下面多一行思考深度选择(只改档位，不关闭选择器)；行尾入口打开配置与收藏页。
  const pluginEngineRow = (row: UnifiedMobilePluginEngineRow) => {
    const disabled = p.busy || row.disabled;
    const onPluginOptions = !row.disabled ? p.pluginEngines?.onOptions : undefined;
    return (
      <View key={row.key}>
        <View style={styles.modelRow}>
          <Pressable
            accessibilityLabel={[row.title, row.remoteDevice?.name, row.effortLabel, row.subtitle, row.notice, row.quotaLabel].filter(Boolean).join(", ")}
            accessibilityRole="button"
            accessibilityState={{ selected: row.selected, disabled }}
            disabled={disabled}
            onPress={() => p.pluginEngines?.onSelect(row)}
            style={({ pressed }) => [styles.modelMain, row.disabled && styles.rowDisabled, pressed && styles.pressed]}
            testID={`${p.testID}.pluginEngine.${row.key}`}
          >
            <View style={styles.leading}>
              <PluginEngineMark iconDataUrl={row.iconDataUrl} remote={row.remoteDevice != null} size={iconSize.action} />
            </View>
            <View style={styles.rowMain}>
              <View style={styles.titleLine}>
                <Text numberOfLines={1} style={[styles.rowTitle, styles.titleText]}>{row.title}</Text>
                {row.effortLabel ? <Text numberOfLines={1} style={styles.meta}>{row.effortLabel}</Text> : null}
              </View>
              {row.subtitle ? <Text numberOfLines={1} style={styles.rowSubtitle}>{row.subtitle}</Text> : null}
              {row.notice ? <Text style={styles.rowNotice}>{row.notice}</Text> : null}
              {row.quotaLabel ? <Text numberOfLines={1} style={styles.quotaText}>{row.quotaLabel}</Text> : null}
            </View>
            {row.favorite ? (
              <Star
                color={colors.textSecondary}
                fill={colors.textSecondary}
                size={iconSize.md}
                strokeWidth={iconStroke.regular}
              />
            ) : null}
            {row.selected ? (
              <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
            ) : null}
          </Pressable>
          {onPluginOptions ? (
            <Pressable
              accessibilityLabel={t("models.picker.configureAccessibility", {
                model: row.title,
              })}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onPluginOptions(row)}
              style={({ pressed }) => [
                styles.optionsButton,
                pressed && styles.pressed,
              ]}
              testID={`${p.testID}.pluginEngine.${row.key}.optionsButton`}
            >
              <SlidersHorizontal
                color={colors.textSecondary}
                size={iconSize.action}
                strokeWidth={iconStroke.regular}
              />
            </Pressable>
          ) : null}
        </View>
        {row.selected && !row.favorite && row.efforts.length ? (
          <NativePullDownMenu
            disabled={p.busy}
            actions={row.efforts.map((effort) => ({
              id: effort,
              title: level(effort),
              state: effort === row.effort ? "on" : "off",
              disabled: p.busy,
            }))}
            onAction={(id) => {
              const effort = row.efforts.find((item) => item === id);
              if (!p.busy && effort) p.pluginEngines?.onSelect(row, effort);
            }}
            testID={`${p.testID}.pluginEngine.${row.key}.effortMenu`}
          >
            <Row
              accessibilityLabel={`${t("models.options.reasoningEffort")}, ${row.effortLabel}`}
              disabled={p.busy}
              onPress={() => {
                if (!usesNativePullDownMenu()) {
                  const next = row.efforts[(row.efforts.indexOf(row.effort ?? row.efforts[0]!) + 1) % row.efforts.length];
                  if (next) p.pluginEngines?.onSelect(row, next);
                }
              }}
              leading={icon(Brain)}
              testID={`${p.testID}.pluginEngine.${row.key}.effort`}
              title={t("models.options.reasoningEffort")}
              trailing={<ChevronsUpDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
              value={row.effortLabel || null}
            />
          </NativePullDownMenu>
        ) : null}
      </View>
    );
  };
  const pluginEngineGroups = p.pluginEngines?.groups ?? [];

  const modelRow = (row: UnifiedMobileRow) => {
    const agentLabel = mobileAgentLabel(row.config.agent);
    const disabled = p.busy || row.disabled;
    return (
      <View key={row.key} style={styles.modelRow}>
        <Pressable
          accessibilityLabel={[
            row.entry.displayName,
            row.remoteDevice?.name,
            agentLabel,
            row.subtitle,
            row.sourceUnavailableReason,
            row.config.fast ? t("models.options.fastMode") : null,
            row.quotaLabel,
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityRole="button"
          accessibilityState={{ selected: row.selected, disabled }}
          disabled={disabled}
          onPress={() => p.onSelect(row)}
          style={({ pressed }) => [
            styles.modelMain,
            row.disabled && styles.rowDisabled,
            pressed && styles.pressed,
          ]}
          testID={`${p.testID}.model.${row.key}`}
        >
          <View style={styles.leading}>
            <MobileModelIconMark
              icon={row.entry.icon}
              {...row.providerMark}
              color={colors.textSecondary}
              remote={row.remoteDevice != null}
            />
          </View>
          <View style={styles.rowMain}>
            <View style={styles.titleLine}>
              <Text
                numberOfLines={1}
                style={[styles.rowTitle, styles.titleText]}
              >
                {row.entry.displayName}
              </Text>
              {row.costMarks ? (
                <Text style={styles.meta}>{row.costMarks}</Text>
              ) : null}
              <MobileAgentMark
                agentKind={row.config.agent}
                color={colors.textSecondary}
              />
              {row.effortLabel ? (
                <Text numberOfLines={1} style={styles.meta}>
                  {row.effortLabel}
                </Text>
              ) : null}
              {row.config.fast ? (
                <ModelSpeedIcon
                  mode={row.config.fast}
                  color={colors.textSecondary}
                  size={iconSize.sm}
                />
              ) : null}
            </View>
            {row.subtitle ? (
              <Text numberOfLines={1} style={styles.rowSubtitle}>
                {row.subtitle}
              </Text>
            ) : null}
            {row.sourceUnavailableReason ? (
              <Text style={styles.rowNotice}>{row.sourceUnavailableReason}</Text>
            ) : null}
            {row.quotaLabel ? (
              <Text numberOfLines={1} style={styles.quotaText}>
                {row.quotaLabel}
              </Text>
            ) : null}
          </View>
          {row.favorite ? (
            <Star
              color={colors.textSecondary}
              fill={colors.textSecondary}
              size={iconSize.md}
              strokeWidth={iconStroke.regular}
            />
          ) : null}
          {row.selected ? (
            <Check
              color={colors.textPrimary}
              size={iconSize.lg}
              strokeWidth={iconStroke.medium}
            />
          ) : null}
        </Pressable>
        <Pressable
          accessibilityLabel={t("models.picker.configureAccessibility", {
            model: row.entry.displayName,
          })}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => p.onOptions(row)}
          style={({ pressed }) => [
            styles.optionsButton,
            pressed && styles.pressed,
          ]}
          testID={`${p.testID}.model.${row.key}.optionsButton`}
        >
          <SlidersHorizontal
            color={colors.textSecondary}
            size={iconSize.action}
            strokeWidth={iconStroke.regular}
          />
        </Pressable>
      </View>
    );
  };

  const groupHeading = (group: UnifiedMobilePickerViewProps['groups'][number]) => (
    <View style={styles.quotaHeading}>
      <Text style={styles.groupLabel}>{group.title}</Text>
      {group.quota?.summary && <Pressable hitSlop={8} accessibilityRole="button"
        accessibilityLabel={[group.quota.summary, group.quota.resetSoon ? t('models.unified.quotaResetSoon') : null, group.quota.resetDescription].filter(Boolean).join(' · ')}
        testID={`${p.testID}.group.${group.key}.quota`} onPress={() => setPage('sources')}
        style={{flexShrink:1,flexDirection:'row',flexWrap:'wrap',justifyContent:'flex-end',alignItems:'center',gap:4}}>
        <Text style={styles.quotaText}>{typeof group.quota.remaining === 'number' ? `${group.quota.remaining}%` : group.quota.summary}</Text>
        {group.quota.reset && <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:4}}>
          <Text style={styles.quotaText}>· {group.quota.reset.remaining}%</Text>
          {!!group.quota.resetParts?.[0] && <Text style={styles.quotaText}>{group.quota.resetParts[0]}</Text>}
          <Text style={[styles.quotaText,group.quota.reset.level === 'crit' ? styles.quotaResetCrit : group.quota.reset.level === 'warn' ? styles.quotaResetWarn : null]}>{group.quota.reset.time}</Text>
          {!!group.quota.resetParts?.[1] && <Text style={styles.quotaText}>{group.quota.resetParts[1]}</Text>}
        </View>}
      </Pressable>}
    </View>
  );
  const pluginGroupHeading = (group: UnifiedMobilePluginEngineGroup) => {
    const quota = group.quota;
    return (
      <View style={styles.quotaHeading}>
        <Text style={styles.groupLabel}>{group.title}</Text>
        {quota?.isMultiGroup && quota.groups?.length ? (
          <View
            accessibilityLabel={quota.accessibilityLabel}
            style={styles.pluginMultiQuota}
            testID={`${p.testID}.group.${group.key}.quota`}
          >
            {quota.groups.map((item, index) => (
              <View key={item.id} style={styles.pluginQuotaPart}>
                {index > 0 ? <Text style={styles.quotaText}>·</Text> : null}
                <Text style={styles.quotaText}>{item.label}</Text>
                <Text
                  style={[
                    styles.quotaText,
                    item.level === "crit"
                      ? styles.quotaResetCrit
                      : item.level === "warn"
                        ? styles.quotaResetWarn
                        : null,
                  ]}
                >
                  {`${item.remaining}%`}
                </Text>
              </View>
            ))}
          </View>
        ) : quota?.summary ? (
          <Text
            accessibilityLabel={quota.accessibilityLabel}
            testID={`${p.testID}.group.${group.key}.quota`}
            style={[
              styles.quotaText,
              quota.level === "crit"
                ? styles.quotaResetCrit
                : quota.level === "warn"
                  ? styles.quotaResetWarn
                  : null,
            ]}
          >
            {quota.summary}
          </Text>
        ) : null}
      </View>
    );
  };

  const listPage =
    Platform.OS === "android" ? null : (
      <>
        {favoritesGroup ? (
          <Group
            key={favoritesGroup.key}
            testID={`${p.testID}.group.${favoritesGroup.key}`}
            heading={groupHeading(favoritesGroup)}
          >
            {(favoritesGroup.items ?? favoritesGroup.rows.map((row) => ({ kind: "model" as const, row }))).map(
              (item) => (item.kind === "pluginEngine" ? pluginEngineRow(item.row) : modelRow(item.row)),
            )}
          </Group>
        ) : null}
        {modelGroupManagedRow}
        {p.modelGroups?.rows.length ? (
          <Group testID={`${p.testID}.group.model-groups`} title={p.modelGroups.title}>
            {p.modelGroups.rows.map(modelGroupRow)}
          </Group>
        ) : null}
        {pluginEngineGroups.map((group) => (
          <Group key={group.key} testID={`${p.testID}.group.${group.key}`} heading={pluginGroupHeading(group)}>
            {group.rows.map(pluginEngineRow)}
          </Group>
        ))}
        {otherGroups.map((group) => (
          <Group
            key={group.key}
            testID={`${p.testID}.group.${group.key}`}
            heading={groupHeading(group)}
          >
            {group.rows.map(modelRow)}
          </Group>
        ))}
        {!p.groups.length && !pluginEngineGroups.length && !p.modelGroups?.rows.length ? (
          <Text style={styles.empty} testID={`${p.testID}.empty`}>
            {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
          </Text>
        ) : null}
      </>
    );

  return (
    <SheetModal
      keyboardAvoiding
      onBackdropPress={p.onClose}
      onClosed={p.onClosed}
      onRequestClose={back ?? p.onClose}
      visible={p.visible}
    >
      <View
        pointerEvents={showSecondary ? "none" : "auto"}
        accessibilityElementsHidden={showSecondary}
        importantForAccessibility={
          showSecondary ? "no-hide-descendants" : "auto"
        }
        style={showSecondary ? styles.hiddenList : undefined}
      >
        <SheetSurface
          bottomInset={insets.bottom}
          heights={heights}
          onClose={p.onClose}
          onSnapChange={(next) => {
            if (next === "half") searchRef.current?.blur();
            setSnap(next);
          }}
          pinnedTop={searchHeader}
          snap={snap}
          testID={showSecondary ? `${p.testID}.list` : p.testID}
          title={t("models.picker.title")}
          renderScrollContent={
            Platform.OS === "android"
              ? (scrollProps) => (
                  <FlatList
                    {...scrollProps}
                    ref={modelListRef}
                    data={modelItems}
                    onScrollBeginDrag={cancelInitialScroll}
                    onContentSizeChange={scrollToSelected}
                    onScrollToIndexFailed={({ index, averageItemLength }) => {
                      if (++initialScrollAttempts.current > 5) return;
                      initialScrollPending.current = true;
                      modelListRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
                      if (initialScrollTimer.current !== null) clearTimeout(initialScrollTimer.current);
                      initialScrollTimer.current = setTimeout(scrollToSelected, 50);
                    }}
                    keyExtractor={(item) => item.key}
                    initialNumToRender={8}
                    maxToRenderPerBatch={4}
                    windowSize={3}
                    removeClippedSubviews={false}
                    ListHeaderComponent={
                      (p.error ? <ErrorNotice message={p.error} /> : null) ?? undefined
                    }
                    ListEmptyComponent={
                      <Text style={styles.empty} testID={`${p.testID}.empty`}>
                        {p.loading
                          ? t("models.picker.loadingDefault")
                          : p.emptyHint}
                      </Text>
                    }
                    renderItem={({ item }) =>
                      item.kind === "modelGroupManaged" ? (
                        modelGroupManagedRow
                      ) : item.kind === "modelGroupHeader" ? (
                        <View style={styles.group} testID={`${p.testID}.group.model-groups`}>
                          <Text style={styles.groupLabel}>{item.title}</Text>
                        </View>
                      ) : item.kind === "modelGroup" ? (
                        <View>
                          {item.separator ? <View style={styles.separator} /> : null}
                          {modelGroupRow(item.row)}
                        </View>
                      ) : item.kind === "pluginHeader" ? (
                        <View style={styles.group} testID={`${p.testID}.group.${item.group.key}`}>
                          {pluginGroupHeading(item.group)}
                        </View>
                      ) : item.kind === "pluginModel" ? (
                        <View>
                          {item.separator ? <View style={styles.separator} /> : null}
                          {pluginEngineRow(item.row)}
                        </View>
                      ) : item.kind === "header" ? (
                        <View
                          style={styles.group}
                          testID={`${p.testID}.group.${item.group.key}`}
                        >
                          {groupHeading(item.group)}
                        </View>
                      ) : (
                        <View>
                          {item.separator ? (
                            <View style={styles.separator} />
                          ) : null}
                          {modelRow(item.row)}
                        </View>
                      )
                    }
                  />
                )
              : undefined
          }
        >
          {!showSecondary && p.error ? <ErrorNotice message={p.error} /> : null}
          {listPage}
        </SheetSurface>
      </View>
      {showSecondary ? (
        <View style={styles.secondaryLayer}>
          <SheetSurface
            backAccessibilityLabel={
              page ? undefined : t("models.picker.backToModels")
            }
            bottomInset={insets.bottom}
            heights={heights}
            onBack={back}
            onClose={p.onClose}
            onSnapChange={(next) => {
              // 拖回 half 视为想收起键盘(与旧版模型浮窗同口径)。
              if (next === "half") searchRef.current?.blur();
              setSnap(next);
            }}
            snap={snap}
            testID={p.testID}
            title={title}
          >
            {p.error ? <ErrorNotice message={p.error} /> : null}
            {page === "sources"
              ? sourcesPage
              : page === "harness" && options
                ? harnessPage
                : options
                  ? settingsPage
                  : pluginOptions
                    ? pluginEngineSettingsPage
                    : null}
          </SheetSurface>
        </View>
      ) : null}
    </SheetModal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    hiddenList: { opacity: 0 },
    secondaryLayer: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
    },
    searchRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    searchField: {
      alignItems: "center",
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: "row",
      gap: spacing.sm,
      minHeight: 44,
      minWidth: 0,
      paddingLeft: spacing.md,
      paddingRight: spacing.xs,
    },
    searchInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.bodySmall,
      minWidth: 0,
      paddingVertical: spacing.sm,
    },
    iconButton: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    sourceButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.xs,
      maxWidth: 140,
      minHeight: 44,
    },
    sourceLabel: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.bodySmall,
    },
    markBox: {
      alignItems: "center",
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    group: {
      paddingTop: spacing.lg,
    },
    quotaHeading: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm,
    },
    pluginMultiQuota: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      flexWrap: "wrap",
      gap: spacing.xs,
      justifyContent: "flex-end",
      paddingBottom: spacing.xs,
    },
    pluginQuotaPart: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.xs,
    },
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingBottom: spacing.xs,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 48,
      paddingVertical: spacing.xs,
    },
    rowDisabled: {
      opacity: 0.4,
    },
    pressed: mobileInteractionStyles.pressed,
    leading: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 28,
      width: 28,
    },
    rowMain: {
      flex: 1,
      minWidth: 0,
    },
    rowTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    rowSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    rowNotice: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    rowValue: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.body,
      maxWidth: "50%",
    },
    sourceLeading: {
      alignItems: "center",
      gap: spacing.xs,
    },
    modelRow: {
      alignItems: "center",
      flexDirection: "row",
    },
    modelMain: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 56,
      minWidth: 0,
      paddingVertical: spacing.sm,
    },
    titleLine: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.xs,
      minWidth: 0,
    },
    titleText: {
      flexShrink: 1,
    },
    meta: {
      color: colors.textSecondary,
      flexShrink: 0,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    quotaResetWarn: { color: colors.quotaBarWarn },
    quotaResetCrit: { color: colors.quotaBarCrit },
    quotaText: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    optionsButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    footnote: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
    price: {
      paddingTop: spacing.lg,
    },
    empty: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingVertical: spacing.lg,
      textAlign: "center",
    },
    managedBanner: {
      alignItems: "center",
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: spacing.sm,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    detachButton: {
      borderColor: colors.borderStrong,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 32,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    detachButtonText: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.caption,
    },
    error: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
  });
}
