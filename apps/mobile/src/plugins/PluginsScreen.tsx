import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useIsFocused, useRouter } from "expo-router";
import { goBackGuarded } from "@/utils/backGuard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Info,
  Monitor,
  Puzzle,
  Search,
  Settings,
} from "lucide-react-native";
import {
  resolveRemoteText,
  type PluginPageSurface,
  type RemoteResource,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { useDeviceManagement } from "@/device-link/useDeviceManagement";
import {
  getRemoteResource,
  type HostedRemoteCollectionItem,
} from "@/device-link/remoteResources";
import { useRemoteResourceList } from "@/session/useRemoteResourceList";
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from "@/platform/chrome/SimpleStackHeader";
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
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { PluginTaskPicker } from "./PluginTaskPicker";
import { PluginTaskSettings } from "./PluginTaskSettings";
import { PluginPage } from "./PluginPage";
import { invokePlugin } from "./pluginClient";

export default function PluginsScreen() {
  const auth = useAuth();
  return <PluginDirectory key={auth.accountGeneration} />;
}
function PluginDirectory() {
  const auth = useAuth(),
    router = useRouter(),
    focused = useIsFocused();
  const { t, i18n } = useTranslation();
  const { invoke } = useDeviceLink();
  const { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const devices = useDeviceManagement(auth.apiFetch, focused);
  const targets = useMemo(
    () =>
      devices.devices
        .filter(
          (d) =>
            d.remoteControlEnabled &&
            !d.isSelf &&
            !["ios", "android"].includes(d.platform ?? ""),
        )
        .map((d) => ({ deviceId: d.deviceId, deviceName: d.name })),
    [devices.devices],
  );
  const list = useRemoteResourceList("plugins", targets);
  const [deviceId, setDeviceId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [selected, setSelected] = useState<{
    row: HostedRemoteCollectionItem;
    surface?: PluginPageSurface;
  }>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<RemoteResource>();
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [taskPicker, setTaskPicker] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  useEffect(() => {
    setPageTitle("");
  }, [selected?.row.key, selected?.surface]);
  const pageBack = useRef<(() => void) | null>(null);
  const registerBack = useCallback((handler: (() => void) | null) => {
    pageBack.current = handler;
  }, []);
  const goBack = useCallback(() => {
    if (detailOpen && selected?.surface) setDetailOpen(false);
    else if (selected?.surface && pageBack.current) pageBack.current();
    else if (selected && !wide) {
      detailGeneration.current += 1;
      setSelected(undefined);
    } else goBackGuarded(router);
  }, [detailOpen, selected, wide, router]);
  useEffect(() => {
    if (!focused || !selected || wide) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => listener.remove();
  }, [focused, selected, wide, goBack]);
  const detailGeneration = useRef(0),
    recentTouched = useRef(false);
  const recentOwner = useRef(getMobileAuthOwner()).current;
  const recentKey = `cindy.pluginRecent.v1.${recentOwner.accountKey}`;
  useEffect(() => {
    let disposed = false;
    void AsyncStorage.getItem(recentKey)
      .then((raw) => {
        if (
          disposed ||
          !isMobileAuthOwnerCurrent(recentOwner) ||
          recentTouched.current ||
          !raw ||
          raw.length > 8000
        )
          return;
        try {
          const value = JSON.parse(raw);
          if (Array.isArray(value))
            setRecent(
              value.filter((key) => typeof key === "string").slice(0, 6),
            );
        } catch {
          /* optional local history */
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      detailGeneration.current += 1;
    };
  }, [recentKey, recentOwner]);
  useEffect(() => {
    if (recentTouched.current && isMobileAuthOwnerCurrent(recentOwner))
      void AsyncStorage.setItem(recentKey, JSON.stringify(recent)).catch(
        () => {},
      );
  }, [recent, recentKey, recentOwner]);
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const items = list.items.filter(
    ({ host, item }) =>
      (!deviceId || host.deviceId === deviceId) &&
      (filter === "all" || item.display.badges?.length) &&
      `${text(item.display.title)} ${item.display.subtitle ? text(item.display.subtitle) : ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const showDetail = async (row: HostedRemoteCollectionItem) => {
    const generation = ++detailGeneration.current,
      owner = getMobileAuthOwner();
    setSelected((current) =>
      current?.row.key === row.key ? { ...current, row } : { row },
    );
    setDetailOpen(true);
    setDetail(undefined);
    try {
      const resource = await getRemoteResource(
        invoke,
        row.host,
        row.item.ref,
        i18n.language,
        ["plugin-capabilities"],
      );
      if (
        generation === detailGeneration.current &&
        isMobileAuthOwnerCurrent(owner)
      )
        setDetail(resource);
    } catch {
      if (
        generation === detailGeneration.current &&
        isMobileAuthOwnerCurrent(owner)
      )
        Alert.alert(t("plugins.loadFailed"));
    }
  };
  const open = (
    row: HostedRemoteCollectionItem,
    surface?: PluginPageSurface,
  ) => {
    if (!list.isOnline(row.host)) {
      Alert.alert(t("plugins.offline"));
      return;
    }
    const action = surface
      ? row.item.actions?.find((a) => a.id === `open:${surface}`)
      : (row.item.actions?.find((a) => a.id === "open:panel") ??
        row.item.actions?.find((a) => a.id === "open:mainView"));
    if (!action || action.disabled) {
      void showDetail(row);
      return;
    }
    detailGeneration.current += 1;
    recentTouched.current = true;
    setDetailOpen(false);
    setSelected({ row, surface: action.id.slice(5) as PluginPageSurface });
    setRecent((current) =>
      [row.key, ...current.filter((key) => key !== row.key)].slice(0, 6),
    );
  };
  const openTask = useCallback(
    (sessionId: string) => {
      if (selected)
        router.push({
          pathname: "/sessions/[sessionId]",
          params: { sessionId, deviceId: selected.row.host.deviceId },
        });
    },
    [router, selected],
  );
  const selectDevice = () =>
    Alert.alert(t("plugins.computer"), undefined, [
      { text: t("plugins.allComputers"), onPress: () => setDeviceId("") },
      ...targets.map((host) => ({
        text: host.deviceName,
        onPress: () => setDeviceId(host.deviceId),
      })),
      { text: t("plugins.cancel"), style: "cancel" },
    ]);
  const icon = (row: HostedRemoteCollectionItem) => {
    const uri = row.item.display.avatar?.value;
    return uri &&
      /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(uri) ? (
      <Image source={{ uri }} style={styles.icon} />
    ) : (
      <View style={[styles.icon, styles.fallback]}>
        <Puzzle color={colors.textSecondary} size={iconSize.lg} />
      </View>
    );
  };
  const renderRow = (row: HostedRemoteCollectionItem) => (
    <View
      key={row.key}
      style={[
        styles.row,
        selected?.row.key === row.key && wide && styles.selected,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => open(row)}
        style={styles.rowMain}
      >
        {icon(row)}
        <View style={styles.rowText}>
          <View style={styles.inline}>
            <Text numberOfLines={1} style={styles.rowTitle}>
              {text(row.item.display.title)}
            </Text>
            {row.item.display.badges?.length ? (
              <View
                accessibilityLabel={t("plugins.unread")}
                style={styles.dot}
              />
            ) : null}
          </View>
          <Text numberOfLines={2} style={styles.preview}>
            {row.item.display.preview
              ? text(row.item.display.preview)
              : row.item.display.subtitle
                ? text(row.item.display.subtitle)
                : ""}
          </Text>
          {targets.length > 1 || !list.isOnline(row.host) ? (
            <Text style={styles.meta}>
              {row.host.deviceName}
              {!list.isOnline(row.host)
                ? ` · ${t("plugins.notConnected")}`
                : ""}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("plugins.detailsFor", {
          name: text(row.item.display.title),
        })}
        style={styles.info}
        onPress={() => {
          void showDetail(row);
        }}
      >
        <Info color={colors.textTertiary} size={iconSize.md} />
      </Pressable>
    </View>
  );
  const directory = (
    <View style={[styles.directory, wide && styles.sidebar]}>
      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          style={styles.device}
          onPress={selectDevice}
        >
          <Monitor size={iconSize.sm} color={colors.textSecondary} />
          <Text style={styles.controlText}>
            {targets.find((h) => h.deviceId === deviceId)?.deviceName ??
              t("plugins.allComputers")}
          </Text>
          <ChevronDown size={iconSize.sm} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.search}>
          <Search size={iconSize.md} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("plugins.search")}
            placeholderTextColor={colors.textPlaceholder}
            style={styles.input}
            accessibilityLabel={t("plugins.search")}
            clearButtonMode="while-editing"
          />
        </View>
        <View style={styles.inline}>
          {(["all", "unread"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
              onPress={() => setFilter(value)}
              style={[styles.chip, filter === value && styles.selected]}
            >
              <Text style={styles.controlText}>{t(`plugins.${value}`)}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={list.refreshing}
            onRefresh={() => {
              devices.refresh();
              void list.refresh();
            }}
            tintColor={colors.textSecondary}
          />
        }
      >
        {list.loading && !items.length ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : null}
        {!query &&
        filter === "all" &&
        recent.some((key) => items.some((row) => row.key === key)) ? (
          <>
            <Text style={styles.groupLabel}>{t("plugins.recent")}</Text>
            <View style={styles.groupCard}>
              {recent.flatMap((key) => {
                const row = items.find((r) => r.key === key);
                return row ? [renderRow(row)] : [];
              })}
            </View>
          </>
        ) : null}
        <Text style={styles.groupLabel}>{t("plugins.installed")}</Text>
        <View style={styles.groupCard}>{items.map(renderRow)}</View>
        {!list.loading && !items.length ? (
          <View style={styles.empty}>
            <Puzzle size={iconSize.xl} color={colors.textTertiary} />
            <Text style={styles.preview}>
              {t(
                query
                  ? "plugins.noResults"
                  : targets.length
                    ? "plugins.noPlugins"
                    : "plugins.noComputer",
              )}
            </Text>
            {!targets.length ? (
              <Pressable
                style={styles.button}
                onPress={() => router.push("/devices/manage")}
              >
                <Text style={styles.controlText}>
                  {t("plugins.connectComputer")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {list.error ? (
          <Text style={styles.note}>{t("plugins.listUnavailable")}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
  const enable = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const action = selected.row.item.actions?.find(
        (a) => a.id === "enable" || a.id === "disable",
      );
      if (action)
        await invokePlugin(
          invoke,
          selected.row.host.deviceId,
          selected.row.item.ref.id,
          action.id,
        );
      await list.refresh();
      setSelected(undefined);
    } catch {
      Alert.alert(t("plugins.actionFailed"));
    } finally {
      setBusy(false);
    }
  };
  const detailView = selected ? (
    <ScrollView contentContainerStyle={styles.detail}>
      <View style={styles.identity}>
        {icon(selected.row)}
        <View style={styles.rowText}>
          <Text style={styles.title}>
            {text(selected.row.item.display.title)}
          </Text>
          <Text style={styles.meta}>{selected.row.host.deviceName}</Text>
        </View>
      </View>
      <Text style={styles.preview}>
        {selected.row.item.display.subtitle
          ? text(selected.row.item.display.subtitle)
          : ""}
      </Text>
      <View style={styles.groupCard}>
        {selected.row.item.actions
          ?.filter((action) => action.id.startsWith("open:"))
          .map((action) => (
            <Pressable
              key={action.id}
              disabled={action.disabled}
              style={styles.settingRow}
              onPress={() =>
                open(selected.row, action.id.slice(5) as PluginPageSurface)
              }
            >
              <Text style={styles.controlText}>
                {t(`plugins.${action.id.slice(5)}`)}
              </Text>
              <ChevronRight size={iconSize.md} color={colors.textTertiary} />
            </Pressable>
          ))}
      </View>
      {detail?.blocks?.some(
        (block) =>
          block.id === "capabilities" &&
          (block.data as { tasks?: boolean } | undefined)?.tasks,
      ) ? (
        <PluginTaskSettings
          key={selected.row.key}
          deviceId={selected.row.host.deviceId}
          pluginId={selected.row.item.ref.id}
        />
      ) : null}
      <Text style={styles.groupLabel}>{t("plugins.useInTask")}</Text>
      <View style={styles.groupCard}>
        <Pressable
          style={styles.settingRow}
          onPress={() =>
            router.push({
              pathname: "/sessions/new",
              params: {
                deviceId: selected.row.host.deviceId,
                deviceName: selected.row.host.deviceName,
                draft: t("plugins.taskDraft", {
                  name: text(selected.row.item.display.title),
                }),
              },
            })
          }
        >
          <Text style={styles.controlText}>{t("plugins.newTask")}</Text>
          <ChevronRight size={iconSize.md} color={colors.textTertiary} />
        </Pressable>
        <Pressable
          style={styles.settingRow}
          onPress={() => setTaskPicker(true)}
        >
          <Text style={styles.controlText}>{t("plugins.chooseTask")}</Text>
          <ChevronRight size={iconSize.md} color={colors.textTertiary} />
        </Pressable>
      </View>
      <Text style={styles.note}>{t("plugins.taskHint")}</Text>
      {!selected.row.item.actions?.some(
        (a) => a.id === "open:panel" || a.id === "open:mainView",
      ) ? (
        <Text style={styles.note}>{t("plugins.noMobilePage")}</Text>
      ) : null}
      {detail?.blocks
        ?.filter((block) => block.id === "version")
        .map((block) => (
          <Text key={block.id} style={styles.meta}>
            {block.fallbackMarkdown}
          </Text>
        ))}
      <Pressable
        disabled={busy}
        style={styles.settingRow}
        onPress={() => {
          void enable();
        }}
      >
        <Text style={styles.controlText}>
          {t(
            selected.row.item.actions?.some((a) => a.id === "disable")
              ? "plugins.disable"
              : "plugins.enable",
          )}
        </Text>
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Settings color={colors.textSecondary} size={iconSize.md} />
        )}
      </Pressable>
    </ScrollView>
  ) : (
    <View style={styles.empty}>
      <Puzzle color={colors.textTertiary} size={iconSize.xl} />
      <Text style={styles.preview}>{t("plugins.selectPlugin")}</Text>
    </View>
  );
  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
      <SimpleStackHeader
        title={
          selected && !wide
            ? (!detailOpen && selected.surface && pageTitle) ||
              text(selected.row.item.display.title)
            : t("plugins.title")
        }
        onBack={goBack}
        right={
          selected?.surface && !detailOpen ? (
            <Pressable
              accessibilityLabel={t("plugins.details")}
              style={styles.info}
              onPress={() => {
                void showDetail(selected.row);
              }}
            >
              <Info size={iconSize.md} color={colors.textPrimary} />
            </Pressable>
          ) : undefined
        }
      />
      {selected ? (
        <PluginTaskPicker
          deviceId={selected.row.host.deviceId}
          visible={taskPicker}
          onClose={() => setTaskPicker(false)}
          onSelect={(sessionId) => {
            setTaskPicker(false);
            router.push({
              pathname: "/sessions/[sessionId]",
              params: {
                sessionId,
                deviceId: selected.row.host.deviceId,
                deviceName: selected.row.host.deviceName,
                draft: t("plugins.taskDraft", {
                  name: text(selected.row.item.display.title),
                }),
              },
            });
          }}
        />
      ) : null}
      <View style={styles.layout}>
        {wide || !selected ? directory : null}
        {wide || selected ? (
          <View style={styles.main}>
            {selected?.surface ? (
              <View style={[styles.main, detailOpen && styles.hidden]}>
                <PluginPage
                  visible={!detailOpen}
                  key={`${selected.row.key}:${selected.surface}`}
                  deviceId={selected.row.host.deviceId}
                  pluginId={selected.row.item.ref.id}
                  surface={selected.surface}
                  onTask={openTask}
                  registerBack={registerBack}
                  onTitle={setPageTitle}
                />
              </View>
            ) : null}
            {!selected?.surface || detailOpen ? detailView : null}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    hidden: { display: "none" },
    root: { flex: 1, backgroundColor: c.surface },
    layout: { flex: 1, flexDirection: "row" },
    main: { flex: 1 },
    directory: { flex: 1 },
    sidebar: {
      flex: 0,
      width: 320,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.border,
    },
    controls: { padding: spacing.md, gap: spacing.sm },
    content: { padding: spacing.md, gap: spacing.md },
    detail: { padding: spacing.lg, gap: spacing.lg },
    inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    device: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      minHeight: 44,
      borderRadius: radius.control,
      backgroundColor: c.surfaceElevated,
    },
    input: {
      flex: 1,
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.regular,
      paddingVertical: spacing.sm,
    },
    chip: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      justifyContent: "center",
      borderRadius: radius.pill,
    },
    selected: { backgroundColor: c.surfaceChip },
    groupCard: {
      borderRadius: radius.container,
      backgroundColor: c.surfaceElevated,
      overflow: "hidden",
    },
    row: { flexDirection: "row", alignItems: "center" },
    rowMain: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      padding: spacing.md,
      gap: spacing.md,
      minHeight: 88,
    },
    rowText: { flex: 1, gap: spacing.xs },
    icon: { width: 44, height: 44, borderRadius: radius.control },
    fallback: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceChip,
    },
    info: {
      width: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: radius.pill,
      backgroundColor: c.statusDone,
    },
    identity: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    empty: {
      flex: 1,
      padding: spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.md,
    },
    settingRow: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: spacing.md,
    },
    button: { padding: spacing.md, minHeight: 44 },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    rowTitle: {
      flexShrink: 1,
      fontSize: typeScale.subtitle,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    controlText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    preview: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: c.textSecondary,
    },
    note: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textSecondary,
    },
    meta: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: c.textTertiary,
    },
    groupLabel: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.semibold,
      color: c.textTertiary,
    },
  });
