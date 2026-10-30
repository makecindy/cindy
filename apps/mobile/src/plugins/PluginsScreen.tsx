import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  Pressable,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Stack,
  useIsFocused,
  useRouter,
  useLocalSearchParams,
} from "expo-router";
import {
  pluginVisualPreview,
  pluginVisualScenario,
} from "@/debug/pluginVisualFixture";
import type { SearchBarCommands } from "react-native-screens";
import { goBackGuarded } from "@/utils/backGuard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Info,
  Monitor,
  Puzzle,
  Search,
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
import { PluginOriginalSettings } from "./PluginOriginalSettings";
import { usePluginManagement } from "./usePluginManagement";
import { PluginManagementMenu } from "./PluginManagementMenu";
import { PluginManagementConfirmation } from "./PluginManagementConfirmation";
import { PluginNotice } from "./PluginNotice";
import { createPluginManagementClient } from "./pluginManagementClient";
import {
  marketItemMatchesPlugin,
  pluginApprovalToken,
} from "./pluginManagementTypes";
import { pluginDetailModel } from "./pluginDetailModel";
import { PluginDirectoryView } from "./PluginDirectoryView";
import { PluginDetailView } from "./PluginDetailView";
import { PluginTaskPicker } from "./PluginTaskPicker";
import { PluginPage } from "./PluginPage";
import { invokePlugin } from "./pluginClient";
import { sortPluginItems } from "./pluginListOrder";

