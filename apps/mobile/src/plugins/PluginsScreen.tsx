import { pluginUiApprovalNotice } from "./pluginUiApprovalNotice";
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
  pluginVisualDemosEnabled,
  pluginVisualPreview,
  pluginVisualScenario,
} from "@/debug/pluginVisualFixture";
import { setPluginMarketVisualScenario } from "@/debug/pluginMarketVisualFixture";
import { seedPluginChecksForVisualMock } from "@/debug/pluginChecksVisualFixture";
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
import { PluginTaskSettings } from "./PluginTaskSettings";
import { PluginReadmePage } from "./PluginReadmePage";
import { usePluginManagement } from "./usePluginManagement";
import { PluginManagementMenu } from "./PluginManagementMenu";
import { PluginManagementConfirmation } from "./PluginManagementConfirmation";
import { PluginNotice, type PluginNoticeProps } from "./PluginNotice";
import { createPluginManagementClient } from "./pluginManagementClient";
import {
  installedApprovalToken,
  marketItemMatchesPlugin,
  pluginApprovalToken,
  samePluginMarketSourceIdentity,
} from "./pluginManagementTypes";
import { pluginDetailModel } from "./pluginDetailModel";
import {
  PluginDirectoryView,
  type PluginDirectorySegment,
} from "./PluginDirectoryView";
import { usePluginMarket } from "./usePluginMarket";
import { pluginOperationHold, samePluginSlotHolder, usePluginManagementSlot, type PluginSlotHolder, type PluginSlotToken } from "./pluginManagementSlot";
import { pluginConclusionListed, retryPluginCheckReadback, tellPluginConclusion, usePluginCheckConclusions, usePluginPendingChecks } from "./usePluginManagement";
import { PluginPendingChecksSheet, type PluginOperationLine } from "./PluginPendingChecksSheet";
import { usePluginPrompt } from "./usePluginPrompt";
import { PluginMarketSection } from "./PluginMarketSection";
import { PluginMarketDetailView } from "./PluginMarketDetailView";
import { FileBrowserSegmentedControl } from "@/session/FileBrowserSegmentedControl";
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
  const { preview, market: marketPreview, checks: checksPreview } = useLocalSearchParams<{
    preview?: string;
    market?: string;
    checks?: string;
  }>();
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
  const [segment, setSegment] = useState<PluginDirectorySegment>("installed");
  // DEV visual mock only: cindy://plugins?market=<scenario> opens a market demo state.
  useEffect(() => {
    if (setPluginMarketVisualScenario(marketPreview, pluginVisualDemosEnabled()))
      setSegment("market");
  }, [marketPreview]);
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
  /** Detail reads issued by this page (`showDetail`), counted. */
  const detailReads = useRef(0);
  const [detailFailed, setDetailFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The enable / disable write in flight (its token in the page slot): the detail is not read again meanwhile.
  const toggleToken = useRef<PluginSlotToken | null>(null);
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
  // This detail's own management operation (shown in its sheet and notices).
  const managementPending =
    !!management.state &&
    (management.state.busy ||
      ["running", "confirmation", "unknown"].includes(management.state.outcome));
  // The management slots, one per computer (pluginManagementSlot.ts; maintainer reviews 15:37, 18:45): the six entries
  // (market install, update, uninstall, enable switch, page approval, task settings save) take their computer's slot
  // synchronously when pressed and only the holder's token releases it. Whether an entry may start is decided by
  // `slot.tryAcquire`; the unavailable buttons below only show `slot.available`. The table of holders, releases and
  // pending checks is in plugin-mobile-implementation.md.
  const { slot, holders, holderOn } = usePluginManagementSlot();
  const holder = holderOn(selected?.row.host.deviceId);
  // The page's prompts (dispatcher J-2, M-2): the app's themed card on Android, a native sheet on iOS (buttons of their
  // own height, the text scrolling above them at any size); light and dark follow the app's theme. A short title; the
  // full explanation, when there is one, as its message.
  const { confirm: prompt, dialog: promptDialog } = usePluginPrompt();
  const tell = (title: string, message?: string) => { void prompt({ title: t(title), message: message ? t(message) : undefined, confirmLabel: t("plugins.gotIt") }); };
  // Who an installed-detail entry holds the slot for (shown after the page is mounted again; see the notice at the top).
  const slotHolderOf = (row: HostedRemoteCollectionItem, name?: string): PluginSlotHolder => ({
    name: name ?? resolveRemoteText(row.item.display.title, i18n.language),
    deviceId: row.host.deviceId, deviceName: row.host.deviceName, instanceKey: row.item.ref.id, rowKey: row.key,
    ...(row.key === selected?.row.key && managed ? { ghostId: managed.manifest.id } : {}) });
  // Market browsing and installs live in usePluginMarket; this screen only routes views. An install that ends never
  // moves this page: its result is listed at the top (see the notice below).
  const market = usePluginMarket({
    visible: focused && (segment === "market" || !!query.trim()) && (wide || !selected),
    focused,
    targets,
    isOnline: list.isOnline,
    installedDeviceId: deviceId,
    query,
  });
  // Shown unavailable while anyone holds this computer's slot, this plugin has a pending check, or this detail's own
  // operation is still open.
  const managementLocked = managementPending || (!!selected && !slot.available(slotHolderOf(selected.row, managed?.manifest.name)));
  const managementReady =
    management.state?.capability === "supported" &&
    !management.state.errorCode &&
    !!management.state.snapshot &&
    management.state.online;
  const managementAvailable = managementReady && !managementLocked;
  const marketDetail = selected ? null : market.detail;
  const marketView = {
    ...market,
    openDetail: (item: Parameters<typeof market.openDetail>[0]) => {
      detailGeneration.current += 1;
      setSelected(undefined);
      market.openDetail(item);
    },
    // Pull-to-refresh and "Retry" on the market alone also look for computers again: after a failed lookup the
    // market has no target and its own refresh would do nothing. A search shows both lists; the installed
    // refresh already does the lookup there.
    refresh: async () => {
      if (!query.trim()) devices.refresh();
      await market.refresh();
    },
  };

  const searchVisible =
    Platform.OS === "ios" && ((!selected && !marketDetail) || wide);
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
    if (readmeOpen) setReadmeOpen(false);
    else if (settingsOpen) setSettingsOpen(false);
    else if (detailOpen && selected?.surface) setDetailOpen(false);
    else if (selected?.surface && pageBack.current) pageBack.current();
    else if (selected && !wide) {
      detailGeneration.current += 1;
      setSelected(undefined);
    } else if (marketDetail && !wide) market.closeDetail();
    else goBackGuarded(router);
  }, [detailOpen, readmeOpen, settingsOpen, selected, wide, router, marketDetail, market.closeDetail]);
  // The introduction belongs to one plugin's detail page.
  useEffect(() => setReadmeOpen(false), [selected?.row.key, detailOpen]);
  useEffect(() => {
    if (!focused || (!selected && !marketDetail) || wide) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => listener.remove();
  }, [focused, selected, marketDetail, wide, goBack]);
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
  // A device can remain in the picker without having returned a plugin list.
  const androidDirectoryUnconfirmed =
    Platform.OS === "android" &&
    !scopedItems.length &&
    targets.some(
      (host) => (!deviceId || host.deviceId === deviceId) && !list.isOnline(host),
    );
  const androidDirectoryLoading =
    directoryLoading || (androidDirectoryUnconfirmed && list.syncing);
  const androidListFailed =
    listFailed || (androidDirectoryUnconfirmed && !androidDirectoryLoading);
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
    market.closeDetail();
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
    // A read of this instance's detail is issued (the person opened it, or the page brings the one it shows up to date):
    // it shows what a result proven for that very instance left, so such a result counts as seen from here on.
    detailReads.current += 1;
    seenOnDetail(row);
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
      !toggleToken.current &&
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
    market.closeDetail();
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
  // Unfinished operations (maintainer reviews 17:43, 18:45): every computer's slot holder and every pending check, one
  // line per operation, in a notice at the top while any is open. Only the line of the installed detail on screen is
  // left out (that detail shows its own operation). "View" opens their list, drawn from what each kept, never from
  // the directory or the market (PluginPendingChecksSheet).
  const targetOnline = (id: string) => { const host = targets.find((candidate) => candidate.deviceId === id); return !!host && list.isOnline(host); };
  const checks = usePluginPendingChecks(targetOnline, focused, targets.map((candidate) => candidate.deviceId));
  const conclusions = usePluginCheckConclusions();
  // What the results are now, also for a caller kept from an earlier render (a write that finishes later reads the
  // detail again with the `showDetail` of the press that started it).
  const conclusionsNow = useRef(conclusions);
  conclusionsNow.current = conclusions;
  const [checksOpen, setChecksOpen] = useState(false);
  const operationLines: PluginOperationLine[] = [
    ...checks.map((check) => ({ key: check.operationId, entry: check.entry, who: check.who, check })),
    ...holders.filter((token) => !checks.some((check) => samePluginSlotHolder(check.who, token.who)))
      .map((token) => ({ key: "slot:" + token.id, entry: token.entry, who: token.who })),
    // A success the person has not been shown yet (maintainer review 03:52): its read of the computer is out or failed,
    // or it settled with nobody there to show it. Listed until it is shown (opened, or seen in the list of checks).
    ...conclusions.filter((item) => pluginConclusionListed(item) && !checks.some((check) => check.operationId === item.operationId))
      .map((item) => ({ key: item.operationId, entry: item.entry, who: item.who, concluded: item.readback })),
  ];
  // Every line, also the one of the plugin on screen (dispatcher N-2: the page went unavailable with nothing saying why).
  const noticeLines = operationLines;
  const lone = noticeLines.length === 1 ? noticeLines[0] : undefined;
  // What each line is: settled (its result is known and nobody has looked at it yet), waiting (needs checking: a pending
  // check whose lookups stopped, a success whose read failed), or still under way (also a success being read).
  const settledLine = (line: PluginOperationLine) => !!line.concluded && line.concluded !== "failed" && line.concluded !== "pending";
  const waitingLine = (line: PluginOperationLine) => line.concluded === "failed"
    || (!!line.check && (line.check.waiting || line.check.state.outcome === "unknown"));
  const loneWaits = !!lone && waitingLine(lone);
  const loneSettled = !!lone && settledLine(lone);
  // Several: "aren't finished" only while every one is still under way, "have a result" only when every one has;
  // any other mix says they need a look.
  const manyTitle = noticeLines.every(settledLine) ? "plugins.checks.settledMany"
    : noticeLines.some((line) => settledLine(line) || waitingLine(line)) ? "plugins.checks.attentionMany" : "plugins.checks.many";
  const holderNoticeProps: PluginNoticeProps | undefined = noticeLines.length ? {
    testID: "plugins.slotHolder", icon: "info", compact: true,
    title: !lone ? t(manyTitle, { count: noticeLines.length })
      : t(loneWaits ? "plugins.checks.waitingOne" : loneSettled ? "plugins.checks.settledOne" : "plugins.slot.holder", { name: lone.who.name, device: lone.who.deviceName }),
    actions: [{ label: t("plugins.slot.show"), testID: "plugins.slotHolder.show", onPress: () => setChecksOpen(true) }],
    // Anywhere on it opens the list (dispatcher P-2: at the largest text sizes its button can sit off screen).
    onPress: () => setChecksOpen(true),
  } : undefined;
  // Wide screens (both platforms) and Android: above both panes. A narrow iOS screen: as the first row of the native
  // list on screen (`pageNotice`), where the navigation bar and the search field never cover it (dispatcher M-1).
  const noticeInList = Platform.OS === "ios" && !wide;
  const holderNotice = holderNoticeProps && !noticeInList ? (
    <View style={[styles.holderNotice, wide && styles.holderNoticeWide]}>
      <PluginNotice {...holderNoticeProps} />
    </View>
  ) : null;
  const pageNotice = noticeInList ? holderNoticeProps : undefined;
  const showInstalled = !!query.trim() || segment === "installed";
  const showMarket = !!query.trim() || segment === "market";
  const installedDirectory = (
    <>
      {androidDirectoryLoading && !items.length ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : null}
      <View style={styles.inline}>
        <Text style={[styles.groupLabel, { flex: 1 }]}>
          {t("plugins.installed")}
        </Text>
      </View>
      <View style={styles.groupCard}>{items.map(renderRow)}</View>
      {!androidDirectoryLoading && !androidListFailed && !items.length ? (
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
      {androidListFailed ? (
        <View>
          <Text style={styles.note}>
            {t(
              items.length
                ? "plugins.listUnavailable"
                : "plugins.listLoadFailed",
            )}
          </Text>
          {!items.length && !androidDirectoryLoading ? (
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
    </>
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
          segment={segment}
          onSegmentChange={setSegment}
          market={marketView}
          pageNotice={pageNotice}
        />
      </View>
    ) : (
      <View style={[styles.directory, wide && styles.sidebar]}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEventThrottle={200}
          onScroll={({ nativeEvent: n }) => {
            // Page the market when the end of the list comes into view.
            if (showMarket && n.layoutMeasurement.height + n.contentOffset.y >= n.contentSize.height - 240)
              market.loadMore();
          }}
          refreshControl={
            <RefreshControl
              refreshing={
                (showInstalled && list.refreshing) ||
                (showMarket && market.refreshing)
              }
              onRefresh={() => {
                if (showInstalled) void refreshDirectory();
                if (showMarket) void marketView.refresh();
              }}
              tintColor={colors.textSecondary}
            />
          }
        >
          <View style={styles.controls}>
            {showInstalled ? (
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
            ) : null}
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
            {!query.trim() ? (
              <FileBrowserSegmentedControl
                accessibilityLabel={t("plugins.market.segmentsLabel")}
                testID="plugins.segment"
                value={segment}
                onChange={(next) =>
                  setSegment(next === "market" ? "market" : "installed")
                }
                options={[
                  { value: "installed", label: t("plugins.installed") },
                  { value: "market", label: t("plugins.market.title") },
                ]}
              />
            ) : null}
          </View>
          {showInstalled ? installedDirectory : null}
          {showMarket ? (
            <PluginMarketSection
              market={marketView}
              onConnectComputer={() => router.push("/devices/manage")}
            />
          ) : null}
        </ScrollView>
      </View>
    );
  const enable = async (enabled: boolean) => {
    if (!selected || !detail || !list.isOnline(selected.row.host)) return;
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
    // The slot decides: a second tap, or a tap while another entry holds it, does nothing.
    const token = slot.tryAcquire("enable", slotHolderOf(row));
    if (!token) return;
    toggleToken.current = token;
    setBusy(true);
    try {
      await invokePlugin(invoke, row.host.deviceId, row.item.ref.id, actionId);
    } catch {
      if (current()) tell("plugins.notice.title.managementFailed", "plugins.actionFailed");
    } finally {
      // A failed reply may follow an applied write; confirm by reading, never replaying it.
      if (current()) await showDetail(row);
      if (toggleToken.current === token) toggleToken.current = null;
      slot.release(token);
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
  // "Open" from the list of checks (dispatcher L-3): only the instance the list's own read found, and only on that
  // computer: one no longer listed for this account cannot be opened (the panel says so instead).
  const knownTarget = (deviceId: string) => targets.some((candidate) => candidate.deviceId === deviceId);
  const openInstalled = (who: PluginSlotHolder, instanceKey: string): boolean => {
    const host = targets.find((candidate) => candidate.deviceId === who.deviceId);
    if (!host) return false;
    setChecksOpen(false);
    void showDetail({ key: JSON.stringify([who.deviceId, "plugins", "plugin", instanceKey]), host,
      item: { ref: { collectionId: "plugins", kind: "plugin", id: instanceKey }, revision: "", links: [], display: { title: who.name } } } as HostedRemoteCollectionItem);
    return true;
  };
  // "Open plugin" in the list of checks opens in the press itself, with nothing awaited in between: the instance the
  // line shows as proven, on a computer listed now. (Pre-push review, round 5: reading first and opening when the read
  // came back moved the page after the press, by which time another operation's consent could be up, the computer gone
  // from the list, or the app in the background.) The list keeps what it shows current instead: a success proven
  // before the list was opened is read again when it opens, and has no "Open plugin" until that read is back
  // (PluginPendingChecksSheet).
  // (A second press in the same frame, before the list is gone, opens nothing again: a synchronous ref, as for Install.)
  const openedFromList = useRef(false);
  /** Per result: the installed-list token a newer read overruled (`list token|proven token`). */
  const staleListToken = useRef(new Map<string, string>());
  if (!checksOpen) openedFromList.current = false;
  const openChecked = (operationId: string) => {
    const proven = conclusions.find((item) => item.operationId === operationId);
    if (openedFromList.current || proven?.readback !== "verified" || !proven.instanceKey) return;
    // The installed list says that instance is another install now (its approval token, same key; maintainer review
    // 14:25 #1): nothing opens; the record reads it again (no page change when that read comes back).
    // A list row older than the proving read (restored from cache, or its refresh not back yet) is overruled once a read
    // issued after that press proves the same install again: the next press opens.
    const now = list.items.find((row) => row.host.deviceId === proven.who.deviceId && row.item.ref.id === proven.instanceKey);
    const token = installedApprovalToken(now?.item.revision);
    if (token !== undefined && proven.approvalToken !== undefined && token !== proven.approvalToken
      && staleListToken.current.get(operationId) !== `${token}|${proven.approvalToken}`) {
      void retryPluginCheckReadback(operationId).then((reread) => {
        if (reread?.readback === "verified" && reread.approvalToken === proven.approvalToken)
          staleListToken.current.set(operationId, `${token}|${proven.approvalToken}`);
      });
      return;
    }
    if (!openInstalled(proven.who, proven.instanceKey)) return;
    openedFromList.current = true;
    tellPluginConclusion(operationId);
  };
  // The page never moves, and prompts nothing, for a result (pre-push review 2026-11-26, four rounds: every way of
  // opening or announcing a result by itself took the person away from something, and leaving a consent cancels it).
  // However an operation ended, its result is listed at the top; the person opens it from "Open plugin" in the list of
  // checks. Here only the installed list is read again, once per operation, so it shows what the result says.
  const refreshedFor = useRef<Set<string> | undefined>(undefined);
  refreshedFor.current ??= new Set(conclusions.map((item) => item.operationId));
  useEffect(() => {
    for (const conclusion of conclusions) {
      if (refreshedFor.current!.has(conclusion.operationId)) continue;
      refreshedFor.current!.add(conclusion.operationId);
      // The installed detail reads the list again itself for its own operations.
      if (conclusion.entry === "market-install" || !conclusion.shown) void list.refresh();
    }
  }, [conclusions]);
  // "View and decide" (dispatcher L-2): a consent a lookup found that this phone never showed opens in the same
  // confirmation sheet, after its operation took its computer's slot; while it is open the check counts as shown.
  const [deciding, setDeciding] = useState<string | null>(null);
  const decidingCheck = deciding ? checks.find((check) => check.operationId === deciding) : undefined;
  useEffect(() => {
    if (!decidingCheck) { if (deciding) setDeciding(null); return; }
    return decidingCheck.view();
  }, [decidingCheck?.operationId]);
  useEffect(() => {
    // The sheet goes once the consent is no longer what the computer shows (answered, a final result, or unknown for
    // now: the computer dropped, the app was in the background). That is not the person leaving a consent: the
    // controller no longer counts it as shown then, so the same consent found again is read-only in the list
    // ("View and decide") and nothing cancels it.
    if (decidingCheck && decidingCheck.state.outcome !== "confirmation" && !decidingCheck.state.busy) setDeciding(null);
  }, [decidingCheck?.state.outcome, decidingCheck?.state.busy]);
  // DEV visual mock only: cindy://plugins?checks=<state> opens the list of pending checks in that state.
  useEffect(() => {
    if (!checksPreview || !pluginVisualDemosEnabled()) return;
    let live = true;
    void seedPluginChecksForVisualMock(checksPreview).then((after) => {
      if (!live || !after) return;
      setChecksOpen(true);
      setTimeout(() => { if (live) after(); }, 400);
    });
    return () => { live = false; };
  }, [checksPreview]);
  const decide = (operationId: string) => {
    const check = checks.find((item) => item.operationId === operationId);
    if (!check || !check.decide()) return false;
    setChecksOpen(false);
    setDeciding(operationId);
    return true;
  };
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
      if (!current() || state.outcome !== "failed" || state.operationId) return;
      // The controller's last detail read before begin: a source not named (refresh or update on the computer) is
      // told apart from a source that really changed.
      if (state.errorCode === "PLUGIN_SOURCE_UNVERIFIED") tell("plugins.management.sourceUnverifiedTitle", "plugins.management.sourceUnverified");
      else if (state.errorCode === "PLUGIN_SOURCE_CHANGED") tell("plugins.management.sourceChangedTitle", "plugins.management.sourceChanged");
      else if (state.errorCode === "PLUGIN_CONSENT_CHANGED") tell("plugins.notice.title.managementFailed", "plugins.notice.consentSource.consentChanged");
      else tell("plugins.notice.title.managementFailed");
    };
    if (action === "uninstall" && managed) {
      const plugin = managed;
      if (!slot.available(slotHolderOf(row, plugin.manifest.name))) return;
      void prompt({
        title: t("plugins.management.uninstallTitle", { name: plugin.manifest.name }),
        message: t("plugins.management.uninstallBody", { device: row.host.deviceName }),
        cancelLabel: t("plugins.cancel"),
        confirmLabel: t("plugins.management.uninstall"),
        destructive: true,
        cancelable: true,
        // Taken in the tap that confirms (the prompt itself sends nothing), so no other entry can start in that frame.
        onConfirm: () => {
          if (!current()) return;
          const token = slot.tryAcquire("uninstall", slotHolderOf(row, plugin.manifest.name));
          if (token) void controller.uninstall(plugin, pluginOperationHold(slot, token)).then(reportPreflightFailure);
        },
      });
    } else if (action === "update" && marketItem && managed) {
      const displayed = marketItem;
      // The slot is taken now, before the preparing read: another entry pressed in the same frame cannot start.
      const token = slot.tryAcquire("update", slotHolderOf(row, managed.manifest.name));
      if (!token) return;
      const hold = pluginOperationHold(slot, token);
      let handedOver = false;
      const updateCurrent = () => current() && hold.guard();
      try {
        const client = createPluginManagementClient({
          invoke,
          deviceId: row.host.deviceId,
          isCurrent: updateCurrent,
        });
        const next = await client.detail(displayed.pluginId);
        if (!updateCurrent()) return;
        if (next.releaseId !== displayed.releaseId) {
          await controller.refresh();
          if (current()) tell("plugins.management.releaseChangedTitle", "plugins.management.releaseChanged");
          return;
        }
        if (next.sourceType !== "server") {
          // No source named (older Host, or a Git market not refreshed since the Host was updated): the consent could
          // not be tied to a source, so the update continues on the computer.
          if (!next.sourceIdentity) { tell("plugins.management.sourceUnverifiedTitle", "plugins.management.sourceUnverified"); return; }
          // The plugin's market now points to another source than the one listed here: not the same update.
          if (displayed.sourceIdentity && !samePluginMarketSourceIdentity(next.sourceIdentity, displayed.sourceIdentity)) {
            await controller.refresh();
            if (current()) tell("plugins.management.sourceChangedTitle", "plugins.management.sourceChanged");
            return;
          }
        }
        // From here the controller holds the slot for this update and releases it when the update is over.
        handedOver = true;
        await controller.install(next, managed, hold);
        reportPreflightFailure();
      } catch {
        if (current()) tell("plugins.management.state.readFailedTitle", "plugins.management.state.readFailed");
      } finally {
        if (!handedOver) hold.onSettled();
      }
    }
  };
  const managementActions = [
    ...(marketItem?.installState === "update-available" && managed
      ? [
          {
            id: "update",
            // The computer's own label for this action ("Update to v1.4.2").
            title: t("plugins.management.updateTo", { version: marketItem.version }),
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
  /**
   * Operations whose detail was read again on its own read after the result: seen as soon as the result is proven,
   * whichever comes first (here when it already is; the effect on `conclusions` below when it is proven later).
   */
  const broughtUpToDate = useRef(new Set<string>());
  const detailUpToDateFor = (operationId: string) => {
    broughtUpToDate.current.add(operationId);
    const proven = conclusionsNow.current.find((conclusion) => conclusion.operationId === operationId);
    if (proven && !proven.told && proven.readback === "verified") tellPluginConclusion(operationId);
  };
  const seenOnDetail = (row: HostedRemoteCollectionItem) => {
    for (const conclusion of conclusionsNow.current) {
      if (conclusion.told || conclusion.readback !== "verified" || (conclusion.result !== "succeeded" && conclusion.result !== "installed")) continue;
      // The instance it is about: the one an update or approval started from; for an install, the one its read proved.
      const about = conclusion.entry === "update" || conclusion.entry === "page-approval" ? conclusion.who.instanceKey : conclusion.instanceKey;
      if (conclusion.who.deviceId === row.host.deviceId && about === row.item.ref.id) tellPluginConclusion(conclusion.operationId);
    }
  };
  const completedOperation = useRef<{ operationId: string; row?: HostedRemoteCollectionItem; generation: number;
    /** How many detail reads had been issued when the result was first known here. */
    reads: number; owner: ReturnType<typeof getMobileAuthOwner>; settled: boolean } | undefined>(undefined);
  useEffect(() => {
    const state = management.state, controller = management.controller;
    if (!state || state.outcome !== "succeeded" || !state.operationId || !controller) return;
    if (completedOperation.current?.operationId !== state.operationId) {
      const row = selected?.row;
      completedOperation.current = { operationId: state.operationId, row, generation: detailGeneration.current,
        reads: detailReads.current, owner: getMobileAuthOwner(), settled: false };
      void list.refresh();
      // The market beside it (wide screen) or on the next visit must not keep that computer's old pages and counts.
      if (row) market.invalidate(row.host.deviceId);
    }
    // The detail on screen is brought up to date once, on the controller's snapshot read after the result (its
    // `finalReadback`, settled where a snapshot is published): the instance shown is read again, or the detail closes
    // when it is gone (an uninstall). Only this detail's display: what an update or a page approval concluded (proven
    // as this operation's, or why not) is the list's one read of the success. While the snapshot read is out nothing
    // happens; a failed one leaves the detail as it is (as before this operation; the result is listed at the top).
    const done = completedOperation.current!;
    if (done.settled || state.finalReadback !== "read") return;
    done.settled = true;
    const { row, generation, owner } = done;
    if (!row || liveManagement.current !== controller || !isMobileAuthOwnerCurrent(owner)) return;
    if (generation !== detailGeneration.current) {
      // The selection moved on since the result was known. When a detail read was issued since (the person, a reconnect)
      // and the same detail is the one selected, that read was this one: nothing more to read. (Opening the plugin's
      // own page moves the selection on without reading the detail.)
      if (detailReads.current !== done.reads && selected?.row.key === row.key) detailUpToDateFor(done.operationId);
      return;
    }
    const refreshed = controller.getState();
    if (!refreshed.online) return;
    const snapshot = refreshed.snapshot;
    const viewed = snapshot?.ghosts.find(
      (item) => item.instanceKey === row.item.ref.id,
    );
    // Read again only while this detail is what is shown: from the plugin's own page (the person went back to it
    // meanwhile) nothing is put over it; its details button reads the detail when it is shown again.
    if (viewed) {
      if (!selected?.surface || detailOpen) { detailUpToDateFor(done.operationId); void showDetail(row); }
    } else if (snapshot) {
      detailGeneration.current += 1;
      setSelected(undefined);
      setDetail(undefined);
    }
  }, [management.state?.outcome, management.state?.operationId, management.state?.finalReadback]);
  // When a result counts as seen without the list of checks: only a success proven by its read (never one that is not
  // proven: another install since, an older computer, no instance now, not confirmed after its receipt was gone), and
  // only through the installed detail of that very instance: the page issues a read of that detail while the result is
  // already proven (`seenOnDetail`, called by every such read: the person opened the detail, pressed its details
  // button or "Open plugin", or the page reads the one it shows again), or the detail an operation was started from was
  // brought up to date by its own read after the result (above) and the result is proven after that (here). Nothing is
  // opened, replaced or prompted for it, and the page keeps no other account of what a detail reflects: a detail left
  // as it was (its read after the operation did not land) stays so until it is read again, with the result listed.
  useEffect(() => {
    for (const conclusion of conclusions) {
      if (!conclusion.told && conclusion.readback === "verified" && broughtUpToDate.current.has(conclusion.operationId))
        tellPluginConclusion(conclusion.operationId);
    }
  }, [conclusions]);
  const failedOperationNotice = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = management.state;
    if (!focused || !selected || state?.outcome !== "failed" || !state.operationId) return;
    const key = JSON.stringify([selected.row.key, auth.accountGeneration, connectionEpoch, state.operationId]);
    if (failedOperationNotice.current === key) return;
    failedOperationNotice.current = key;
    tell("plugins.notice.title.managementFailed");
  }, [management.state?.outcome, management.state?.operationId, selected?.row.key, focused, auth.accountGeneration, connectionEpoch]);
  /**
   * "Go to Installed" (an older computer's result, V2.10 ③; maintainer review 03:52): back to the directory the way its
   * back step goes (the readme, settings, the installed detail and the market detail close; an installed detail's late
   * reads are fenced), on the record's computer, in the installed segment. Nothing particular opens.
   */
  const showInstalledOf = (who: { deviceId: string }) => {
    // Its computer left this account's list: nothing to go to (the list of checks offers no entry then).
    if (!knownTarget(who.deviceId)) return;
    setChecksOpen(false);
    // A search typed earlier would filter the installed list (the plugin may not match it); the native search field
    // (iOS) is cleared with it.
    setQuery("");
    searchBar.current?.setText("");
    setReadmeOpen(false);
    setSettingsOpen(false);
    if (selected) {
      detailGeneration.current += 1;
      setSelected(undefined);
      setDetail(undefined);
    }
    if (market.detail) market.closeDetail();
    if (targets.some((host) => host.deviceId === who.deviceId)) setDeviceId(who.deviceId);
    setSegment("installed");
  };
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
      // Not reached from the status row today: it offers only "connect" and "retry" (main's existing choice, both
      // platforms); kept for when a settings action is offered there (dispatcher Q-2, follow-up outside #12684).
      case "reconnect":
      case "settings":
        if (originalSettings) setSettingsOpen(true);
        else tell("plugins.detail.computerSettingsTitle", "plugins.detail.computerSettings");
        break;
    }
  };
  const noticeOwner = getMobileAuthOwner();
  const originalSettingsContent = selected && originalSettings && managed ? (
    <PluginOriginalSettings
      key={JSON.stringify([selected.row.host.deviceId, managed.instanceKey, pluginApprovalToken(managed), connectionEpoch])}
      identity={{
        deviceId: selected.row.host.deviceId,
        instanceId: managed.instanceKey,
        expectedInstalledApproval: pluginApprovalToken(managed),
      }}
      active={focused && online && detailOpen && !managementPending && !holder}
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
  ) : undefined;
  const taskSettingsAvailable = model?.taskPreferences && managed?.approval.state === "approved" &&
    managed.enabled && enabled && online && focused && detailOpen && !busy &&
    managementReady && (!holder || holder.entry === "task-settings") && !detailLoading && !detailFailed;
  const detailView =
    selected && model ? (
      <PluginDetailView
        row={selected.row}
        enabled={enabled}
        busy={busy || detailLoading || !!holder || managementPending}
        statusRecoveryBusy={busy || detailLoading}
        pageNotice={pageNotice}
        uiApprovalNotice={pluginUiApprovalNotice(managed, management.state, management.controller, t, false,
          { slot, who: slotHolderOf(selected.row, managed?.manifest.name) })}
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
          originalSettingsContent || (taskSettingsAvailable && managed) ? (
            <View style={{ gap: spacing.lg }}>
              {taskSettingsAvailable && managed ? (
                <PluginTaskSettings
                  key={JSON.stringify(["tasks", selected.row.host.deviceId, managed.instanceKey, pluginApprovalToken(managed), connectionEpoch])}
                  deviceId={selected.row.host.deviceId}
                  pluginId={managed.instanceKey}
                  holder={slotHolderOf(selected.row, managed.manifest.name)}
                />
              ) : null}
              {originalSettingsContent}
            </View>
          ) : undefined
        }
        settingsOpen={settingsOpen}
        onEnabledChange={(value) => {
          if (model.canToggle) void enable(value);
        }}
        onOpen={(surface) => open(selected.row, surface)}
        onOpenReadme={model.readme ? () => setReadmeOpen(true) : undefined}
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
            ? (readmeOpen && t("plugins.detail.readme")) ||
              (settingsOpen && t("plugins.settings")) ||
              (!detailOpen && selected.surface && pageTitle) ||
              text(selected.row.item.display.title)
            : marketDetail && !wide
              ? marketDetail.item.name
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
      {market.confirmation ? (
        <PluginManagementConfirmation
          key={JSON.stringify([
            "market",
            auth.accountGeneration,
            connectionEpoch,
          ])}
          state={market.confirmation.state}
          controller={market.confirmation.controller}
          deviceName={market.confirmation.deviceName}
          active={focused && market.confirmation.state.online}
        />
      ) : null}
      {/* Above both panes (a row on wide screens): one line across, never a column of its own. */}
      {holderNotice}
      {promptDialog}
      {/* Not while the installed detail's own sheet shows the same operation's consent (one sheet for one consent). */}
      {decidingCheck && !(selected && detailOpen && focused && online && management.controller === decidingCheck.controller) ? (
        <PluginManagementConfirmation
          key={JSON.stringify(["check", decidingCheck.operationId, auth.accountGeneration, connectionEpoch])}
          state={decidingCheck.state}
          controller={decidingCheck.controller}
          deviceName={decidingCheck.who.deviceName}
          active={focused && decidingCheck.state.online}
        />
      ) : null}
      <PluginPendingChecksSheet visible={checksOpen} lines={operationLines} conclusions={conclusions} isOnline={targetOnline}
        canOpen={knownTarget} onDecide={decide}
        onClose={() => setChecksOpen(false)} onOpenChecked={openChecked}
        // An older computer's result (V2.10 ③): the installed list, where the person opens the plugin themselves.
        onShowInstalled={showInstalledOf} />
      <View style={styles.layout}>
        {wide || (!selected && !marketDetail) ? directory : null}
        {wide || selected || marketDetail ? (
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
            {!selected?.surface || detailOpen
              ? readmeOpen && selected
                ? (
                    <PluginReadmePage
                      key={selected.row.key}
                      deviceId={selected.row.host.deviceId}
                      pluginId={selected.row.item.ref.id}
                    />
                  )
                : marketDetail
                  ? (
                      <PluginMarketDetailView
                        key={marketDetail.item.pluginId}
                        detail={marketDetail}
                        market={marketView}
                        pageNotice={pageNotice}
                      />
                    )
                  : detailView
              : null}
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
    holderNotice: { paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.sm },
    // Wide screens: as wide as the directory column's content, at the start, so it reads with the list it explains.
    holderNoticeWide: { maxWidth: 560 },
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