export default function PluginsScreen() {
  const auth = useAuth();
  return <PluginDirectory key={auth.accountGeneration} />;
}
function PluginDirectory() {
  const auth = useAuth(),
    router = useRouter(),
    focused = useIsFocused();
  const { t, i18n } = useTranslation();
  const { preview } = useLocalSearchParams<{ preview?: string }>();
  const previewSelection = useRef<string | undefined>(undefined);
  const { invoke, connectionEpoch } = useDeviceLink();
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
  const listFailed = Boolean(
    devices.error || (targets.length > 0 && list.error),
  );
  const directoryLoading = Boolean(devices.loading || list.loading);
  const [deviceId, setDeviceId] = useState("");
  const [query, setQuery] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const transientScope = useRef("");
  const [selected, setSelected] = useState<{
    row: HostedRemoteCollectionItem;
    surface?: PluginPageSurface;
  }>();
  const noticeScope = JSON.stringify([
    selected?.row.key,
    selected?.surface,
    auth.accountGeneration,
    connectionEpoch,
    focused,
  ]);
  const showSettingsNotice = (notice: string) => {
    transientScope.current = noticeScope;
    setSettingsNotice(notice);
  };
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<RemoteResource>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const enableLock = useRef(false);
  const [taskPicker, setTaskPicker] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const liveSelection = useRef({
    epoch: connectionEpoch,
    key: selected?.row.key,
    focused,
    online: selected ? list.isOnline(selected.row.host) : false,
  });
  liveSelection.current = {
    epoch: connectionEpoch,
    key: selected?.row.key,
    focused,
    online: selected
      ? targets.some((host) => host.deviceId === selected.row.host.deviceId) &&
        list.isOnline(selected.row.host)
      : false,
  };
  const managementHost = selected?.row.host;
  const management = usePluginManagement(
    managementHost?.deviceId,
    !!managementHost &&
      targets.some((host) => host.deviceId === managementHost.deviceId) &&
      list.isOnline(managementHost),
    focused,
    selected?.row.key,
  );
  const liveManagement = useRef(management.controller);
  liveManagement.current = management.controller;
  const managed = management.state?.snapshot?.ghosts.find(
    (plugin) => plugin.instanceKey === selected?.row.item.ref.id,
  );
  const marketItem = managed
    ? management.state?.snapshot?.market.items.find((item) =>
        marketItemMatchesPlugin(item, managed),
      )
    : undefined;
  const managementPending =
    !!management.state &&
    (management.state.busy ||
      ["running", "confirmation", "unknown"].includes(
        management.state.outcome,
      ));
  const managementAvailable =
    management.state?.capability === "supported" &&
    !management.state.errorCode &&
    !!management.state.snapshot &&
    management.state.online &&
    !managementPending;

  const searchVisible = Platform.OS === "ios" && (!selected || wide);
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const searchBar = useMemo(() => {
    let current: SearchBarCommands | null = null;
    return {
      get current() {
        return current;
      },
      set current(bar: SearchBarCommands | null) {
        current = bar;
        // Stack options attach UISearchBar after the page effect has run.
        // Initialize on attachment, never replay JS updates over native typing.
        bar?.setText(latestQuery.current);
      },
    };
  }, []);
  const searchOptions = useMemo(
    () => ({
      headerSearchBarOptions: searchVisible
        ? {
            ref: searchBar,
            placeholder: t("plugins.search"),
            placement: "stacked" as const,
            hideWhenScrolling: false,
            hideNavigationBar: false,
            obscureBackground: false,
            autoCapitalize: "none" as const,
            tintColor: colors.inputCaret,
            textColor: colors.textPrimary,
            onChangeText: (event: { nativeEvent: { text: string } }) =>
              setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
            onSearchButtonPress: () => searchBar.current?.blur(),
          }
        : undefined,
    }),
    [searchVisible, searchBar, t, colors.inputCaret, colors.textPrimary],
  );
  useEffect(() => {
    setPageTitle("");
    setSettingsNotice("");
  }, [
    selected?.row.key,
    selected?.surface,
    auth.accountGeneration,
    connectionEpoch,
    focused,
  ]);
  useEffect(() => {
    if (!settingsNotice) return;
    const timer = setTimeout(() => setSettingsNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [settingsNotice]);
  const pageBack = useRef<(() => void) | null>(null);
  const registerBack = useCallback((handler: (() => void) | null) => {
    pageBack.current = handler;
  }, []);
  const goBack = useCallback(() => {
    if (settingsOpen) setSettingsOpen(false);
    else if (detailOpen && selected?.surface) setDetailOpen(false);
    else if (selected?.surface && pageBack.current) pageBack.current();
    else if (selected && !wide) {
      detailGeneration.current += 1;
      setSelected(undefined);
    } else goBackGuarded(router);
  }, [detailOpen, settingsOpen, selected, wide, router]);
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
          raw.length > 64_000
        )
          return;
        try {
          const value = JSON.parse(raw);
          if (Array.isArray(value))
            setRecent(
              value.filter((key) => typeof key === "string").slice(0, 100),
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
  const markUsed = (key: string) => {
    if (!isMobileAuthOwnerCurrent(recentOwner)) return;
    recentTouched.current = true;
    setRecent((current) =>
      [key, ...current.filter((item) => item !== key)].slice(0, 100),
    );
  };
  const text = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const scopedItems = list.items.filter(
    ({ host }) => !deviceId || host.deviceId === deviceId,
  );
  const items = sortPluginItems(
    scopedItems.filter(({ item }) =>
      `${text(item.display.title)} ${item.display.subtitle ? text(item.display.subtitle) : ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ),
    recent,
  );
  const refreshDirectory = async () => {
    devices.refresh();
    await management.controller?.reconcile();
    await list.refresh();
  };
  const showDetail = async (row: HostedRemoteCollectionItem) => {
    const generation = ++detailGeneration.current,
      owner = getMobileAuthOwner();
    setSelected((current) =>
      current?.row.key === row.key ? { ...current, row } : { row },
    );
    setDetailOpen(true);
    setSettingsOpen(false);
    setDetail(undefined);
    setDetailFailed(false);
    if (!list.isOnline(row.host)) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
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
      ) {
        setDetail(resource);
        setSelected((current) =>
          current?.row.key === row.key
            ? { ...current, row: { ...row, item: resource } }
            : current,
        );
      }
    } catch {
      if (
        generation === detailGeneration.current &&
        isMobileAuthOwnerCurrent(owner)
      )
        setDetailFailed(true);
    } finally {
      if (
        generation === detailGeneration.current &&
        isMobileAuthOwnerCurrent(owner)
      )
        setDetailLoading(false);
    }
  };
  // Returning from a task or reconnecting may invalidate the previous Host facts.
  const selectedOnline = selected ? list.isOnline(selected.row.host) : false;
  const previousFocus = useRef(focused);
  const previousConnection = useRef({
    key: selected?.row.key,
    online: selectedOnline,
  });
  useEffect(() => {
    const returned = focused && !previousFocus.current;
    const reconnected =
      previousConnection.current.key === selected?.row.key &&
      !previousConnection.current.online &&
      selectedOnline;
    previousFocus.current = focused;
    previousConnection.current = {
      key: selected?.row.key,
      online: selectedOnline,
    };
    if (
      focused &&
      selected &&
      detailOpen &&
      selectedOnline &&
      !enableLock.current &&
      (returned || reconnected || (!detailLoading && !detail && !detailFailed))
    )
      void showDetail(selected.row);
  }, [focused, selectedOnline, selected?.row.key]);
  useEffect(() => {
    const target = pluginVisualPreview(preview);
    if (!target || previewSelection.current === preview) return;
    const row = list.items.find(
      (row) =>
        row.host.deviceId === "cindy-visual-mock-mac" &&
        row.item.ref.id === target.id,
    );
    if (!row) return;
    previewSelection.current = preview;
    const pending = showDetail(row);
    const generation = detailGeneration.current;
    void pending.then(() => {
      if (target.settings && generation === detailGeneration.current)
        setSettingsOpen(true);
    });
  }, [preview, list.items]);
  const open = (
    row: HostedRemoteCollectionItem,
    surface?: PluginPageSurface,
  ) => {
    if (!list.isOnline(row.host)) {
      void showDetail(row);
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
    setDetailOpen(false);
    setSettingsOpen(false);
    setSelected({ row, surface: action.id.slice(5) as PluginPageSurface });
  };
  const openTask = useCallback(
    (sessionId: string) => {
      if (selected) {
        markUsed(selected.row.key);
        router.push({
          pathname: "/sessions/[sessionId]",
          params: { sessionId, deviceId: selected.row.host.deviceId },
        });
      }
    },
    [router, selected],
  );
  const selectDirectoryDevice = (id: string) => {
    if (
      selected &&
      id !== deviceId &&
      id && id !== selected.row.host.deviceId
    ) {
      detailGeneration.current += 1;
      setSelected(undefined);
      setDetail(undefined);
      setSettingsOpen(false);
    }
    setDeviceId(id);
  };
  const selectDevice = () => {
    const generation = detailGeneration.current;
    const select = (id: string) => {
      if (
        generation !== detailGeneration.current ||
        !liveSelection.current.focused ||
        !isMobileAuthOwnerCurrent(recentOwner)
      )
        return;
      selectDirectoryDevice(id);
    };
    Alert.alert(t("plugins.computer"), undefined, [
      { text: t("plugins.allComputers"), onPress: () => select("") },
      ...targets.map((host) => ({
        text: host.deviceName,
        onPress: () => select(host.deviceId),
      })),
      { text: t("plugins.cancel"), style: "cancel" },
    ]);
  };
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
  const directory =
    Platform.OS === "ios" ? (
      <View style={[styles.directory, wide && styles.sidebar]}>
        <PluginDirectoryView
          targets={targets}
          deviceId={deviceId}
          onDeviceChange={selectDirectoryDevice}
          query={query}
          items={items}
          selectedKey={wide ? selected?.row.key : undefined}
          loading={directoryLoading}
          error={listFailed}
          isOnline={(row) => list.isOnline(row.host)}
          onRefresh={refreshDirectory}
          onOpen={open}
          onDetail={(row) => {
            void showDetail(row);
          }}
          onConnectComputer={() => router.push("/devices/manage")}
        />
      </View>
    ) : (
      <View style={[styles.directory, wide && styles.sidebar]}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={() => {
                void refreshDirectory();
              }}
              tintColor={colors.textSecondary}
            />
          }
        >
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
          </View>
          {directoryLoading && !items.length ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : null}
          <View style={styles.inline}>
            <Text style={[styles.groupLabel, { flex: 1 }]}>
              {t("plugins.installed")}
            </Text>
          </View>
          <View style={styles.groupCard}>{items.map(renderRow)}</View>
          {!directoryLoading && !listFailed && !items.length ? (
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
          {listFailed ? (
            <View>
              <Text style={styles.note}>
                {t(
                  items.length
                    ? "plugins.listUnavailable"
                    : "plugins.listLoadFailed",
                )}
              </Text>
              {!items.length && !directoryLoading ? (
                <Pressable
                  accessibilityRole="button"
                  style={styles.button}
                  onPress={() => {
                    devices.refresh();
                    void list.refresh();
                  }}
                >
                  <Text style={styles.controlText}>
                    {t("plugins.detail.action.retry")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  const enable = async (enabled: boolean) => {
    if (
      !selected ||
      !detail ||
      enableLock.current ||
      !list.isOnline(selected.row.host)
    )
      return;
    const actionId = enabled ? "enable" : "disable";
    if (
      !selected.row.item.actions?.some(
        (action) => action.id === actionId && !action.disabled,
      )
    )
      return;
    const row = selected.row,
      generation = detailGeneration.current,
      owner = getMobileAuthOwner();
    const current = () =>
      generation === detailGeneration.current &&
      isMobileAuthOwnerCurrent(owner);
    enableLock.current = true;
    setBusy(true);
    try {
      await invokePlugin(invoke, row.host.deviceId, row.item.ref.id, actionId);
    } catch {
      if (current()) Alert.alert(t("plugins.actionFailed"));
    } finally {
      // A failed reply may follow an applied write; confirm by reading, never replaying it.
      if (current()) await showDetail(row);
      enableLock.current = false;
      if (isMobileAuthOwnerCurrent(owner)) setBusy(false);
      void list.refresh();
    }
  };
  const enabled =
    selected?.row.item.actions?.some((action) => action.id === "disable") ??
    false;
  const demoScenario = pluginVisualScenario(
    selected?.row.host.deviceId,
    selected?.row.item.ref.id,
  );
  const online = selected
    ? list.isOnline(selected.row.host) && demoScenario?.state !== "offline"
    : false;
  const model = selected
    ? pluginDetailModel(
        selected.row,
        demoScenario?.state ? undefined : detail,
        online,
        detailLoading || demoScenario?.state === "loading",
        detailFailed || demoScenario?.state === "loadFailed",
      )
    : undefined;
  // One bounded read per target/connection resolves uncertain facts without replacing the author page.
  const uncertainFactsRead = useRef<string | undefined>(undefined);
  const uncertainConfiguration = model?.status === "setupUnknown" || model?.configuration?.items.some((item) => item.state === "unknown");
  useEffect(() => {
    if (!uncertainConfiguration || !selected || !focused || !online || detailLoading || detailFailed) return;
    const row = selected.row, generation = detailGeneration.current, owner = getMobileAuthOwner(), epoch = connectionEpoch;
    const key = JSON.stringify([row.key, auth.accountGeneration, connectionEpoch]);
    if (uncertainFactsRead.current === key) return;
    uncertainFactsRead.current = key;
    void getRemoteResource(invoke, row.host, row.item.ref, i18n.language, ["plugin-capabilities"]).then((resource) => {
      if (generation === detailGeneration.current && liveSelection.current.epoch === epoch && isMobileAuthOwnerCurrent(owner) && liveSelection.current.key === row.key && liveSelection.current.focused && liveSelection.current.online) setDetail(resource);
    }).catch(() => { /* Existing author page stays usable; an uncertain background read needs no second notice. */ });
  }, [uncertainConfiguration, selected?.row.key, focused, online, detailLoading, detailFailed, connectionEpoch, auth.accountGeneration]);
  const renderedGeneration = detailGeneration.current;
  const manageAction = async (action: string) => {
    if (
      !managementAvailable ||
      !selected ||
      !management.controller ||
      liveManagement.current !== management.controller ||
      renderedGeneration !== detailGeneration.current ||
      liveSelection.current.key !== selected.row.key ||
      !liveSelection.current.focused ||
      !liveSelection.current.online
    )
      return;
    const controller = management.controller,
      row = selected.row,
      expectedGeneration = detailGeneration.current,
      owner = getMobileAuthOwner();
    const current = () =>
      expectedGeneration === detailGeneration.current &&
      liveManagement.current === controller &&
      isMobileAuthOwnerCurrent(owner) &&
      liveSelection.current.key === row.key &&
      liveSelection.current.focused &&
      liveSelection.current.online;
    const reportPreflightFailure = () => {
      const state = controller.getState();
      if (current() && state.outcome === "failed" && !state.operationId)
        Alert.alert(t("plugins.notice.title.managementFailed"));
    };
    if (action === "uninstall" && managed) {
      const plugin = managed;
      Alert.alert(
        t("plugins.management.uninstallTitle", { name: plugin.manifest.name }),
        t("plugins.management.uninstallBody", { device: row.host.deviceName }),
        [
          { text: t("plugins.cancel"), style: "cancel" },
          {
            text: t("plugins.management.uninstall"),
            style: "destructive",
            onPress: async () => {
              if (!current()) return;
              await controller.uninstall(plugin);
              reportPreflightFailure();
            },
          },
        ],
      );
    } else if (action === "update" && marketItem && managed) {
      const displayed = marketItem;
      try {
        const client = createPluginManagementClient({
          invoke,
          deviceId: row.host.deviceId,
          isCurrent: current,
        });
        const next = await client.detail(displayed.pluginId);
        if (!current()) return;
        if (next.releaseId !== displayed.releaseId) {
          await controller.refresh();
          if (current()) Alert.alert(t("plugins.management.releaseChanged"));
          return;
        }
        await controller.install(next, managed);
        reportPreflightFailure();
      } catch {
        if (current()) Alert.alert(t("plugins.management.state.readFailed"));
      }
    }
  };
  const managementActions = [
    ...(marketItem?.installState === "update-available" && managed
      ? [
          {
            id: "update",
            title: t("plugins.management.update") + " · " + marketItem.version,
            disabled: !managementAvailable,
          },
        ]
      : []),
    ...(managed && !managed.builtin
      ? [
          {
            id: "uninstall",
            title: t("plugins.management.uninstall"),
            destructive: true,
            disabled: !managementAvailable,
          },
        ]
      : []),
  ];
  const completedOperation = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = management.state;
    if (
      !state ||
      state.outcome !== "succeeded" ||
      !state.operationId ||
      completedOperation.current === state.operationId
    )
      return;
    completedOperation.current = state.operationId;
    const row = selected?.row,
      generation = detailGeneration.current,
      owner = getMobileAuthOwner();
    void list.refresh();
    const controller = management.controller;
    void controller?.refresh().then(() => {
      if (
        !row ||
        liveManagement.current !== controller ||
        generation !== detailGeneration.current ||
        !isMobileAuthOwnerCurrent(owner)
      )
        return;
      const refreshed = controller.getState();
      if (!refreshed || refreshed.errorCode || !refreshed.online) return;
      const snapshot = refreshed.snapshot;
      const plugin = snapshot?.ghosts.find(
        (item) => item.instanceKey === row.item.ref.id,
      );
      if (plugin)
        void showDetail({
          ...row,
          key: JSON.stringify([
            row.host.deviceId,
            "plugins",
            "plugin",
            plugin.instanceKey,
          ]),
          item: {
            ...row.item,
            ref: { ...row.item.ref, id: plugin.instanceKey },
          },
        });
      else if (snapshot) {
        detailGeneration.current += 1;
        setSelected(undefined);
        setDetail(undefined);
      }
    });
  }, [management.state?.outcome, management.state?.operationId]);
  const failedOperationNotice = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = management.state;
    if (!focused || !selected || state?.outcome !== "failed" || !state.operationId) return;
    const key = JSON.stringify([selected.row.key, auth.accountGeneration, connectionEpoch, state.operationId]);
    if (failedOperationNotice.current === key) return;
    failedOperationNotice.current = key;
    Alert.alert(t("plugins.notice.title.managementFailed"));
  }, [management.state?.outcome, management.state?.operationId, selected?.row.key, focused, auth.accountGeneration, connectionEpoch]);
  const newTask = () => {
    if (!selected || !model || busy || !online || !detail || !enabled) return;
    if (!model.canUseTasks) return;
    markUsed(selected.row.key);
    router.push({
      pathname: "/sessions/new",
      params: {
        deviceId: selected.row.host.deviceId,
        deviceName: selected.row.host.deviceName,
        draft: t("plugins.taskDraft", {
          name: text(selected.row.item.display.title),
        }),
      },
    });
  };
  const originalSettings =
    !!managed &&
    !!model?.hasSettings &&
    management.state?.snapshot?.settingsPage === true;
  const resolveStatus = () => {
    if (!selected || !model || busy) return;
    switch (model.statusAction) {
      case "connect":
        router.push("/devices/manage");
        break;
      case "retry":
        void management.controller?.reconcile();
        void showDetail(selected.row);
        break;
      case "enable":
        void enable(true);
        break;
      case "reconnect":
      case "settings":
        if (originalSettings) setSettingsOpen(true);
        else Alert.alert(t("plugins.detail.computerSettings"));
        break;
    }
  };
  const noticeOwner = getMobileAuthOwner();
  const detailView =
    selected && model ? (
      <PluginDetailView
        row={selected.row}
        enabled={enabled}
        busy={busy || detailLoading || managementPending}
        statusRecoveryBusy={busy || detailLoading}
        managementNotice={management.state?.outcome === "unknown" ? {
          testID: "plugins.managementUnknown",
          title: t("plugins.notice.title.resultUnknown"),
          icon: "warning",
          actions: [{
            label: t("plugins.management.checkResult"),
            testID: "plugins.checkManagementResult",
            disabled: !online || management.state.busy,
            onPress: () => { void management.controller?.reconcile(); },
          }],
        } : undefined}
        online={online}
        model={model}
        previewLabel={
          demoScenario
            ? t("plugins.demo.hint") + " · " + demoScenario.label
            : undefined
        }
        settingsContent={
          originalSettings && managed ? (
            <PluginOriginalSettings
              key={JSON.stringify([
                selected.row.host.deviceId,
                managed.instanceKey,
                pluginApprovalToken(managed),
                connectionEpoch,
              ])}
              identity={{
                deviceId: selected.row.host.deviceId,
                instanceId: managed.instanceKey,
                expectedInstalledApproval: pluginApprovalToken(managed),
              }}
              active={focused && online && detailOpen && !managementPending}
              onNotice={(notice) => {
                if (
                  renderedGeneration === detailGeneration.current &&
                  liveSelection.current.key === selected.row.key &&
                  liveSelection.current.focused &&
                  isMobileAuthOwnerCurrent(noticeOwner)
                )
                  showSettingsNotice(notice);
              }}
            />
          ) : undefined
        }
        settingsOpen={settingsOpen}
        onEnabledChange={(value) => {
          if (model.canToggle) void enable(value);
        }}
        onOpen={(surface) => open(selected.row, surface)}
        onNewTask={() => newTask()}
        onChooseTask={() => {
          if (model.canUseTasks && !busy) setTaskPicker(true);
        }}
        onResolveStatus={resolveStatus}
      />
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
            ? (settingsOpen && t("plugins.settings")) ||
              (!detailOpen && selected.surface && pageTitle) ||
              text(selected.row.item.display.title)
            : t("plugins.title")
        }
        onBack={goBack}
        rightToolbar={
          Platform.OS === "ios" &&
          selected &&
          !(selected.surface && !detailOpen) ? (
            <PluginManagementMenu
              nativeToolbar
              actions={managementActions}
              onAction={(action) => void manageAction(action)}
            />
          ) : undefined
        }
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
          ) : selected ? (
            Platform.OS === "ios" ? undefined : (
              <PluginManagementMenu
                actions={managementActions}
                onAction={(action) => void manageAction(action)}
              />
            )
          ) : undefined
        }
      />
      {Platform.OS === "ios" ? <Stack.Screen options={searchOptions} /> : null}
      {selected ? (
        <PluginTaskPicker
          key={selected.row.key}
          deviceId={selected.row.host.deviceId}
          visible={taskPicker}
          onClose={() => setTaskPicker(false)}
          onSelect={(sessionId) => {
            setTaskPicker(false);
            if (!model?.canUseTasks || busy || !online) return;
            markUsed(selected.row.key);
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
      {selected && management.state && management.controller ? (
        <PluginManagementConfirmation
          key={JSON.stringify([
            selected.row.key,
            auth.accountGeneration,
            connectionEpoch,
          ])}
          state={management.state}
          controller={management.controller}
          deviceName={selected.row.host.deviceName}
          active={focused && online && detailOpen}
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
                  onLoaded={() => markUsed(selected.row.key)}
                />
              </View>
            ) : null}
            {!selected?.surface || detailOpen ? detailView : null}
            {settingsNotice && transientScope.current === noticeScope ? (
              <View pointerEvents="none" style={styles.toast}>
                <PluginNotice
                  testID="plugins.transientNotice"
                  title={settingsNotice}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    toast: {
      position: "absolute",
      top: spacing.md,
      left: spacing.lg + spacing.xs,
      right: spacing.lg + spacing.xs,
    },
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
    controls: { gap: spacing.sm },
    content: { padding: spacing.md, gap: spacing.md },
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
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
      gap: spacing.md,
      minHeight: 96,
    },
    rowText: { flex: 1, gap: spacing.xs },
    icon: { width: 54, height: 54, borderRadius: radius.container },
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
    empty: {
      flex: 1,
      padding: spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.md,
    },
    button: { padding: spacing.md, minHeight: 44 },
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
