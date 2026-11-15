import { deviceDisplayName } from "@/device-link/deviceName";
import { foldDesktopLayout, foldDesktopRegion } from "./foldDesktopLayout";
import { useAdaptiveWindow } from "@/platform/AdaptiveWindowContext";
import { controlRegion } from "@/platform/windowGeometry";
import { FoldDesktopKeyboard } from "./FoldDesktopKeyboard";
import { RemoteKeySurface, type SystemKeyAction } from "./RemoteKeySurface";
import {
  AllWindowsIcon,
  OmarchyMenuIcon,
  PostureClosedIcon,
  PostureFlatIcon,
  PostureOpenIcon,
  ShowDesktopIcon,
  WorkspaceLeftIcon,
  WorkspaceRightIcon,
} from "./RemoteDesktopIcons";
import { FoldTouchpad } from "./FoldTouchpad";
import {
  FoldDesktopBezel,
  FoldDesktopDeck,
  FoldDesktopSkinSwitch,
  retroDesktopViewport,
  foldDesktopSkinColors,
} from "./FoldDesktopSkin";
import { useFoldSkinPreference } from "./useFoldSkinPreference";
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  AppState,
  Alert,
  ActivityIndicator,
  Dimensions,
  StatusBar,
  Keyboard,
  KeyboardAvoidingView,
  type KeyboardEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated from "react-native-reanimated";
import {
  ChevronDown,
  Keyboard as KeyboardIcon,
  Languages,
  LayoutGrid,
  Monitor,
  Smartphone,
  Search,
  type LucideIcon,
} from "lucide-react-native";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import { motionDuration } from "@/theme/tokens";
import {
  Stack,
  useLocalSearchParams,
  useRouter,
  useIsFocused,
} from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { connectionDiagnostics } from "./connectionDiagnostics";
import { fittedDisplayModes } from "./fittedDisplayModes";
import { controlFailureAction, remoteDesktopErrorCode } from "./controlFailure";
import { transferClipboardContent } from "./clipboardTransfer";
import * as Clipboard from "expo-clipboard";
import { RemoteDesktopClipboardButton } from "./RemoteDesktopClipboardButton";
import { RemoteDesktopMouseControls } from "./RemoteDesktopMouseControls";
import { useTranslation } from "react-i18next";
import {
  RemoteDesktopViewerSession,
  REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS,
  viewerDisplaySize,
  RemoteDesktopViewerMedia,
  remoteDesktopFailureKey,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  REMOTE_DESKTOP_NETWORK,
  REMOTE_DESKTOP_ICE_SERVERS,
  isRemoteDesktopCursor,
  type RemoteDesktopCursor,
  REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS,
  isDesktopInput,
  type DesktopInput,
  type RemoteDesktopCapabilities,
  type RemoteDesktopLease,
  type RemoteDesktopRequest,
  type RemoteDesktopVideoSettings,
  type RemoteDesktopDisplayMode,
  isRemoteDesktopChannelRequest,
  parseRemoteDesktopChannelReply,
  REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS,
} from "@cindy/device-link";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { BACKGROUND_TRANSITION_TIMEOUT_MS } from "@/device-link/backgroundConnection";
import { useAuth } from "@/auth/AuthContext";
import { DEVICE_LINK_API_BASE_URL } from "@/config/env";
import {
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
  resolveDesktopIceServers,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { ErrorNotice } from "@/components/ErrorNotice";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";
import { useScreenEdgePadding } from "@/components/screenEdgeInsets";
import { goBackGuarded } from "@/utils/backGuard";
import { mobileDebugEnabled, mobileDebugLog } from "@/debug/mobileDebugLog";
import {
  RTC_DIAGNOSTIC_REVISION,
  rtcDiagnosticSummary,
} from "./rtcDiagnostics";
import {
  fontWeight,
  darkColors,
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
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";
import { remoteDesktopViewerHtml } from "./viewerHtml";
import {
  NativeRemoteDesktopView,
  nativeMediaCommands,
  type NativeRemoteDesktopHandle,
} from "./NativeRemoteDesktopView";
import { useMouseButtonsPreference } from "./useMouseButtonsPreference";
import { useInputModePreference } from "./useInputModePreference";
import { useAutoUnlockSettings } from "./useAutoUnlockSettings";
import { supportsAutoUnlock } from "./autoUnlockSupport";
import {
  useLockOnExitPreference,
  useIdleTimeoutPreference,
} from "./useLockOnExitPreference";
import { useRemoteDesktopSafety } from "./useRemoteDesktopSafety";
import { useVideoSettingsPreference } from "./useVideoSettingsPreference";
import { usePictureInPicturePreference } from "./usePictureInPicturePreference";
import { LiveScreenSettings } from "./LiveScreenSettings";
import { PermissionGuide } from "./PermissionGuide";
import { navigationChrome } from "@/theme/tokens";
import { RemoteDesktopBackButton } from "./RemoteDesktopBackButton";
import { RemoteDesktopWindows } from "./RemoteDesktopWindows";
import { RemoteDesktopNetworkStatus } from "./RemoteDesktopNetworkStatus";
import type { DesktopNetworkStats } from "./networkStats";
import {
  findRememberedMode,
  readRememberedResolution,
  rememberResolution,
} from "./resolutionMemory";
import {
  RemoteDesktopControls,
  RemoteDesktopDisconnect,
} from "./RemoteDesktopControls";
import {
  RemoteDesktopPanel,
  RemoteDesktopToolbar,
} from "./RemoteDesktopChrome";
import type { RemoteDesktopDeviceButton } from "./RemoteDesktopChrome";
import {
  LIVE_SCREEN_ICONS,
  LIVE_SCREEN_NOT_IN_MENU,
  LIVE_SCREEN_POSTURES,
  LIVE_SCREEN_TOOLBAR_BUTTONS,
  parseLiveScreenParam,
} from "./liveScreen";
import {
  LiveScreenControls,
  type LiveScreenAction,
  type LiveScreenPicture,
} from "./LiveScreenControls";

type Mode = "pointer" | "touch" | "pan";
/** How a data-channel request ended; "relay" means it was never executed. */
type ChannelOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "relay" }
  | { kind: "error"; code: string };
const KEY_BAR_HEIGHT = 44;
/** The desktop viewer's posture glyphs, by the plugin's button id. */
const POSTURE_ICONS: Record<string, LucideIcon> = {
  "posture-closed": PostureClosedIcon,
  "posture-open": PostureOpenIcon,
  "posture-flat": PostureFlatIcon,
};
const LABELS: Record<string, string> = {
  Minus: "− _",
  Equal: "= +",
  BracketLeft: "[ {",
  BracketRight: "] }",
  Backslash: "\\ |",
  Semicolon: "; :",
  Quote: "' \"",
  Comma: ", <",
  Period: ". >",
  Slash: "/ ?",
  Backquote: "` ~",
  Backspace: "⌫",
  Escape: "Esc",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ControlLeft: "Ctrl",
  AltLeft: "Alt",
  ShiftLeft: "Shift",
  MetaLeft: "Meta",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

export default function RemoteDesktopScreen() {
  const {
    deviceId: rawId,
    deviceName: rawName,
    handoff: rawHandoff,
    liveScreen: rawScreen,
  } = useLocalSearchParams<{
    deviceId: string;
    deviceName?: string;
    handoff?: string;
    liveScreen?: string;
  }>();
  const deviceId = typeof rawId === "string" ? rawId : "";
  const deviceName = deviceDisplayName(
    deviceId,
    typeof rawName === "string" ? rawName : undefined,
  );
  const handoff =
    typeof rawHandoff === "string" && rawHandoff ? rawHandoff : undefined;
  const router = useRouter();
  const focused = useIsFocused();
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
          gestureEnabled: false,
          statusBarHidden: true,
        }}
      />
      <RemoteDesktopSession
        deviceId={deviceId}
        deviceName={deviceName}
        handoff={handoff}
        screen={typeof rawScreen === "string" ? rawScreen : undefined}
        focused={focused}
        onBack={() => goBackGuarded(router)}
      />
    </>
  );
}

export function RemoteDesktopSession({
  deviceId,
  deviceName,
  handoff,
  screen: screenParam,
  focused,
  onBack,
  onRestore,
  onVisibility,
  onEnded,
}: {
  deviceId: string;
  deviceName: string;
  /** 代输入 live view: only the window this waiting request is about (the host picks it). */
  handoff?: string;
  /** A plugin live screen (`plugin|id`) from the host's list, such as a simulator. */
  screen?: string;
  focused: boolean;
  onBack(): void;
  onRestore?(): void;
  onVisibility?(visible: boolean): void;
  onEnded?(): void;
}) {
  const auth = useAuth();
  const screenTarget = parseLiveScreenParam(screenParam);
  const screenPlugin = screenTarget?.plugin;
  const screenId = screenTarget?.id;
  const navigation = useRef({ onBack, onRestore, onVisibility, onEnded });
  navigation.current = { onBack, onRestore, onVisibility, onEnded };
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const link = useDeviceLink();
  const [hostCaps, setHostCaps] = useState<{
    deviceId: string;
    value: RemoteDesktopCapabilities;
  } | null>(null);
  const caps = hostCaps?.deviceId === deviceId ? hostCaps.value : null;
  const capsRef = useRef(hostCaps);
  const security = useAutoUnlockSettings(deviceId, focused, () =>
    capsRef.current?.deviceId === deviceId
      ? capsRef.current.value.platform
      : undefined,
  );
  const securityRef = useRef(security);
  securityRef.current = security;
  // Display changes stop host input, so they wait for the unlock attempt.
  const unlockAttempt = useRef<Promise<void>>(Promise.resolve());
  // A remembered fitted size waiting for this lease's viewport measurement.
  const rememberedFit = useRef<{ lease: string; edge: number } | null>(null);
  // Long edge of the size the phone last asked for. Rotation, folding and
  // appearance changes only re-derive the ratio, so a smaller or larger
  // choice from the resolution settings survives them.
  const fitEdge = useRef<number | null>(null);
  // The computer's own system mode for a lease, read before this phone changes
  // it. Choosing it again forgets the remembered resolution.
  const hostMode = useRef<{ lease: string; modeId?: string } | null>(null);
  const noteHostMode = (lease: string, modes: RemoteDesktopDisplayMode[]) => {
    if (hostMode.current?.lease !== lease)
      hostMode.current = {
        lease,
        modeId: modes.find((mode) => mode.current)?.id,
      };
  };
  // Assigned each render below; `connect` runs it before the first video offer.
  const applyRememberedDisplay = useRef(
    async (
      _lease: RemoteDesktopLease,
      _caps: RemoteDesktopCapabilities,
      _isCurrent: () => boolean,
    ) => false,
  );
  const [lockOnExit, setLockOnExit, lockOnExitLoaded] =
    useLockOnExitPreference(deviceId);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes, idleTimeoutLoaded] =
    useIdleTimeoutPreference(deviceId);
  const idleTimeoutPolicy = useRef(idleTimeoutMinutes);
  idleTimeoutPolicy.current = idleTimeoutMinutes;
  const exitLock = useRef(false);
  const leaving = useRef(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [exitLockPending, setExitLockPending] = useState(false);
  const linkRef = useRef(link);
  linkRef.current = link;
  const { t } = useTranslation();
  const { colors, mode: colorScheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const windowSize = useWindowDimensions();
  const edgePadding = useScreenEdgePadding({
    insets,
    windowWidth: windowSize.width,
    windowHeight: windowSize.height,
  });
  const screenSize = windowSize;
  const geometry = useAdaptiveWindow();
  const tableRegion = foldDesktopRegion(geometry);

  const systemSideRail =
    Platform.OS === "ios" &&
    !tableRegion &&
    (geometry.barEdge !== "none" ||
      (geometry.reservedRegionsSupported &&
        geometry.regularWidth &&
        windowSize.width > windowSize.height));
  // Android adjustResize shrinks the window for the IME, not the display.
  // Keep its device orientation stable; iOS/Duo still use the adaptive window.
  const orientationSize =
    Platform.OS === "android" ? Dimensions.get("screen") : windowSize;
  const landscape =
    systemSideRail ||
    (!tableRegion && orientationSize.width > orientationSize.height);
  const sideRailWidth = Math.max(60, geometry.insets.right + spacing.md);
  // The native status/navigation center sits 6pt inward from the safe strip center.
  // Use the reported status reservation for vertical clearance when available.
  const statusReservation = geometry.regions.filter(
    (r) =>
      r.kind === "occlusion" && r.y === 0 && r.x + r.width >= geometry.width,
  );
  const sideRailTop = Math.max(
    insets.top,
    statusReservation.length
      ? Math.max(...statusReservation.map((r) => r.y + r.height))
      : 120,
  );
  const [interfaceAngle, setInterfaceAngle] = useState<number | null>(null);
  const toolbarOnLeft = systemSideRail
    ? false
    : Platform.OS === "ios" &&
      landscape &&
      (interfaceAngle === 270 ||
        (interfaceAngle === null && insets.right > insets.left));
  const webview = useRef<ComponentRef<typeof WebView>>(null);
  const nativeViewer = useRef<NativeRemoteDesktopHandle>(null);
  // Memo survives ordinary renders, but Fast Refresh invalidates it when the
  // bundled viewer changes. A ref kept the old script alongside new RN layout.
  const html = useMemo(
    () =>
      remoteDesktopViewerHtml(
        colors.surface,
        colors.textPrimary,
        Boolean(NativeRemoteDesktopView),
      ),
    [],
  );
  const [viewerReadyRevision, setViewerReadyRevision] = useState(0);
  const active = useRef<RemoteDesktopLease | null>(null);
  // View only is a local guard against stray touches. The host keeps control
  // and its input helper, so switching never waits for the computer.
  const [viewOnlySelected, setViewOnlySelected] = useState(false);
  const viewOnlyRef = useRef(false);
  /** Input reaches the computer only with host control and outside view only. */
  const inputAllowed = (controlling: boolean) =>
    controlling && !viewOnlyRef.current;
  // Last control bit we asked the host for but have not confirmed. Overflow and
  // take-control can time out after the local bit already moved; heartbeats use
  // this to retry a release or restore local control instead of ignoring host-true.
  const pendingHostControl = useRef<boolean | null>(null);
  const controlInFlight = useRef(false);
  const controlRestoration = useRef<Promise<void> | null>(null);
  // A foreground event can arrive while control/settings are still settling.
  // Finish that restore as soon as the existing operation settles.
  const foregroundRestorePending = useRef(false);
  const finishBackgroundTransition = useRef<(() => void) | null>(null);
  const recovery = useRef({
    enabled: true,
    at: 0,
    delay: 1000,
    displayId: undefined as string | undefined,
    resuming: false,
    // The user returned after this viewer released its lease (foreground or
    // screen focus). Cleared once a lease starts; network retries never set it.
    returned: false,
  });
  const generation = useRef(0);
  const timing = useRef<ReturnType<typeof connectionDiagnostics> | null>(null);
  const alive = useRef(true);
  const connecting = useRef(false);
  const ready = useRef(false);
  const streaming = useRef(false);
  const mediaAttempt = useRef<string | null>(null);
  const receiveWindow = useRef({
    since: Date.now(),
    bytes: 0,
    frameMs: null as number | null,
    frameAt: 0,
  });
  const [network, setNetwork] = useState<DesktopNetworkStats | null>(null);
  const frameBusy = useRef<string | null>(null);
  const unlockFrame = useRef<((presented: boolean) => void) | null>(null);
  const inputBusy = useRef<{ lease: string } | null>(null);
  const [lease, setLease] = useState<RemoteDesktopLease | null>(null);
  // What a device screen actually shows now, as its host last reported it.
  const [deviceShape, setDeviceShape] = useState<{
    lease: string;
    width: number;
    height: number;
  } | null>(null);
  const [windowsOpen, setWindowsOpen] = useState(false);
  useEffect(() => {
    setWindowsOpen(false);
  }, [lease?.lease, lease?.controlling, focused]);
  const [fittedDisplay, setFittedDisplay] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewerViewport, setViewerViewport] = useState({ width: 0, height: 0 });
  const viewerViewportRef = useRef(viewerViewport);
  viewerViewportRef.current = viewerViewport;
  const windowSizeRef = useRef(windowSize);
  windowSizeRef.current = windowSize;
  const viewportGeneration = useRef(0);
  // Last attempted viewport, independent of the host's (possibly HiDPI) size.
  // A failed adjustment waits for a new viewport instead of retrying in a loop.
  const fittedViewport = useRef({ width: 0, height: 0 });
  const matchesViewer = (
    display: { width: number; height: number },
    width: number,
    height: number,
  ) =>
    width > 0 &&
    height > 0 &&
    Math.abs(display.width / display.height - width / height) < 0.003;
  exitLock.current =
    lockOnExitLoaded && lockOnExit && caps?.lockOnExit === true;
  const exitLockPolicy = useRef(false);
  exitLockPolicy.current = lockOnExitLoaded && lockOnExit;
  const [status, setStatus] = useState("connecting");
  const [appState, setAppState] = useState(AppState.currentState);
  const [error, setError] = useState<string | null>(null);
  const takeoverPromptOpen = useRef(false);
  const takeoverAction = useRef<() => void>(() => {});
  useEffect(() => {
    if (error === "hostDisconnected")
      Alert.alert(
        t("remoteDesktop.disconnected"),
        t("remoteDesktop.hostDisconnected"),
      );
  }, [error, t]);
  const [frameReady, setFrameReady] = useState(false);
  const reduceMotion = useReduceMotionEnabled();
  const mediaReveal = {
    opacity: frameReady ? 1 : 0,
    transitionProperty: "opacity" as const,
    transitionDuration:
      frameReady && reduceMotion === false ? motionDuration.fast : 0,
  };
  const [controlReady, setControlReady] = useState(false);
  const connectionPending = !error && (!lease || !frameReady || !controlReady);
  const showConnectionStatus =
    !isLeaving && (connectionPending || (!error && status === "reconnecting"));
  const showExitLockStatus = isLeaving && exitLockPending;
  const [connectionTakingLong, setConnectionTakingLong] = useState(false);
  useEffect(() => {
    setConnectionTakingLong(false);
    if (frameReady || !showConnectionStatus) return;
    const timer = setTimeout(() => setConnectionTakingLong(true), 8000);
    return () => clearTimeout(timer);
  }, [frameReady, showConnectionStatus, deviceId]);
  const connectionLabel = t(
    showExitLockStatus
      ? "remoteDesktop.lockingOnExit"
      : recovery.current.at || status === "reconnecting"
        ? screenPlugin
          ? "remoteDesktop.liveScreenReconnecting"
          : "remoteDesktop.reconnecting"
        : screenPlugin
          ? "remoteDesktop.liveScreenConnecting"
          : "remoteDesktop.connecting",
  );
  const ConnectionIcon = screenPlugin ? Smartphone : Monitor;
  const [busy, setBusy] = useState(false);
  const [inputMode, setInputMode] = useInputModePreference();
  const inputModeRef = useRef(inputMode);
  inputModeRef.current = inputMode;
  const canInput = Boolean(lease?.controlling) && !viewOnlySelected;
  const mode: Mode = canInput ? inputMode : "pan";
  const [operations, setOperations] = useState(false);
  const [controlPage, setControlPage] = useState<
    "controls" | "display" | "security"
  >("controls");
  const unlockNotice =
    lease &&
    security.notice &&
    !showConnectionStatus &&
    !showExitLockStatus &&
    !(operations && controlPage === "security")
      ? security.notice
      : null;
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  const [videoSettings, setVideoSettings, videoPreferencesLoaded] =
    useVideoSettingsPreference();
  const videoSettingsRef = useRef(videoSettings);
  videoSettingsRef.current = videoSettings;
  const audioUnavailable = useRef(false);
  const [settingNotice, setSettingNotice] = useState<string | null>(null);
  const [settingBusy, setSettingBusy] = useState(false);
  const settingInFlight = useRef(false);
  const pendingMediaOffers = useRef(new Map<RemoteDesktopLease, number>());
  const pendingVideoSettings = useRef<RemoteDesktopLease | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const applyPendingVideoSettings = useRef<() => void>(() => {});
  const [canPip, setCanPip] = useState(false);
  const presentation = useRef(false);
  const actualPresentation = useRef(false);
  const [pipEnabled, setPipEnabled] = usePictureInPicturePreference(
    screenPlugin ? "liveScreen" : "desktop",
  );
  const pipEnabledRef = useRef(pipEnabled);
  pipEnabledRef.current = pipEnabled;
  const pipPrepared = useRef(false);
  const presentationGeneration = useRef(0);
  const restoringPresentation = useRef(false);
  const startPresentationRef = useRef<(enter?: boolean) => Promise<void>>(
    async () => {},
  );
  const pendingPresentation = useRef<((active: boolean) => void) | null>(null);
  const presentationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentationReturnedToActive = useRef(false);
  const [showMouseButtons, setShowMouseButtons] = useMouseButtonsPreference();
  const [keyboard, setKeyboard] = useState(false);
  const [fullKeys, setFullKeys] = useState(false);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [nativeKeyboard, setNativeKeyboard] = useState(false);
  const [nativeKeyboardHeight, setNativeKeyboardHeight] = useState(0);
  const [keyboardPanelHeight, setKeyboardPanelHeight] = useState(0);
  const [backControlHeight, setBackControlHeight] = useState(44);
  // On a wide iOS window the status reservation can occupy only the trailing
  // corner. Share that row, with the native toolbar's bottom spacing, when the
  // complete back button fits in its unobstructed leading corner, including
  // tabletop posture: the fold below does not obstruct this status row.
  const sharedBackTop = insets.top - backControlHeight - spacing.md;
  const portraitBackLeft = edgePadding.paddingLeft + spacing.lg;
  const sharedStatusRow =
    Platform.OS === "ios" &&
    !landscape &&
    geometry.reservedRegionsSupported &&
    geometry.regularWidth &&
    statusReservation.length > 0 &&
    sharedBackTop >= spacing.md &&
    !geometry.regions.some(
      (region) =>
        region.x < portraitBackLeft + navigationChrome.target &&
        region.x + region.width > portraitBackLeft &&
        region.y < sharedBackTop + backControlHeight &&
        region.y + region.height > sharedBackTop,
    );
  // Android's system keyboard already resizes the window. Keep its existing
  // flow layout; only iOS needs an offset above the native keyboard.
  const landscapeKeyboardOverlay =
    landscape && (Platform.OS === "ios" || fullKeys);
  // Going to the phone's keyboard, iOS keeps the keys until it has risen over
  // them, so neither the bar nor the desktop moves during the swap.
  const [awaitingSystemKeyboard, setAwaitingSystemKeyboard] = useState(false);
  const panelKeys = fullKeys || awaitingSystemKeyboard;
  useEffect(() => {
    if (!awaitingSystemKeyboard) return;
    // A hardware keyboard means the phone's never rises.
    const timer = setTimeout(() => setAwaitingSystemKeyboard(false), 800);
    return () => clearTimeout(timer);
  }, [awaitingSystemKeyboard]);
  const keyboardBottom =
    Platform.OS === "ios" && keyboard && !panelKeys ? nativeKeyboardHeight : 0;
  // The keys take the phone keyboard's last height in this orientation, for the same reason.
  const systemKeyboardHeight = useRef({ portrait: 0, landscape: 0 });
  const foldLayout = foldDesktopLayout(
    geometry,
    keyboardBottom,
    keyboardPanelHeight,
    keyboard,
  );
  const [foldSkin, setFoldSkin] = useFoldSkinPreference();
  const foldSkinAvailable = Boolean(foldLayout);
  const retroDesktop =
    foldSkinAvailable &&
    foldSkin !== "modern" &&
    foldSkin !== "keyboard" &&
    frameReady &&
    !keyboard &&
    (!operations || Boolean(fittedDisplay));
  const keyboardDeck =
    foldSkinAvailable &&
    foldSkin === "keyboard" &&
    frameReady &&
    focused &&
    !keyboard &&
    !operations;
  // The deck replaces the toolbar and, like hardware skins, covers the lower
  // half up to the seam; only its interactive content stays in the safe region.
  const physicalDeck = retroDesktop || keyboardDeck;
  const viewerColors = retroDesktop ? darkColors : colors;
  // Artwork covers both physical halves, including the division and system
  // reservations. Only interactive content is constrained to the safe regions.
  const foldSeam = tableRegion
    ? (tableRegion.first.y + tableRegion.first.height + tableRegion.second.y) /
      2
    : 0;
  const hardwareMedia = { x: 0, y: 0, width: geometry.width, height: foldSeam };
  const hardwareControls = {
    x: 0,
    y: foldSeam,
    width: geometry.width,
    height: geometry.height - foldSeam,
  };
  const retroViewport =
    retroDesktop && foldLayout
      ? retroDesktopViewport(
          foldSkin === "macbook"
            ? {
                ...hardwareMedia,
                // Keep the display flush at the top; the physical fold band
                // belongs to the silver case rather than the video surface.
                height: foldLayout.media.y + foldLayout.media.height,
              }
            : hardwareMedia,
          foldSkin,
          foldLayout.media,
          // While fitting, the glass opening determines the host resolution.
          // Feeding the old host ratio back here would lock in its portrait shape.
          !fittedDisplay && lease && lease.display.height > 0
            ? lease.display.width / lease.display.height
            : undefined,
        )
      : null;
  const fullScreenFoldBackground = Boolean(foldLayout);
  const foldControls = foldLayout?.controls ?? controlRegion(geometry);
  const send = useCallback((message: object) => {
    const command = message as Record<string, unknown>;
    // Every control handoff retires the parent batch together with the viewer
    // queue. A late native fallback, failure or ACK cannot own the next batch.
    if (command.type === "control" || command.type === "stop")
      inputBusy.current = null;
    const owner = active.current;
    const attempt = command.attemptId ?? mediaAttempt.current;
    webview.current?.postMessage(JSON.stringify(message));
    if (
      NativeRemoteDesktopView &&
      nativeMediaCommands.has(String(command.type))
    ) {
      void nativeViewer.current
        ?.receive({
          ...command,
          epoch: command.epoch ?? owner?.lease,
          ...(command.type === "init"
            ? {
                net:
                  owner?.display.id === "wayland-portal"
                    ? {
                        ...REMOTE_DESKTOP_NETWORK,
                        // Shipped native receivers do not understand capturePending.
                        // Their existing bounded retry timer must cover local consent
                        // before using the normal network recovery attempts.
                        retryMs: [
                          ...Array<number>(15).fill(8000),
                          ...REMOTE_DESKTOP_NETWORK.retryMs,
                        ],
                      }
                    : REMOTE_DESKTOP_NETWORK,
                iceServers: REMOTE_DESKTOP_ICE_SERVERS,
                diagnostics: mobileDebugEnabled(),
              }
            : {}),
        })
        .catch(() => {
          if (
            !owner ||
            active.current !== owner ||
            mediaAttempt.current !== attempt
          )
            return;
          // Route a native bridge failure through the existing recovery path.
          nativeMessage.current({
            nativeEvent: {
              data: JSON.stringify({
                type: "fallback",
                epoch: owner.lease,
                attemptId: attempt,
              }),
            },
          });
        });
    }
  }, []);
  const nativeMessage = useRef<
    (event: { nativeEvent: { data: string } }) => void
  >(() => {});
  useEffect(() => {
    const enabled = keyboard && !fullKeys && focused && canInput;
    if (!enabled) {
      send({ type: "keyboard", enabled: false });
      Keyboard.dismiss();
      return;
    }
    // Focus synchronously in the native-to-WebView script call. Deferring DOM
    // focus to a web animation frame loses WebKit's user-interaction context.
    webview.current?.requestFocus();
    send({ type: "keyboard", enabled: true });
  }, [keyboard, fullKeys, focused, canInput, keyboardFocusRequest, send]);
  // Small control requests ride the media data channel when the host supports
  // it: a direct peer avoids the relay round trip and keeps their order with
  // input. Anything the channel did not take uses the relay; once sent, the
  // outcome belongs to the channel and is never replayed over the relay.
  const channelRequests = useRef(
    new Map<
      string,
      {
        op: RemoteDesktopRequest["op"];
        settle(outcome: ChannelOutcome): void;
      }
    >(),
  );
  const channelRequestId = useRef(0);
  // Requests ride the media peer. Once it is gone their outcome is unknown, so
  // settle them now instead of waiting out the timeout or replaying on the relay.
  const abandonChannelRequests = useCallback(() => {
    for (const pending of [...channelRequests.current.values()])
      pending.settle({ kind: "error", code: "INVOKE_TIMEOUT" });
  }, []);
  const sendOverChannel = useCallback(
    (message: RemoteDesktopRequest & { lease: string }, preSend?: () => void) =>
      new Promise<ChannelOutcome>((resolve) => {
        preSend?.();
        const id = `${Date.now().toString(36)}-${++channelRequestId.current}`;
        const timer = setTimeout(
          () => settle({ kind: "error", code: "INVOKE_TIMEOUT" }),
          REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS,
        );
        const settle = (outcome: ChannelOutcome) => {
          if (channelRequests.current.get(id)?.settle !== settle) return;
          channelRequests.current.delete(id);
          clearTimeout(timer);
          resolve(outcome);
        };
        channelRequests.current.set(id, { op: message.op, settle });
        const viaWebView = () => {
          // The viewer answers with channelRequestState / channelReply.
          send({ type: "channelRequest", id, request: message });
        };
        // iOS media runs in the native receiver; it owns the channel there.
        const native = NativeRemoteDesktopView ? nativeViewer.current : null;
        if (!native?.sendRequest) {
          viaWebView();
          return;
        }
        void native
          .sendRequest({ epoch: message.lease, id, request: message })
          .catch(() => false)
          .then((sent) => {
            if (!sent && channelRequests.current.has(id)) viaWebView();
          });
      }),
    [send],
  );
  const request = useCallback(
    async <T,>(message: RemoteDesktopRequest, preSend?: () => void) => {
      if (message.op === "start" || message.op === "heartbeat")
        message = {
          ...message,
          lockOnExit: exitLockPolicy.current,
          ...(capsRef.current?.deviceId === deviceId &&
          capsRef.current.value.idleLock
            ? { idleTimeoutMinutes: idleTimeoutPolicy.current }
            : {}),
        };
      const relay = () =>
        linkRef.current.invoke<T>(deviceId, REMOTE_DESKTOP_CHANNEL, [message], {
          preSend,
        });
      const lease = active.current;
      const hostCaps = capsRef.current;
      if (
        !lease ||
        !streaming.current ||
        hostCaps?.deviceId !== deviceId ||
        hostCaps.value.channelRequests !== true ||
        !("lease" in message) ||
        message.lease !== lease.lease ||
        !isRemoteDesktopChannelRequest(message)
      )
        return relay();
      const outcome = await sendOverChannel(message, preSend);
      if (outcome.kind === "result") return outcome.value as T;
      if (outcome.kind === "relay") return relay();
      throw Object.assign(new Error(outcome.code), { code: outcome.code });
    },
    [deviceId, sendOverChannel],
  );
  const viewerSession = useMemo(
    () => ({ current: new RemoteDesktopViewerSession(request) }),
    [request],
  );
  const updateLockOnExit = (enabled: boolean) => {
    setLockOnExit(enabled);
    // Requests and exit can run before React commits the preference update.
    exitLockPolicy.current = enabled;
    exitLock.current = enabled && caps?.lockOnExit === true;
    const current = active.current;
    if (current)
      void request({ op: "heartbeat", lease: current.lease }).catch(() => {
        // Local preference remains saved; the regular heartbeat retries sync.
      });
  };
  const updateIdleTimeout = (minutes: number) => {
    setIdleTimeoutMinutes(minutes);
    idleTimeoutPolicy.current = minutes;
    const current = active.current;
    if (current)
      void request({ op: "heartbeat", lease: current.lease }).catch(() => {});
  };
  const authRef = useRef(auth);
  authRef.current = auth;
  const loadIceServers = (attemptId: string) =>
    resolveDesktopIceServers(
      () =>
        authRef.current.apiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
          cache: "no-store",
        }),
      (result) =>
        mobileDebugLog("info", "device-link", "remote desktop ICE config", {
          revision: RTC_DIAGNOSTIC_REVISION,
          attempt: attemptId.slice(0, 8),
          ...result,
        }),
    );
  // An ICE lookup started alongside a display change or a connection, so the
  // next media attempt does not wait for the server after it. One-shot.
  const icePrefetch = useRef<{
    at: number;
    servers: ReturnType<typeof resolveDesktopIceServers>;
  } | null>(null);
  const viewerMedia = useMemo(
    () =>
      new RemoteDesktopViewerMedia({
        request,
        send,
        loadIce: (attemptId) => {
          const prefetched = icePrefetch.current;
          icePrefetch.current = null;
          return prefetched && Date.now() - prefetched.at < 30_000
            ? prefetched.servers
            : loadIceServers(attemptId);
        },
        current: () => {
          const lease = active.current,
            caps = capsRef.current?.value;
          return lease && caps
            ? {
                lease,
                caps,
                settings: {
                  ...videoSettingsRef.current,
                  audio: Boolean(
                    caps.systemAudio &&
                    videoSettingsRef.current.audio &&
                    !audioUnavailable.current,
                  ),
                },
              }
            : null;
        },
        onAttempt: (attempt) => {
          mediaAttempt.current = attempt;
        },
        onOfferStart: (lease) =>
          pendingMediaOffers.current.set(
            lease,
            (pendingMediaOffers.current.get(lease) ?? 0) + 1,
          ),
        onOfferSettled: (lease) => {
          const remaining = (pendingMediaOffers.current.get(lease) ?? 1) - 1;
          if (remaining > 0) pendingMediaOffers.current.set(lease, remaining);
          else pendingMediaOffers.current.delete(lease);
          if (alive.current) setSettingsRevision((value) => value + 1);
        },
        onOfferFailure: () => {
          setStatus("compatibility");
          setSettingBusy(false);
          setSettingNotice(t("remoteDesktop.videoSettingsFailed"));
        },
      }),
    [request, send, t],
  );
  const safety = useRemoteDesktopSafety(
    deviceId,
    lease,
    !connectionPending && !error,
    focused,
    // A device screen leaves the computer alone: no privacy mask, mute or clipboard sync.
    screenPlugin ? null : caps,
    request,
    exitLock.current,
  );
  const keyResync = useRef<(() => void) | null>(null);
  const transferClipboard = async (action: "copy" | "paste") => {
    const current = active.current;
    const epoch = generation.current;
    const check = () => {
      if (
        !alive.current ||
        generation.current !== epoch ||
        active.current !== current ||
        !current?.controlling ||
        AppState.currentState !== "active"
      )
        throw new Error("DESKTOP_LEASE_EXPIRED");
    };
    check();
    send({ type: "events", events: [{ kind: "release" }] });
    // The key surface still holds what the user's fingers hold; press it again.
    keyResync.current?.();
    if (
      caps?.clipboardContent &&
      remotePresentation?.readClipboard &&
      remotePresentation?.writeClipboard
    ) {
      await transferClipboardContent(action, current!.lease, request, check);
      return;
    }
    if (action === "paste" && (await Clipboard.hasImageAsync()))
      throw new Error("CLIPBOARD_UPGRADE");
    if (action === "copy") {
      const result = await request<{ text: string }>({
        op: "clipboard",
        lease: current!.lease,
        action,
      });
      check();
      if (typeof result.text !== "string" || !result.text)
        throw new Error("CLIPBOARD_EMPTY");
      if (result.text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
        throw new Error("CLIPBOARD_TOO_LONG");
      if (!(await Clipboard.setStringAsync(result.text)))
        throw new Error("CLIPBOARD_WRITE_FAILED");
    } else {
      const text = await Clipboard.getStringAsync();
      check();
      if (!text) throw new Error("CLIPBOARD_EMPTY");
      if (text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
        throw new Error("CLIPBOARD_TOO_LONG");
      await request({ op: "clipboard", lease: current!.lease, action, text });
      check();
    }
  };
  useEffect(() => {
    const updateFrame = (event: KeyboardEvent) => {
      const height = Math.max(
        0,
        Dimensions.get("window").height - event.endCoordinates.screenY,
      );
      setNativeKeyboardHeight(height);
      setNativeKeyboard(height > 0);
      // Android resizes the window for the keyboard, leaving only this field reliable.
      const measured = event.endCoordinates.height;
      if (measured > 0) {
        // The stable orientation, as `landscape` uses: adjustResize can make
        // an Android portrait window wider than tall while the IME is open.
        const { width: w, height: h } = Dimensions.get(
          Platform.OS === "android" ? "screen" : "window",
        );
        systemKeyboardHeight.current[w > h ? "landscape" : "portrait"] =
          measured;
      }
    };
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      updateFrame(event);
      setAwaitingSystemKeyboard(false);
    });
    const frame =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardWillChangeFrame", updateFrame)
        : null;
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setNativeKeyboard(false);
      setNativeKeyboardHeight(0);
    });
    return () => {
      show.remove();
      frame?.remove();
      hide.remove();
    };
  }, []);

  const stop = useCallback(
    (
      preserveFrame = false,
      exiting = false,
      forceLock = false,
      preserveLease = false,
    ) => {
      timing.current?.("stopped");
      timing.current = null;
      generation.current++;
      unlockFrame.current?.(false);
      unlockFrame.current = null;
      presentation.current = false;
      actualPresentation.current = false;
      pipPrepared.current = false;
      foregroundRestorePending.current = false;
      presentationGeneration.current++;
      settingInFlight.current = false;
      pendingPresentation.current?.(false);
      pendingPresentation.current = null;
      if (presentationTimer.current) clearTimeout(presentationTimer.current);
      presentationTimer.current = null;
      void remotePresentation?.playback(false).catch(() => {});
      connecting.current = false;
      pendingHostControl.current = null;
      controlInFlight.current = false;
      controlRestoration.current = null;
      finishBackgroundTransition.current?.();
      finishBackgroundTransition.current = null;
      const previous = active.current;
      abandonChannelRequests();
      icePrefetch.current = null;
      setExitLockPending(
        Boolean(
          previous &&
          ((exiting && exitLock.current) ||
            (forceLock && capsRef.current?.value.lockOnExit === true)),
        ),
      );
      active.current = null;
      pendingVideoSettings.current = null;
      if (previous) pendingMediaOffers.current.delete(previous);
      mediaAttempt.current = null;
      viewerMedia.reset();
      streaming.current = false;
      receiveWindow.current = {
        since: Date.now(),
        bytes: 0,
        frameMs: null,
        frameAt: 0,
      };
      send({ type: "stop", preserveFrame, epoch: previous?.lease });
      if (alive.current) {
        setLease(null);
        setFittedDisplay(null);
        setFrameReady(false);
        setControlReady(false);
        setCanPip(false);
        setSettingBusy(false);
        setNetwork(null);
        setStatus("disconnected");
        setKeyboard(false);
        setBusy(false);
      }
      const lockScreen = Boolean(
        (exiting && exitLock.current) ||
        (forceLock && capsRef.current?.value.lockOnExit === true),
      );
      return viewerSession
        .current!.stop(lockScreen, preserveLease)
        .then(() => {})
        .catch(() => {
          if (lockScreen)
            Alert.alert(
              t("remoteDesktop.lockOnExit"),
              t("remoteDesktop.lockOnExitFailed"),
            );
        });
    },
    [request, send, t, viewerSession, viewerMedia],
  );
  const stopRef = useRef(stop);
  stopRef.current = stop;
  // This cleanup belongs to navigation lifetime, never to media-effect rebuilds.
  useEffect(
    () => () => {
      void stopRef.current(false, true);
    },
    [],
  );
  const fail = useCallback(
    (cause: unknown) => {
      if (!alive.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = remoteDesktopErrorCode(cause);
      // Keep diagnostics free of device names, input and signaling payloads.
      console.debug("[remote-desktop] connection failed", {
        code: code ?? "UNKNOWN",
      });
      const blocked = /DESKTOP_STOPPED/.test(code ?? message)
        ? "hostDisconnected"
        : remoteDesktopFailureKey(code ?? message);
      stop(
        !blocked,
        false,
        false,
        !blocked &&
          capsRef.current?.value.idleLock === true &&
          capsRef.current.value.automaticReconnect === true &&
          idleTimeoutPolicy.current > 0,
      );
      setError(blocked);
      if (
        blocked === "connectionBusy" &&
        capsRef.current?.deviceId === deviceId &&
        capsRef.current.value.connectionTakeover === true &&
        !takeoverPromptOpen.current
      ) {
        takeoverPromptOpen.current = true;
        Alert.alert(
          t("remoteDesktop.connectionBusy"),
          t("remoteDesktop.connectionBusyTakeover"),
          [
            {
              text: t("remoteDesktop.close"),
              style: "cancel",
              onPress: () => {
                takeoverPromptOpen.current = false;
              },
            },
            {
              text: t("remoteDesktop.takeoverConnection"),
              style: "destructive",
              onPress: () => {
                takeoverPromptOpen.current = false;
                takeoverAction.current();
              },
            },
          ],
        );
      }
      if (blocked === "hostDisconnected") setOperations(false);
      if (blocked) recovery.current.enabled = false;
      else {
        recovery.current.at = Date.now() + recovery.current.delay;
        recovery.current.delay = Math.min(15_000, recovery.current.delay * 2);
        setStatus("reconnecting");
      }
    },
    [deviceId, stop, t],
  );
  /**
   * The host owns the control bit. When it reports that this viewer no longer
   * controls — input injection failed, the input helper went away, or control
   * was retracted — drop to view only instead of rebuilding the session: the
   * lease and picture survive. Known input failures restore control immediately;
   * the existing heartbeat retries missed or failed foreground recovery.
   */
  const releaseControl = useCallback(() => {
    const current = active.current;
    if (!current?.controlling) return;
    current.controlling = false;
    send({ type: "control", enabled: false });
    if (alive.current) {
      setKeyboard(false);
      setLease({ ...current });
    }
  }, [send]);
  /**
   * Route a failed input or control request by its blast radius: a control-only
   * fault drops to view only, an unknown outcome keeps everything as it is, and
   * anything else rebuilds the session. Sitting next to the two actions it
   * chooses between keeps the three call sites from drifting apart.
   */
  const resolveControlFailure = (cause: unknown, restoreInput = false) => {
    switch (controlFailureAction(cause)) {
      case "release":
        releaseControl();
        if (restoreInput) restoreInlinePresentationRef.current();
        break;
      case "ignore":
        break;
      default:
        fail(cause);
    }
  };
  const applyConfirmedControl = (
    current: RemoteDesktopLease,
    controlling: boolean,
  ) => {
    pendingHostControl.current = null;
    if (current.controlling !== controlling) {
      current.controlling = controlling;
      if (!controlling) {
        if (alive.current) {
          setKeyboard(false);
        }
      }
    }
    // The shared session may already have mutated this lease before returning.
    // Always publish the confirmation to React's separate snapshot as well.
    if (alive.current) setLease({ ...current });
    send({ type: "control", enabled: inputAllowed(controlling) });
  };
  const requestHostControl = (
    current: RemoteDesktopLease,
    enabled: boolean,
  ) => {
    if (controlInFlight.current) return;
    if (enabled) foregroundRestorePending.current = false;
    controlInFlight.current = true;
    pendingHostControl.current = enabled;
    const operation = request<{ controlling: boolean }>({
      op: "control",
      lease: current.lease,
      enabled,
    })
      .then((result) => {
        if (active.current !== current) return;
        applyConfirmedControl(current, result.controlling);
      })
      .catch((cause) => {
        if (active.current !== current) return;
        resolveControlFailure(cause);
      })
      .finally(() => {
        if (active.current !== current) return;
        controlInFlight.current = false;
        if (foregroundRestorePending.current)
          restoreInlinePresentationRef.current();
      });
    // PiP must wait for both recovery grants and overflow releases before it
    // authorizes background viewing; an older operation cannot clear a new one.
    controlRestoration.current = operation;
    void operation.finally(() => {
      if (controlRestoration.current === operation)
        controlRestoration.current = null;
    });
    return operation;
  };
  const requestHostControlRef = useRef(requestHostControl);
  const restoreInlinePresentation = () => {
    const current = active.current;
    const canControl = capsRef.current?.value.canControl === true;
    if (
      !current ||
      ((current.controlling || !canControl) &&
        !pipPrepared.current &&
        !foregroundRestorePending.current) ||
      presentation.current ||
      actualPresentation.current ||
      !focusedRef.current ||
      linkRef.current.status !== "online" ||
      AppState.currentState !== "active"
    )
      return;
    if (
      connecting.current ||
      controlInFlight.current ||
      (!canControl && controlRestoration.current !== null) ||
      settingInFlight.current ||
      pendingHostControl.current === false
    ) {
      foregroundRestorePending.current = true;
      return;
    }
    send({
      type: "pipPolicy",
      enabled: pipEnabledRef.current && frameReady,
      authorized: false,
    });
    if (!canControl) {
      // View-only hosts still need to leave background video/lease policy.
      // A new PiP entry must await this reply before authorizing background again.
      // Until the host confirms, the existing heartbeat still owns recovery.
      // Keep this lease's intent, but never clear a newer PiP transition's flags.
      foregroundRestorePending.current = true;
      const transition = presentationGeneration.current;
      const restoration = request({
        op: "presentation",
        lease: current.lease,
        enabled: false,
      })
        .then(() => {
          if (
            active.current !== current ||
            presentationGeneration.current !== transition
          )
            return;
          pipPrepared.current = false;
          foregroundRestorePending.current = false;
        })
        .catch((cause) => {
          if (
            active.current === current &&
            controlFailureAction(cause) !== "ignore"
          )
            fail(cause);
        });
      controlRestoration.current = restoration;
      void restoration.finally(() => {
        if (controlRestoration.current === restoration)
          controlRestoration.current = null;
      });
      return;
    }
    pipPrepared.current = false;
    foregroundRestorePending.current = false;
    // Capable hosts retain foreground control; view only guards input locally.
    // A temporary release/refusal must not replace that intent. App/route/PiP
    // events restore immediately; heartbeats retry when a transition was busy
    // or its request failed, using the same lease and host permission checks.
    requestHostControlRef.current(current, true);
  };
  const restoreInlinePresentationRef = useRef(restoreInlinePresentation);
  restoreInlinePresentationRef.current = restoreInlinePresentation;
  requestHostControlRef.current = requestHostControl;
  const connect = useCallback(
    async (displayId?: string, takeover = false) => {
      if (
        connecting.current ||
        !alive.current ||
        !focusedRef.current ||
        !recovery.current.enabled ||
        linkRef.current.status !== "online" ||
        !ready.current ||
        !videoPreferencesLoaded ||
        !lockOnExitLoaded ||
        !idleTimeoutLoaded ||
        !deviceId ||
        AppState.currentState !== "active"
      )
        return;
      stop(!displayId || displayId === recovery.current.displayId);
      if (displayId) recovery.current.resuming = false; // Explicit display selection.
      connecting.current = true;
      const current = generation.current;
      const mark = connectionDiagnostics(current);
      timing.current = mark;
      mark("connect");
      setError(null);
      setStatus(recovery.current.at ? "reconnecting" : "connecting");
      try {
        await linkRef.current.openLink(deviceId);
        if (current !== generation.current) return;
        mark("link-ready");
        const resuming = displayId ? false : recovery.current.resuming;
        const { caps: result, lease: next } =
          await viewerSession.current!.connect({
            displayId: displayId ?? recovery.current.displayId,
            resume: resuming,
            takeover,
            ...(handoff ? { handoff } : {}),
            ...(screenPlugin && screenId
              ? { screen: { plugin: screenPlugin, id: screenId } }
              : {}),
            // Hosts with `autoControl` grant control with the lease.
            control: true,
            onStart: () => {
              recovery.current.resuming = true;
            },
            isCurrent: () => current === generation.current && alive.current,
            onCapabilities: (result) => {
              mark("capabilities");
              capsRef.current = { deviceId, value: result };
              setHostCaps({ deviceId, value: result });
              // A window view never unlocks the computer: it shows a window on an unlocked desktop.
              // Automatic recovery must never unlock before the host can reject resume.
              // A deliberate new connection may still use the saved password, and so
              // may a return after release: macOS waits for the first frame, which
              // follows the host accepting resume. Linux unlocks before start.
              if (
                (!resuming ||
                  (recovery.current.returned && result.platform !== "linux")) &&
                !handoff &&
                !screenPlugin &&
                supportsAutoUnlock(result.platform)
              ) {
                // Linux capture may be unavailable until its locker releases the session.
                if (result.platform === "linux") {
                  return securityRef.current.maybeUnlock(async () => {
                    if (
                      current !== generation.current ||
                      !focusedRef.current ||
                      !recovery.current.enabled
                    )
                      throw new Error("CREDENTIAL_CANCELLED");
                  });
                }
                const firstFrame = new Promise<boolean>((resolve) => {
                  unlockFrame.current = resolve;
                });
                unlockAttempt.current = securityRef.current.maybeUnlock(
                  async () => {
                    if (
                      !(await firstFrame) ||
                      current !== generation.current ||
                      !focusedRef.current ||
                      !recovery.current.enabled
                    )
                      throw new Error("CREDENTIAL_CANCELLED");
                  },
                );
              }
            },
          });
        const display = next.display;
        recovery.current.displayId = display.id;
        mark("capture-started");
        // Overlaps control and the remembered display; video needs it next.
        icePrefetch.current = {
          at: Date.now(),
          servers: loadIceServers("connect"),
        };
        active.current = next;
        recovery.current.returned = false;
        receiveWindow.current = {
          since: Date.now(),
          bytes: 0,
          frameMs: null,
          frameAt: 0,
        };
        setLease({ ...next });
        setStatus("compatibility");
        audioUnavailable.current = false;
        setSettingNotice(null);
        // Native video needs a playback session for AVKit PiP readiness even
        // when its audio track is disabled. Release it when the viewer stops.
        if (
          NativeRemoteDesktopView ||
          (result.systemAudio && videoSettingsRef.current.audio)
        ) {
          try {
            await remotePresentation?.playback(true);
          } catch {
            if (current !== generation.current) return;
            audioUnavailable.current = true;
            setSettingNotice(t("remoteDesktop.audioUnavailable"));
            await remotePresentation?.playback(false).catch(() => {});
          }
          if (current !== generation.current) return;
        }
        // Switch to the remembered display before the viewer asks for video,
        // so the first frame already has the chosen size.
        if (
          await applyRememberedDisplay.current(
            next,
            result,
            () => current === generation.current && active.current === next,
          )
        ) {
          if (current !== generation.current) return;
          setLease({ ...next });
        }
        send({
          type: "init",
          trickleIce: result.trickleIce === true,
          epoch: next.lease,
          width: next.display.width,
          height: next.display.height,
          fillHeight: landscape,
          audio:
            result.systemAudio &&
            videoSettingsRef.current.audio &&
            !audioUnavailable.current,
        });
        // Playback/display preparation can yield after React has already sent
        // the controlling mode. Do not overwrite it with connect's old "pan".
        send({
          type: "mode",
          mode: inputAllowed(next.controlling) ? inputModeRef.current : "pan",
        });
        // Entering remote desktop is the user's intent to control. The existing
        // host permission and ownership gates still decide whether it is allowed.
        if (next.controlling)
          send({ type: "control", enabled: inputAllowed(true) });
        else if (result.canControl) {
          try {
            const control = await viewerSession.current!.control(true);
            if (current !== generation.current) return;
            // Control changes keep the same session identity for in-flight replies.
            next.controlling = control.controlling;
            setLease({ ...next });
            send({
              type: "control",
              enabled: inputAllowed(control.controlling),
            });
          } catch (cause) {
            if (current === generation.current) resolveControlFailure(cause);
          }
        }
        mark("control-ready");
        setControlReady(true);
      } catch (cause) {
        if (current === generation.current) fail(cause);
      } finally {
        if (current === generation.current) {
          connecting.current = false;
          if (foregroundRestorePending.current)
            restoreInlinePresentationRef.current();
        }
      }
    },
    [
      deviceId,
      fail,
      handoff,
      screenPlugin,
      screenId,
      landscape,
      request,
      resolveControlFailure,
      send,
      stop,
      t,
      videoPreferencesLoaded,
      lockOnExitLoaded,
      idleTimeoutLoaded,
      viewerSession,
    ],
  );
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const portalAuthorization =
    caps?.displays.some((display) => display.id === "wayland-portal") === true;
  useEffect(() => {
    if (!focused || appState !== "active" || !showConnectionStatus) return;
    // One deadline spans link setup, automatic retries and first presentation.
    // Background/navigation pauses it; a manual retry starts a fresh budget.
    const timer = setTimeout(
      () => {
        if (
          alive.current &&
          focusedRef.current &&
          AppState.currentState === "active"
        )
          fail(new Error("DESKTOP_CONNECTION_TIMEOUT"));
      },
      REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS +
        (portalAuthorization ? 120_000 : 0),
    );
    return () => clearTimeout(timer);
  }, [focused, appState, showConnectionStatus, fail, portalAuthorization]);
  useEffect(() => {
    // Authentication preparation is already running; only the native prompt
    // waits for a frame from this lease. stop() releases cancelled waiters.
    if (
      frameReady &&
      focused &&
      lease &&
      active.current?.lease === lease.lease
    ) {
      unlockFrame.current?.(true);
      unlockFrame.current = null;
    }
  }, [frameReady, focused, lease?.lease]);
  const pause = useCallback(
    (exiting = false) => {
      void stop(true, exiting);
      if (recovery.current.enabled) {
        recovery.current.at = Date.now();
        setStatus("reconnecting");
      }
    },
    [stop],
  );
  const endBackground = (exiting = false) => {
    if (idleTimeoutPolicy.current > 0 && capsRef.current?.value.idleLock) {
      recovery.current.enabled = false;
      void stopRef.current(false, exiting, true);
      setError("backgroundDisconnected");
    } else pause(exiting);
  };
  const pausePresentation = (exiting = false) => {
    if (AppState.currentState === "background") endBackground(exiting);
    else pause(exiting);
  };
  const leave = async (returnToSource = navigation.current.onBack) => {
    if (leaving.current) return;
    leaving.current = true;
    setIsLeaving(true);
    recovery.current.enabled = false;
    Keyboard.dismiss();
    const ending = stop(false, true);
    if (exitLock.current) await ending;
    returnToSource();
  };
  const back = async () => {
    if (pendingPresentation.current) return;
    const returnToSource = navigation.current.onBack;
    const startedAt = performance.now();
    mobileDebugLog("info", "lifecycle", "remote desktop back requested", {
      backgroundRunning: pipEnabledRef.current,
      pipReady: canPip,
      pipActive: actualPresentation.current,
    });
    if (
      !pipEnabledRef.current ||
      !NativeRemoteDesktopView ||
      !active.current ||
      !canPip
    ) {
      await leave(returnToSource);
      return;
    }
    Keyboard.dismiss();
    if (!actualPresentation.current) {
      const started = new Promise<boolean>((resolve) => {
        pendingPresentation.current = resolve;
      });
      await startPresentationRef.current();
      const entered = await started;
      mobileDebugLog(
        "info",
        "lifecycle",
        "remote desktop back presentation settled",
        {
          entered,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      );
      if (!alive.current) return;
      if (!entered) {
        await leave(returnToSource);
        return;
      }
    }
    returnToSource();
  };
  const retry = () => {
    securityRef.current.resetConnectionAttempt();
    recovery.current.enabled = true;
    recovery.current.at = Date.now();
    recovery.current.delay = 1000;
    recovery.current.resuming = false;
    setError(null);
    setStatus("reconnecting");
    if (!ready.current) webview.current?.reload();
    else
      void connectRef.current(
        undefined,
        error === "connectionBusy" && caps?.connectionTakeover === true,
      );
  };
  takeoverAction.current = () => {
    securityRef.current.resetConnectionAttempt();
    recovery.current.enabled = true;
    recovery.current.at = Date.now();
    recovery.current.delay = 1000;
    recovery.current.resuming = false;
    setError(null);
    setStatus("reconnecting");
    if (!ready.current) webview.current?.reload();
    else void connectRef.current(undefined, true);
  };
  const restartViewer = () => {
    ready.current = false;
    if (!alive.current || !recovery.current.enabled) return;
    fail(new Error("DESKTOP_VIEWER_ERROR"));
  };
  useEffect(() => {
    send({ type: "viewport", fillHeight: landscape });
  }, [landscape, send, viewerReadyRevision]);

  useEffect(() => {
    if (!retroDesktop || !focused) return;
    return () => {
      send({ type: "releaseInput" });
    };
  }, [retroDesktop, foldSkin, focused, send]);

  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      setAppState(state);
      if (state === "active") presentationReturnedToActive.current = true;
      // iOS enters inactive during an interrupted Home gesture or a system
      // overlay. Release held input, but keep this viewer's lease and stream.
      if (state === "inactive") {
        send({ type: "releaseInput" });
        if (
          pipEnabledRef.current &&
          NativeRemoteDesktopView &&
          !presentation.current &&
          !settingInFlight.current
        )
          void startPresentationRef.current(false);
      } else if (
        state === "background" &&
        !presentation.current &&
        !pipPrepared.current
      ) {
        securityRef.current.resetConnectionAttempt();
        recovery.current.returned = true;
        endBackground();
      } else if (state === "active" && active.current) {
        send({ type: "resume" });
        restoreInlinePresentationRef.current();
      } else if (
        state === "active" &&
        recovery.current.enabled &&
        !active.current
      )
        void connectRef.current();
    });
    let heartbeatBusy: string | null = null;
    const heartbeat = setInterval(() => {
      const current = active.current;
      if (
        !current &&
        recovery.current.enabled &&
        Date.now() >= recovery.current.at
      ) {
        if (
          !focusedRef.current ||
          AppState.currentState !== "active" ||
          linkRef.current.status !== "online"
        )
          return;
        if (!ready.current && recovery.current.at) {
          webview.current?.reload();
          recovery.current.at = Date.now() + recovery.current.delay;
          recovery.current.delay = Math.min(15_000, recovery.current.delay * 2);
          return;
        }
        void connectRef.current();
        return;
      }
      if (
        !current ||
        heartbeatBusy === current.lease ||
        (NativeRemoteDesktopView &&
          pipPrepared.current &&
          linkRef.current.status !== "online") ||
        (presentation.current && AppState.currentState !== "active")
      )
        return;
      heartbeatBusy = current.lease;
      void request<{ controlling: boolean; shape?: unknown }>({
        op: "heartbeat",
        lease: current.lease,
      })
        .then((result) => {
          const shape = liveScreenShape(result.shape);
          if (shape && active.current === current)
            setDeviceShape({ lease: current.lease, ...shape });
          // The host owns the control bit. Follow it when it retracts control;
          // when a local transition timed out, retry a release or restore the
          // local bit so a held key cannot stay down behind a view-only phone.
          if (
            active.current !== current ||
            presentation.current ||
            actualPresentation.current ||
            !focusedRef.current ||
            AppState.currentState !== "active"
          )
            return;
          if (result.controlling === false) {
            // Do not consume an intent while its request is settling. Once it
            // settles, host-false is a reason to retry, not to remain stuck.
            if (controlInFlight.current) return;
            pendingHostControl.current = null;
            if (current.controlling) releaseControl();
          } else if (pendingHostControl.current === false) {
            requestHostControlRef.current(current, false);
            return;
          } else if (
            result.controlling === true &&
            !controlInFlight.current &&
            !current.controlling &&
            pendingHostControl.current === true
          ) {
            applyConfirmedControl(current, true);
          }
          restoreInlinePresentationRef.current();
        })
        .catch((cause) => {
          if (active.current !== current) return;
          // A missing reply does not prove renewal failed; the next interval
          // retries within the lease. Explicit host revocation still stops us.
          if (
            cause &&
            typeof cause === "object" &&
            cause.code === "INVOKE_TIMEOUT"
          )
            return;
          if (active.current === current && !presentation.current) fail(cause);
        })
        .finally(() => {
          if (heartbeatBusy === current.lease) heartbeatBusy = null;
        });
    }, 3000);
    const frames = setInterval(() => {
      const current = active.current;
      if (!current || streaming.current || frameBusy.current === current.lease)
        return;
      frameBusy.current = current.lease;
      const requestedAt = Date.now();
      void request<{
        jpeg: string | null;
        cursor?: RemoteDesktopCursor | null;
      }>({
        op: "frame",
        lease: current.lease,
        cursorOverlay:
          capsRef.current?.deviceId === deviceId &&
          capsRef.current.value.cursorOverlay === true,
      })
        .then((result) => {
          if (
            active.current === current &&
            !streaming.current &&
            typeof result.jpeg === "string" &&
            result.jpeg.length <=
              Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4
          ) {
            recovery.current.delay = 1000;
            const meter = receiveWindow.current;
            meter.bytes +=
              Math.floor((result.jpeg.length * 3) / 4) -
              (result.jpeg.endsWith("==")
                ? 2
                : result.jpeg.endsWith("=")
                  ? 1
                  : 0);
            meter.frameMs = Date.now() - requestedAt;
            meter.frameAt = Date.now();
            send({
              type: "frame",
              jpeg: result.jpeg,
              ...(isRemoteDesktopCursor(result.cursor) || result.cursor === null
                ? { cursor: result.cursor }
                : {}),
            });
          }
        })
        .catch((cause) => {
          if (active.current === current) fail(cause);
        })
        .finally(() => {
          if (frameBusy.current === current.lease) frameBusy.current = null;
        });
    }, 350);
    const metrics = setInterval(() => {
      if (!active.current) return;
      const now = Date.now();
      if (streaming.current) {
        setNetwork((previous) =>
          previous &&
          now - previous.at > 5000 &&
          (previous.bytesPerSecond !== null || previous.latencyMs !== null)
            ? { ...previous, bytesPerSecond: null, latencyMs: null }
            : previous,
        );
        return;
      }
      const meter = receiveWindow.current;
      const elapsed = now - meter.since;
      if (elapsed <= 0 || meter.frameAt === 0) return;
      setNetwork({
        transport: "screenshots",
        bytesPerSecond: (meter.bytes * 1000) / elapsed,
        latencyMs: now - meter.frameAt <= 5000 ? meter.frameMs : null,
        at: now,
      });
      meter.since = now;
      meter.bytes = 0;
    }, 1000);
    return () => {
      alive.current = false;
      subscription.remove();
      clearInterval(heartbeat);
      clearInterval(frames);
      clearInterval(metrics);
      stop();
    };
  }, [request, fail, send, stop, pause, releaseControl]);
  useEffect(() => {
    // Route blur means leaving this desktop (including a native back swipe).
    mobileDebugLog("info", "lifecycle", "remote desktop focus effect", {
      focused,
      pipActive: actualPresentation.current,
      preparing: presentation.current,
      restoring: restoringPresentation.current,
      backgroundRunning: pipEnabledRef.current,
    });
    // App background/inactive events use pause() without the exit flag.
    if (!focused && actualPresentation.current) {
      navigation.current.onVisibility?.(false);
    } else if (
      !focused &&
      pipEnabledRef.current &&
      NativeRemoteDesktopView &&
      active.current
    ) {
      if (!presentation.current) void startPresentationRef.current();
    } else if (!focused) {
      leaving.current = true;
      setIsLeaving(true);
      if (active.current) {
        securityRef.current.resetConnectionAttempt();
        recovery.current.returned = true;
      }
      pause(true);
      navigation.current.onEnded?.();
    } else if (focused) {
      navigation.current.onVisibility?.(true);
      if (restoringPresentation.current) {
        send({ type: "restorePresentation" });
        restoringPresentation.current = false;
      } else if (presentation.current) {
        send({ type: "presentation", enabled: false });
      }
      leaving.current = false;
      setIsLeaving(false);
      setExitLockPending(false);
      restoreInlinePresentationRef.current();
      if (!active.current) void connectRef.current();
    }
  }, [
    focused,
    pause,
    videoPreferencesLoaded,
    lockOnExitLoaded,
    idleTimeoutLoaded,
  ]);
  useEffect(() => {
    send({
      type: "theme",
      surface: viewerColors.surface,
      foreground: viewerColors.textPrimary,
    });
  }, [viewerColors.surface, viewerColors.textPrimary, send]);
  useEffect(() => {
    send({ type: "mode", mode });
  }, [mode, send]);
  useEffect(() => {
    send({
      type: "mouseButtons",
      native: Platform.OS === "ios",
      // init clears the viewer's transient display-geometry flag. Keep the
      // remembered fit active across reconnects and native viewer reloads too.
      fitToInsets: fullScreenFoldBackground || Boolean(fittedDisplay),
      // Portrait fitting uses the space between Back and the bottom toolbar,
      // with breathing room on both edges; measurement and rendering share it.
      // Duo cover and unfolded landscape draw behind system chrome; its
      // reservations still position controls but do not reduce picture space.
      topInset: retroDesktop || (systemSideRail && !screenPlugin)
        ? 0
        : fullScreenFoldBackground
          ? foldLayout!.media.y
          : tableRegion
            ? 0
            : landscape
              ? edgePadding.paddingTop
              : Math.max(
                  edgePadding.paddingTop,
                  (sharedStatusRow
                    ? sharedBackTop
                    : edgePadding.paddingTop + spacing.xs) + backControlHeight,
                ) + spacing.lg,
      bottomInset: retroDesktop
        ? 0
        : fullScreenFoldBackground
          ? Math.max(
              0,
              geometry.height - foldLayout!.media.y - foldLayout!.media.height,
            )
          : tableRegion
            ? 0
            : keyboard && landscapeKeyboardOverlay
              ? keyboardPanelHeight + keyboardBottom
              : !landscape && !screenPlugin
                ? (keyboard
                    ? 0
                    : Math.max(
                        toolbarSize.height,
                        navigationChrome.target +
                          Math.max(spacing.sm, insets.bottom),
                      )) + spacing.lg
                : 0,
      keyboardOpen: keyboard && landscapeKeyboardOverlay,
      portraitKeyboardTopInset:
        keyboard && !landscape && !tableRegion
          ? edgePadding.paddingTop + spacing.xs + backControlHeight + spacing.sm
          : 0,
      rightInset: 0,
      leftInset: 0,
      enabled:
        showMouseButtons &&
        !lease?.screen &&
        focused &&
        !operations &&
        !keyboard &&
        canInput,
      labels: {
        left: t("remoteDesktop.leftClick"),
        right: t("remoteDesktop.rightClick"),
        wheel: t("remoteDesktop.mouseWheel"),
      },
    });
  }, [
    tableRegion?.first.height,
    tableRegion?.first.width,
    fullScreenFoldBackground,
    fittedDisplay,
    systemSideRail,
    screenPlugin,
    foldLayout?.media.y,
    foldLayout?.media.height,
    geometry.height,
    retroDesktop,
    viewerReadyRevision,
    showMouseButtons,
    edgePadding.paddingTop,
    sharedStatusRow,
    sharedBackTop,
    insets.bottom,
    backControlHeight,
    toolbarSize,
    keyboardPanelHeight,
    landscapeKeyboardOverlay,
    keyboardBottom,
    landscape,
    focused,
    operations,
    keyboard,
    lease?.lease,
    canInput,
    send,
    t,
  ]);
  useEffect(() => {
    if (link.status !== "online") {
      // Only a prepared background presentation can survive host signaling loss.
      // The host stops foreground leases, so discard ours before reconnecting.
      if (
        presentation.current ||
        (NativeRemoteDesktopView && pipPrepared.current)
      )
        return;
      pause();
      return;
    }
    if (!active.current) void connectRef.current();
    else restoreInlinePresentationRef.current();
  }, [link.status, pause]);

  const onMessage = (
    event:
      | Pick<WebViewMessageEvent, "nativeEvent">
      | { nativeEvent: { data: string } },
  ) => {
    if (!alive.current || event.nativeEvent.data.length > 65_536) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (
      message.type === "orientation" &&
      typeof message.angle === "number" &&
      Number.isFinite(message.angle)
    ) {
      const angle = ((message.angle % 360) + 360) % 360;
      if ([0, 90, 180, 270].includes(angle)) setInterfaceAngle(angle);
      return;
    }
    if (message.type === "ready") {
      ready.current = true;
      setViewerReadyRevision((revision) => revision + 1);
      void connectRef.current();
      return;
    }
    const current = active.current;
    if (!current || message.epoch !== current.lease) return;
    if (["iceConfig", "offer", "ice"].includes(String(message.type))) {
      void viewerMedia.handle(message).catch((cause) => {
        if (active.current === current) fail(cause);
      });
      return;
    }
    if (
      NativeRemoteDesktopView &&
      typeof message.attemptId === "string" &&
      message.attemptId !== mediaAttempt.current
    )
      return;
    switch (message.type) {
      case "rtcDiagnostic": {
        const summary = rtcDiagnosticSummary(message);
        if (summary)
          mobileDebugLog(
            "info",
            "device-link",
            "remote desktop RTC diagnostic",
            summary,
          );
        break;
      }
      case "nativeViewport":
        if (NativeRemoteDesktopView)
          void nativeViewer.current?.receive(message).catch(() => {});
        break;
      case "nativeCursor":
        webview.current?.postMessage(JSON.stringify(message));
        break;
      case "viewportChanged":
        if (
          typeof message.width === "number" &&
          typeof message.height === "number" &&
          Number.isFinite(message.width) &&
          Number.isFinite(message.height)
        ) {
          viewportGeneration.current += 1;
          setViewerViewport((previous) =>
            previous.width === message.width &&
            previous.height === message.height
              ? previous
              : {
                  width: message.width as number,
                  height: message.height as number,
                },
          );
        }
        break;
      case "channelRequestState":
        // The WebView channel could not take it: nothing ran, use the relay.
        if (typeof message.id === "string" && message.sent !== true)
          channelRequests.current.get(message.id)?.settle({ kind: "relay" });
        break;
      case "channelReply": {
        const reply = parseRemoteDesktopChannelReply({
          ...message,
          type: "reply",
        });
        const pending = reply && channelRequests.current.get(reply.id);
        if (!reply || !pending) break;
        if (reply.ok) pending.settle({ kind: "result", value: reply.result });
        else
          pending.settle(
            // Refused before running, or a read-only result that did not fit.
            reply.error === "DESKTOP_CHANNEL_UNSUPPORTED" ||
              reply.error === "DESKTOP_CHANNEL_BUSY" ||
              (reply.error === "DESKTOP_REPLY_TOO_LARGE" &&
                (pending.op === "displayModes" ||
                  pending.op === "clipboardVersion"))
              ? { kind: "relay" }
              : { kind: "error", code: reply.error },
          );
        break;
      }
      case "viewportSize":
        if (
          typeof message.width === "number" &&
          typeof message.height === "number"
        ) {
          const pending = rememberedFit.current;
          rememberedFit.current = null;
          const base = viewerDisplaySize(message.width, message.height);
          // Reapply the remembered fitted size at this phone's current ratio.
          const remembered =
            pending?.lease === current.lease && pending.edge && base
              ? fittedDisplayModes(base, base).find(
                  (mode) => Math.max(mode.width, mode.height) === pending.edge,
                )
              : undefined;
          if (remembered) {
            // An exact size skips the viewport bookkeeping of a plain fit;
            // record this measurement so restore still recognizes the fit.
            const viewport = { width: message.width, height: message.height };
            setViewerViewport(viewport);
            void fitViewerDisplay(
              remembered.width,
              remembered.height,
              true,
              undefined,
              viewport,
              true,
            );
          } else void fitViewerDisplay(message.width, message.height);
        }
        break;
      case "reconnecting":
        if (message.attemptId === mediaAttempt.current)
          setStatus("reconnecting");
        break;
      case "pipCapability":
        setCanPip(message.supported === true);
        break;
      case "presentationDiagnostic":
        mobileDebugLog(
          "info",
          "lifecycle",
          "remote desktop native presentation diagnostic",
          {
            event: message.event,
            domain: message.domain,
            code: message.code,
            nativeState: message.nativeState,
            sceneState: message.sceneState,
            armed: message.armed,
            authorized: message.authorized,
            possible: message.possible,
            active: message.active,
            suspended: message.suspended,
            starting: message.starting,
            inlineVisible: message.inlineVisible,
            sourceHidden: message.sourceHidden,
            inWindow: message.inWindow,
            ancestorsVisible: message.ancestorsVisible,
            opacity: message.opacity,
            width: message.width,
            height: message.height,
            layerWidth: message.layerWidth,
            layerHeight: message.layerHeight,
            sourceX: message.sourceX,
            sourceY: message.sourceY,
            sourceWidth: message.sourceWidth,
            sourceHeight: message.sourceHeight,
            surfaceHidden: message.surfaceHidden,
            surfaceOpacity: message.surfaceOpacity,
            hasFrame: message.hasFrame,
            playbackReady: message.playbackReady,
            inlineFrameReady: message.inlineFrameReady,
            renderedFrames: message.renderedFrames,
            restoring: message.restoring,
            audioCategory: message.audioCategory,
            audioMode: message.audioMode,
            rtcAudioActive: message.rtcAudioActive,
            rtcAudioActivations: message.rtcAudioActivations,
          },
        );
        break;
      case "presentationStarting":
        if (
          pipEnabledRef.current &&
          !presentation.current &&
          !settingInFlight.current
        )
          void startPresentationRef.current(false);
        break;
      case "presentation":
        // AVKit can start before the Home AppState event / host acknowledgement.
        if (
          NativeRemoteDesktopView &&
          message.active === true &&
          pipEnabledRef.current &&
          !presentation.current &&
          !settingInFlight.current
        )
          void startPresentationRef.current(false);
        mobileDebugLog(
          "info",
          "lifecycle",
          "remote desktop presentation state",
          {
            active: message.active === true,
            previousActive: actualPresentation.current,
            preparing: presentationTimer.current !== null,
            focused: focusedRef.current,
            appState: AppState.currentState,
          },
        );
        const authorized = !NativeRemoteDesktopView || pipPrepared.current;
        if (
          NativeRemoteDesktopView &&
          message.active !== true &&
          actualPresentation.current &&
          !pipPrepared.current &&
          presentationTimer.current !== null &&
          settingInFlight.current &&
          (AppState.currentState !== "active" || !focusedRef.current)
        ) {
          // A window closed before its host handoff completed. Retire the lease
          // so a late ACK cannot leave the host in background-viewing mode.
          pausePresentation(!focusedRef.current);
          if (!focusedRef.current) navigation.current.onEnded?.();
          break;
        }
        if (
          (message.active !== true &&
            actualPresentation.current &&
            !settingInFlight.current) ||
          authorized
        ) {
          if (presentationTimer.current)
            clearTimeout(presentationTimer.current);
          presentationTimer.current = null;
          pendingPresentation.current?.(message.active === true && authorized);
          pendingPresentation.current = null;
        }
        presentation.current = message.active === true;
        actualPresentation.current = presentation.current;
        if (presentation.current && !focusedRef.current)
          navigation.current.onVisibility?.(false);
        if (
          !presentation.current &&
          !focusedRef.current &&
          !restoringPresentation.current
        ) {
          recovery.current.enabled = false;
          if (AppState.currentState === "background") endBackground(true);
          else void stop(false, true);
          navigation.current.onEnded?.();
        } else if (!presentation.current) {
          restoreInlinePresentationRef.current();
          if (!NativeRemoteDesktopView && !videoSettingsRef.current.audio)
            void remotePresentation?.playback(false).catch(() => {});
          if (
            !NativeRemoteDesktopView &&
            AppState.currentState === "background"
          )
            endBackground();
        }
        break;
      case "presentationRestore":
        mobileDebugLog(
          "info",
          "lifecycle",
          "remote desktop native restore requested",
          {
            focused: focusedRef.current,
            pipActive: actualPresentation.current,
            restoring: restoringPresentation.current,
            inlineVisible: message.inlineVisible === true,
            sourceHidden: message.sourceHidden === true,
          },
        );
        restoringPresentation.current = true;
        navigation.current.onVisibility?.(true);
        if (focusedRef.current) {
          send({ type: "restorePresentation" });
          restoringPresentation.current = false;
        } else navigation.current.onRestore?.();
        break;
      case "presentationFailed":
        presentationGeneration.current++;
        settingInFlight.current = false;
        mobileDebugLog(
          "warn",
          "lifecycle",
          "remote desktop presentation failed",
          {
            focused: focusedRef.current,
            appState: AppState.currentState,
            reason: message.reason,
            description: message.description,
            failureReason: message.failureReason,
            underlyingDomain: message.underlyingDomain,
            underlyingCode: message.underlyingCode,
            underlyingDescription: message.underlyingDescription,
            rtcAudioActive: message.rtcAudioActive,
            rtcAudioActivations: message.rtcAudioActivations,
            domain: message.domain,
            code: message.code,
            nativeState: message.nativeState,
            sceneState: message.sceneState,
            possible: message.possible,
            active: message.active,
            authorized: message.authorized,
            armed: message.armed,
            hasFrame: message.hasFrame,
          },
        );
        presentation.current = false;
        actualPresentation.current = false;
        restoreInlinePresentationRef.current();
        pipPrepared.current = false;
        pendingPresentation.current?.(false);
        pendingPresentation.current = null;
        send({ type: "pipPolicy", enabled: false });
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        void request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        }).catch(() => {});
        if (!NativeRemoteDesktopView && !videoSettingsRef.current.audio)
          void remotePresentation?.playback(false).catch(() => {});
        setSettingNotice(t("remoteDesktop.pipUnavailable"));
        setControlPage("controls");
        setOperations(true);
        if (AppState.currentState === "background")
          endBackground(!focusedRef.current);
        else if (!focusedRef.current) void stop(false, true);
        if (!focusedRef.current) navigation.current.onEnded?.();
        break;
      case "videoFrameReady":
        if (mediaAttempt.current === message.attemptId)
          timing.current?.("video-frame-ready");
        break;
      case "streaming":
        if (
          NativeRemoteDesktopView &&
          message.attemptId !== mediaAttempt.current
        )
          return;
        if (NativeRemoteDesktopView)
          webview.current?.postMessage(
            JSON.stringify({
              type: "nativeVideo",
              epoch: current.lease,
              active: true,
            }),
          );
        timing.current?.("video-presented");
        setFrameReady(true);
        setSettingBusy(false);
        recovery.current.delay = 1000;
        streaming.current = true;
        setNetwork(null);
        setStatus("live");
        break;
      case "framePresented":
        timing.current?.("screenshot-presented");
        setFrameReady(true);
        break;
      case "fallback":
        if (
          NativeRemoteDesktopView &&
          message.attemptId !== mediaAttempt.current
        )
          return;
        mobileDebugLog("warn", "lifecycle", "remote desktop media fallback", {
          pipActive: actualPresentation.current,
          appState: AppState.currentState,
          retry: message.retry !== false,
          // Never log signaling, peer identifiers or arbitrary remote text.
          reason: [
            "background",
            "host",
            "disconnected",
            "failed",
            "closed",
            "connect-timeout",
            "answer",
            "offer",
          ].includes(String(message.reason))
            ? String(message.reason)
            : "other",
        });
        if (NativeRemoteDesktopView)
          webview.current?.postMessage(
            JSON.stringify({
              type: "nativeVideo",
              epoch: current.lease,
              active: false,
            }),
          );
        setCanPip(false);
        setSettingBusy(false);
        streaming.current = false;
        abandonChannelRequests();
        receiveWindow.current = {
          since: Date.now(),
          bytes: 0,
          frameMs: null,
          frameAt: 0,
        };
        setNetwork(null);
        setStatus("compatibility");
        break;
      case "network": {
        if (
          !streaming.current ||
          !["video", "direct", "relay"].includes(String(message.transport))
        )
          return;
        const metric = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
            ? value
            : null;
        setNetwork({
          transport: message.transport as DesktopNetworkStats["transport"],
          bytesPerSecond: metric(message.bytesPerSecond),
          latencyMs: metric(message.latencyMs),
          at: Date.now(),
        });
        break;
      }
      case "inputOverflow": {
        // The viewer replaced a stalled queue with a release, then this handler
        // posts control:false, which clears that release without flushing it.
        // Tell the host to drop control (stopInput still injects a native
        // release) so a held key/button cannot stay down while we view only.
        if (!current.controlling) break;
        releaseControl();
        foregroundRestorePending.current = true;
        requestHostControl(current, false);
        break;
      }
      case "input": {
        const ack = {
          type: "ack",
          epoch: current.lease,
          sequence: message.sequence,
        };
        // Entering view only sends one release batch: it must reach the host
        // (which keeps control) even while an older batch is still in flight.
        const releaseOnly =
          Array.isArray(message.events) &&
          message.events.length > 0 &&
          message.events.every(
            (event) => isDesktopInput(event) && event.kind === "release",
          );
        if (
          !current.controlling ||
          (viewOnlyRef.current && !releaseOnly) ||
          (!releaseOnly && inputBusy.current?.lease === current.lease) ||
          !Number.isSafeInteger(message.sequence) ||
          !Array.isArray(message.events) ||
          message.events.length > 64 ||
          !message.events.every(isDesktopInput)
        ) {
          send(ack);
          return;
        }
        const batch = { lease: current.lease };
        if (!releaseOnly) inputBusy.current = batch;
        const ownsBatch = () =>
          active.current === current &&
          (releaseOnly || inputBusy.current === batch);
        const events = message.events;
        void (async () => {
          if (
            NativeRemoteDesktopView &&
            (await nativeViewer.current?.sendInput(message).catch(() => false))
          )
            return;
          // View only may have started while the native attempt was pending.
          if (
            !ownsBatch() ||
            !current.controlling ||
            (viewOnlyRef.current && !releaseOnly)
          )
            return;
          await request({
            op: "input",
            lease: current.lease,
            sequence: message.sequence as number,
            events,
          });
        })()
          .catch((cause) => {
            if (!ownsBatch()) return;
            resolveControlFailure(cause, true);
          })
          .finally(() => {
            if (!ownsBatch()) return;
            if (!releaseOnly) inputBusy.current = null;
            send(ack);
          });
        break;
      }
    }
  };
  const toggleControl = async () => {
    const current = active.current;
    if (
      !current ||
      busy ||
      controlInFlight.current ||
      settingInFlight.current ||
      presentationTimer.current
    )
      return;
    setError(null);
    const viewOnly = !viewOnlySelected;
    viewOnlyRef.current = viewOnly;
    setViewOnlySelected(viewOnly);
    if (viewOnly) {
      // Local only: stop forwarding and release held keys and buttons on the
      // host, which keeps control and its input helper.
      setKeyboard(false);
      send({ type: "control", enabled: false, release: true });
      return;
    }
    if (current.controlling) {
      send({ type: "control", enabled: true });
      return;
    }
    // The host dropped control meanwhile (input failure, overflow or
    // background viewing): leaving view only asks for it again.
    setBusy(true);
    try {
      pipPrepared.current = false;
      presentationGeneration.current++;
      send({ type: "pipPolicy", enabled: false });
      if (presentation.current) {
        presentation.current = false;
        send({ type: "presentation", enabled: false });
      }
      if (pendingHostControl.current === false) {
        // Overflow timed out with an unconfirmed host release. Taking control
        // first would skip stopInput while a key/button may still be held.
        const released = await request<{ controlling: boolean }>({
          op: "control",
          lease: current.lease,
          enabled: false,
        });
        if (active.current !== current) return;
        applyConfirmedControl(current, released.controlling);
        if (released.controlling) return;
      }
      await requestHostControl(current, true);
    } catch (cause) {
      // Taking control can fail because this computer cannot inject input right
      // now. Stay usable for viewing and let the user retry; a session rebuild
      // would cost the picture and the lease for a control-only fault.
      if (active.current === current) resolveControlFailure(cause);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const changeVideoSettings = async (
    patch: Partial<RemoteDesktopVideoSettings>,
    applyPending = false,
  ) => {
    const settings = { ...videoSettingsRef.current, ...patch };
    const audioChanged = settings.audio !== videoSettingsRef.current.audio;
    if (!active.current || !caps?.videoSettings) return;
    if (!applyPending && !audioChanged) {
      // Selection is immediate; negotiation consumes only the newest choice.
      pendingVideoSettings.current = active.current;
      videoSettingsRef.current = settings;
      setVideoSettings(settings);
      return;
    }
    if (
      !active.current ||
      !caps?.videoSettings ||
      settingInFlight.current ||
      settingBusy
    )
      return;
    const current = active.current;
    settingInFlight.current = true;
    setSettingBusy(true);
    setSettingNotice(null);
    try {
      // Preserve the pending fullscreen control restoration until AVKit stops.
      if (!presentation.current && !actualPresentation.current)
        pipPrepared.current = false;
      presentationGeneration.current++;
      send({ type: "pipPolicy", enabled: false });
      const wasPresenting = presentation.current;
      if (wasPresenting) {
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        presentation.current = false;
        send({ type: "presentation", enabled: false });
        await request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        });
      }
      if (audioChanged || wasPresenting)
        await remotePresentation?.playback(
          Boolean(NativeRemoteDesktopView) ||
            settings.audio ||
            pipEnabledRef.current,
        );
      if (active.current !== current) return;
      if (audioChanged) audioUnavailable.current = false;
      const latest = { ...videoSettingsRef.current, audio: settings.audio };
      videoSettingsRef.current = latest;
      setVideoSettings(latest);
      pendingVideoSettings.current = null;
      streaming.current = false;
      abandonChannelRequests();
      setCanPip(false);
      send({ type: "videoSettings", audio: settings.audio });
    } catch {
      if (active.current === current) {
        setSettingNotice(t("remoteDesktop.settingFailed"));
        setSettingBusy(false);
      }
    } finally {
      settingInFlight.current = false;
      if (active.current === current && foregroundRestorePending.current)
        restoreInlinePresentationRef.current();
      if (alive.current) setSettingsRevision((value) => value + 1);
    }
  };
  applyPendingVideoSettings.current = () => {
    void changeVideoSettings(videoSettingsRef.current, true);
  };
  useEffect(() => {
    if (
      !pendingVideoSettings.current ||
      pendingVideoSettings.current !== active.current ||
      settingBusy ||
      settingInFlight.current ||
      pendingMediaOffers.current.has(active.current!) ||
      (status !== "live" && status !== "compatibility")
    )
      return;
    pendingVideoSettings.current = null;
    applyPendingVideoSettings.current();
  }, [videoSettings, settingBusy, settingsRevision, status, lease]);
  nativeMessage.current = onMessage;
  const startPresentation = async (enter = true) => {
    const current = active.current;
    const restoration = controlRestoration.current;
    if (
      !current ||
      !caps?.backgroundViewing ||
      (NativeRemoteDesktopView ? !frameReady : !canPip) ||
      !remotePresentation ||
      (controlInFlight.current && !restoration) ||
      settingInFlight.current
    ) {
      pendingPresentation.current?.(false);
      pendingPresentation.current = null;
      // A saved preference alone cannot keep an invisible lease alive. Back
      // already handles refusal via its waiter; route blur has no such waiter.
      // Do not interrupt another transition that already owns presentation.
      if (
        !focusedRef.current &&
        !presentation.current &&
        !actualPresentation.current
      ) {
        leaving.current = true;
        setIsLeaving(true);
        pausePresentation(true);
        navigation.current.onEnded?.();
      }
      return;
    }
    settingInFlight.current = true;
    const startedAt = performance.now();
    const alreadyAuthorized = Boolean(
      NativeRemoteDesktopView &&
        pipPrepared.current &&
        !restoration &&
        !foregroundRestorePending.current,
    );
    // The retained flag belongs to the PiP being restored. A new entry must
    // obtain its own authorization after that request, within its own deadline.
    if (restoration || foregroundRestorePending.current)
      pipPrepared.current = false;
    const finishTransition = linkRef.current.beginBackgroundTransition?.();
    finishBackgroundTransition.current = finishTransition ?? null;
    presentationReturnedToActive.current = false;
    setSettingNotice(null);
    const transition = ++presentationGeneration.current;
    const currentTransition = () =>
      active.current === current &&
      presentationGeneration.current === transition;
    // Reserve this bounded transition immediately, including native willStart
    // arriving before JS sees inactive. System readiness is not host permission.
    presentation.current = true;
    send({
      type: "pipPolicy",
      enabled: pipEnabledRef.current,
      preparing: true,
      authorized: alreadyAuthorized,
    });
    if (presentationTimer.current) clearTimeout(presentationTimer.current);
    presentationTimer.current = setTimeout(() => {
      if (!currentTransition()) return;
      mobileDebugLog(
        "warn",
        "lifecycle",
        "remote desktop presentation deadline",
        {
          elapsedMs: Math.round(performance.now() - startedAt),
          active: actualPresentation.current,
          authorized: pipPrepared.current,
        },
      );
      pendingPresentation.current?.(false);
      pendingPresentation.current = null;
      setSettingNotice(t("remoteDesktop.pipUnavailable"));
      setControlPage("controls");
      setOperations(true);
      pausePresentation(!focusedRef.current);
      if (!focusedRef.current) navigation.current.onEnded?.();
    }, BACKGROUND_TRANSITION_TIMEOUT_MS);
    try {
      // Finish foreground restoration before asking the host to release input
      // again; a late control grant must never overtake background authorization.
      if (restoration) await restoration;
      if (!currentTransition()) return;
      await remotePresentation.playback(true);
      if (!currentTransition()) return;
      if (!alreadyAuthorized)
        await request({
          op: "presentation",
          lease: current.lease,
          enabled: true,
        });
      if (!currentTransition()) return;
      mobileDebugLog(
        "info",
        "lifecycle",
        "remote desktop presentation authorized",
        {
          elapsedMs: Math.round(performance.now() - startedAt),
          enter,
          reused: alreadyAuthorized,
          appState: AppState.currentState,
        },
      );
      send({ type: "control", enabled: false });
      current.controlling = false;
      // Background presentation temporarily releases input; it does not
      // change the user's fullscreen control preference.
      setKeyboard(false);
      setLease({ ...current });
      pipPrepared.current = true;
      send({
        type: "pipPolicy",
        enabled: pipEnabledRef.current,
        authorized: true,
      });
      if (actualPresentation.current) {
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        pendingPresentation.current?.(true);
        pendingPresentation.current = null;
      }
      if (
        !enter &&
        presentationReturnedToActive.current &&
        AppState.currentState === "active" &&
        !actualPresentation.current
      ) {
        presentation.current = actualPresentation.current;
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        restoreInlinePresentationRef.current();
        return;
      }
      presentation.current = true;
      setOperations(false);
      // Automatic Home entry is already armed; never attempt a late manual
      // start from background. Explicit in-app Back still requests AVKit here.
      if (enter && !actualPresentation.current)
        send({ type: "presentation", enabled: true });
    } catch {
      if (!currentTransition()) return;
      pendingPresentation.current?.(false);
      pendingPresentation.current = null;
      if (active.current !== current) return;
      presentation.current = false;
      if (!NativeRemoteDesktopView && !videoSettingsRef.current.audio)
        void remotePresentation?.playback(false).catch(() => {});
      setSettingNotice(t("remoteDesktop.pipUnavailable"));
      pausePresentation(!focusedRef.current);
      if (!focusedRef.current) navigation.current.onEnded?.();
    } finally {
      finishTransition?.();
      if (finishBackgroundTransition.current === finishTransition)
        finishBackgroundTransition.current = null;
      if (presentationGeneration.current === transition)
        settingInFlight.current = false;
      if (currentTransition()) restoreInlinePresentationRef.current();
      if (alive.current) setSettingsRevision((value) => value + 1);
    }
  };
  startPresentationRef.current = startPresentation;
  useEffect(() => {
    if (!NativeRemoteDesktopView || !lease) return;
    send({
      type: "pipPolicy",
      enabled:
        pipEnabled &&
        frameReady &&
        caps?.backgroundViewing === true &&
        !settingBusy,
    });
  }, [
    pipEnabled,
    frameReady,
    caps?.backgroundViewing,
    settingBusy,
    settingsRevision,
    lease?.lease,
    lease?.controlling,
    send,
  ]);
  const togglePictureInPicture = () => {
    const enabled = !pipEnabledRef.current;
    pipEnabledRef.current = enabled;
    setPipEnabled(enabled);
    if (enabled) {
      // The native option is persistent intent, not an immediate PiP action.
      if (!NativeRemoteDesktopView) void startPresentationRef.current();
    } else {
      if (presentationTimer.current) {
        pause();
        return;
      }
      presentationGeneration.current++;
      send({ type: "pipPolicy", enabled: false });
      send({ type: "presentation", enabled: false });
      foregroundRestorePending.current ||= pipPrepared.current;
      pipPrepared.current = false;
      const current = active.current;
      if (current)
        void request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        }).catch(() => {});
      if (!NativeRemoteDesktopView && !videoSettingsRef.current.audio)
        void remotePresentation?.playback(false).catch(() => {});
    }
  };
  const readResolutionModes = async (): Promise<RemoteDesktopDisplayMode[]> => {
    const current = active.current;
    if (!current) return [];
    if (fittedDisplay)
      return fittedDisplayModes(fittedDisplay, current.display);
    const { width, height } = current.display;
    const modes = await request<RemoteDesktopDisplayMode[]>({
      op: "displayModes",
      lease: current.lease,
    });
    noteHostMode(current.lease, modes);
    // CoreGraphics modes keep their own orientation when Electron's display
    // geometry is rotated. Compare modes in the enumeration's coordinate space.
    const reference = modes.find((mode) => mode.current) ?? { width, height };
    return modes.filter((mode) =>
      matchesViewer(mode, reference.width, reference.height),
    );
  };
  // The settings list was just read from the host; reusing its entry saves a
  // round trip. The host still rejects a mode that no longer exists.
  const changeResolution = async (mode: RemoteDesktopDisplayMode) => {
    const current = active.current;
    if (!current?.controlling || settingInFlight.current) return;
    if (
      (caps?.resolutionRestore ||
        (caps?.viewerDisplay && caps.viewerDisplayRestore)) &&
      (caps?.resolutionRestore ||
        [mode.width, mode.height].every((size) => size >= 320 && size <= 2560))
    ) {
      await fitViewerDisplay(
        mode.width,
        mode.height,
        true,
        !fittedDisplay && caps?.resolutionRestore ? mode.id : undefined,
      );
      return;
    }
    setSettingNotice(t("remoteDesktop.settingUnsupported"));
  };
  const fitViewerDisplay = async (
    width: number,
    height: number,
    exactResolution = false,
    modeId?: string,
    viewport?: { width: number; height: number },
    remembered = false,
    restore = false,
  ) => {
    const current = active.current;
    if (
      exactResolution &&
      !modeId &&
      ![width, height].every(
        (value) => Number.isInteger(value) && value >= 320 && value <= 2560,
      )
    ) {
      setSettingNotice(t("remoteDesktop.settingUnsupported"));
      return;
    }
    const size = exactResolution
      ? { width, height }
      : ((fitEdge.current
          ? viewerDisplaySize(width, height, fitEdge.current)
          : null) ?? viewerDisplaySize(width, height));
    if (
      !current?.controlling ||
      !(modeId ? caps?.resolutionRestore : caps?.viewerDisplay) ||
      !size ||
      settingInFlight.current ||
      settingBusy ||
      controlInFlight.current
    )
      return;
    settingInFlight.current = true;
    fittedViewport.current =
      viewport ??
      (exactResolution ? viewerViewportRef.current : { width, height });
    setSettingBusy(true);
    setSettingNotice(null);
    const sourceDisplayId = recovery.current.displayId || current.display.id;
    send({ type: "control", enabled: false });
    // A host that can follow display changes keeps the running stream; only a
    // response without `videoKept` falls back to rebuilding it.
    const keepVideo = caps?.liveDisplaySwitch === true;
    try {
      if (!keepVideo) viewerMedia.reset();
      const requestGeneration = viewportGeneration.current;
      if (!keepVideo)
        icePrefetch.current = {
          at: Date.now(),
          servers: loadIceServers("display"),
        };
      const { videoKept, ...next } = await viewerSession.current.fitDisplay(
        size.width,
        size.height,
        restore,
        modeId,
        keepVideo,
        caps?.autoControl === true,
      );
      if (active.current !== current) return;
      // Reconnect the physical source display after the temporary mirror ends.
      recovery.current.displayId = sourceDisplayId;
      fitEdge.current =
        modeId || restore ? null : Math.max(size.width, size.height);
      // The next connection reapplies this choice; restoring or choosing the
      // computer's own mode again forgets it.
      const fittedTo =
        viewport ??
        (exactResolution ? viewerViewportRef.current : { width, height });
      const ownMode =
        hostMode.current?.lease === current.lease &&
        hostMode.current.modeId === modeId;
      void rememberResolution(
        deviceId,
        sourceDisplayId,
        restore || (modeId && ownMode)
          ? null
          : modeId
            ? { kind: "mode", modeId, width, height }
            : fittedTo.width > 0 && fittedTo.height > 0
              ? {
                  // The requested size, not the host's logical one: a HiDPI
                  // host may answer with a smaller mode of the same ratio,
                  // which must not shrink the request on every reconnect.
                  kind: "fit",
                  width: size.width,
                  height: size.height,
                  viewport: { ...fittedTo },
                  window: {
                    width: Math.round(windowSizeRef.current.width),
                    height: Math.round(windowSizeRef.current.height),
                  },
                }
              : null,
      );
      if (!exactResolution && viewportGeneration.current === requestGeneration)
        setViewerViewport({ width, height });
      // Fitted sizes are offered around the plain fit of the viewport.
      const fittedBase = viewport
        ? viewerDisplaySize(viewport.width, viewport.height)
        : null;
      setFittedDisplay((previous) =>
        modeId || restore
          ? null
          : exactResolution && (previous ?? fittedBase)
            ? (previous ?? fittedBase)
            : { width: next.display.width, height: next.display.height },
      );
      setLease({ ...next });
      const geometry = {
        width: next.display.width,
        height: next.display.height,
        restore: restore || Boolean(modeId),
      };
      if (videoKept) send({ type: "displayGeometry", ...geometry });
      else {
        if (keepVideo) viewerMedia.reset();
        streaming.current = false;
        abandonChannelRequests();
        setCanPip(false);
        send({
          type: "videoSettings",
          ...geometry,
          audio: Boolean(caps?.systemAudio && videoSettingsRef.current.audio),
        });
      }
      // A host with `autoControl` already restarted input on the new geometry.
      const control = next.controlling
        ? { controlling: true }
        : await viewerSession.current.control(true);
      if (active.current === current)
        applyConfirmedControl(current, control.controlling);
    } catch (cause) {
      // A reconnect must not retry a remembered choice that just failed.
      if (remembered) rememberedDisplayGaveUp.current = true;
      if (active.current === current) {
        setSettingNotice(t("remoteDesktop.settingFailed"));
        if ((cause as { code?: string })?.code === "INVOKE_TIMEOUT")
          fail(cause);
        else resolveControlFailure(cause);
      }
    } finally {
      settingInFlight.current = false;
      setSettingBusy(false);
      if (active.current === current && foregroundRestorePending.current)
        restoreInlinePresentationRef.current();
    }
  };
  // The host restores its own mode when a viewer leaves. Reapply this phone's
  // last choice once per lease: before the first video offer when possible,
  // otherwise after control and the first frame are ready.
  const rememberedResolutionLease = useRef<string | null>(null);
  // One early failure (for example a locked computer refusing the change)
  // leaves later connections in this screen to the after-frame path.
  const earlyDisplayFailed = useRef(false);
  // A remembered change that failed once and rebuilt the connection is not
  // retried in this screen, so a persistent failure cannot loop reconnects.
  const rememberedDisplayGaveUp = useRef(false);
  // The early change is optional: a failure keeps the connection going and the
  // after-frame path retries. Once the display change was sent, the host ends
  // the lease on any failure except a refusal before touching the display;
  // a lost reply leaves the geometry unknown, as for a manual change.
  const earlyDisplayFailureEndsConnection = (
    cause: unknown,
    displayChangeSent: boolean,
  ) => {
    const code = remoteDesktopErrorCode(cause);
    if (code === "DESKTOP_LEASE_EXPIRED" || code === "DESKTOP_STOPPED")
      return true;
    return (
      displayChangeSent &&
      code !== "DESKTOP_VIEW_ONLY" &&
      code !== "DESKTOP_DISPLAY_BUSY" &&
      code !== "DESKTOP_INPUT_BUSY"
    );
  };
  applyRememberedDisplay.current = async (current, hostCaps, isCurrent) => {
    if (
      earlyDisplayFailed.current ||
      rememberedDisplayGaveUp.current ||
      !hostCaps.canControl
    )
      return false;
    const remembered = await readRememberedResolution(
      deviceId,
      current.display.id,
    );
    if (!remembered || !isCurrent()) return false;
    const fit = remembered.kind === "fit";
    if (fit ? !hostCaps.viewerDisplay : !hostCaps.resolutionRestore)
      return false;
    // The viewer cannot measure its picture area before video, so reuse the
    // fitted size only in the same app window. Rotation, folding, split view
    // or a resize changes it; the after-frame path then measures this view.
    if (
      fit &&
      (remembered.window?.width !== Math.round(windowSize.width) ||
        remembered.window?.height !== Math.round(windowSize.height))
    )
      return false;
    let displayChangeSent = false;
    try {
      let modeId: string | undefined;
      if (!fit) {
        const modes = await request<RemoteDesktopDisplayMode[]>({
          op: "displayModes",
          lease: current.lease,
        });
        if (!isCurrent()) return false;
        noteHostMode(current.lease, modes);
        const mode = findRememberedMode(modes, remembered);
        if (!mode) return false;
        rememberedResolutionLease.current = current.lease;
        if (mode.current) return false;
        modeId = mode.id;
      }
      const control = current.controlling
        ? { controlling: true }
        : await viewerSession.current.control(true);
      if (!isCurrent() || !control.controlling) return false;
      displayChangeSent = true;
      await viewerSession.current.fitDisplay(
        remembered.width,
        remembered.height,
        false,
        modeId,
        false,
        hostCaps.autoControl === true,
      );
      if (!isCurrent()) return false;
      rememberedResolutionLease.current = current.lease;
      if (fit) {
        fitEdge.current = Math.max(remembered.width, remembered.height);
        fittedViewport.current = remembered.viewport;
        // Same bookkeeping as fitting by hand, so restore is offered.
        setFittedDisplay(
          viewerDisplaySize(
            remembered.viewport.width,
            remembered.viewport.height,
          ) ?? { width: current.display.width, height: current.display.height },
        );
        setViewerViewport(remembered.viewport);
      }
      return true;
    } catch (cause) {
      earlyDisplayFailed.current = true;
      // Let the after-frame path reapply the choice for this lease.
      if (rememberedResolutionLease.current === current.lease)
        rememberedResolutionLease.current = null;
      if (
        isCurrent() &&
        earlyDisplayFailureEndsConnection(cause, displayChangeSent)
      ) {
        rememberedDisplayGaveUp.current = true;
        throw cause;
      }
      return false;
    }
  };
  useEffect(() => {
    const current = active.current;
    if (
      !current?.controlling ||
      !controlReady ||
      !frameReady ||
      !(caps?.resolutionRestore || caps?.viewerDisplay) ||
      fittedDisplay ||
      rememberedDisplayGaveUp.current ||
      rememberedResolutionLease.current === current.lease
    )
      return;
    rememberedResolutionLease.current = current.lease;
    const displayId = recovery.current.displayId || current.display.id;
    const { id, width, height } = current.display;
    // A display change the user made meanwhile wins over the remembered one.
    const unchanged = () =>
      active.current === current &&
      current.display.id === id &&
      current.display.width === width &&
      current.display.height === height;
    void (async () => {
      const remembered = await readRememberedResolution(deviceId, displayId);
      if (!remembered) return;
      await unlockAttempt.current;
      if (!unchanged()) return;
      if (remembered.kind === "fit") {
        // Same path as the button: measure this phone now, then fit.
        if (!caps?.viewerDisplay) return;
        rememberedFit.current = {
          lease: current.lease,
          edge: Math.max(remembered.width, remembered.height),
        };
        send({ type: "measureViewport" });
        return;
      }
      if (!caps?.resolutionRestore) return;
      const mode = findRememberedMode(await readResolutionModes(), remembered);
      if (!mode || mode.current || !unchanged()) return;
      await fitViewerDisplay(
        mode.width,
        mode.height,
        true,
        mode.id,
        undefined,
        true,
      );
    })().catch(() => {});
  }, [
    controlReady,
    frameReady,
    lease?.lease,
    lease?.controlling,
    caps?.resolutionRestore,
    caps?.viewerDisplay,
    fittedDisplay,
  ]);
  // Rotation, split view, folding and retro skins all report the actual picture
  // area through viewportChanged. If it changes during a request, the busy flag
  // settling re-runs this effect with the latest size.
  useEffect(() => {
    if (
      !fittedDisplay ||
      !caps?.viewerDisplay ||
      !focused ||
      appState !== "active" ||
      !controlReady ||
      !frameReady ||
      !lease?.controlling ||
      settingBusy ||
      settingInFlight.current ||
      controlInFlight.current ||
      // The keyboard only covers part of the picture area; the computer keeps
      // its size, and closing it returns to the size that was fitted.
      keyboard ||
      !viewerDisplaySize(viewerViewport.width, viewerViewport.height) ||
      (fittedViewport.current.width === viewerViewport.width &&
        fittedViewport.current.height === viewerViewport.height)
    )
      return;
    // Rotation delivers window bounds, safe areas and toolbar measurements in
    // separate turns. Apply only the settled area; a new layout or leaving this
    // screen cancels the pending request. In-flight changes are picked up when
    // settingBusy clears, using the latest viewport rather than a queued size.
    const timer = setTimeout(() => {
      void fitViewerDisplay(viewerViewport.width, viewerViewport.height);
    }, 200);
    return () => clearTimeout(timer);
  }, [
    viewerViewport,
    fittedDisplay,
    caps?.viewerDisplay,
    focused,
    appState,
    controlReady,
    frameReady,
    lease?.controlling,
    settingBusy,
    keyboard,
  ]);

  const toggleFitDisplay = () => {
    if (!fittedDisplay) {
      send({ type: "measureViewport" });
    } else if (caps?.viewerDisplayRestore) {
      void fitViewerDisplay(
        fittedDisplay.width,
        fittedDisplay.height,
        false,
        undefined,
        undefined,
        false,
        true,
      );
    } else {
      setFittedDisplay(null);
      fitEdge.current = null;
      const current = active.current;
      if (current)
        void rememberResolution(
          deviceId,
          recovery.current.displayId || current.display.id,
          null,
        );
    }
  };
  const shortcut = (keys: string[]) =>
    send({
      type: "events",
      events: [
        ...keys.map((code) => ({ kind: "key", code, down: true })),
        ...keys
          .toReversed()
          .map((code) => ({ kind: "key", code, down: false })),
      ],
    });
  const workspaceAction = (
    action: "workspaceLeft" | "workspaceRight" | "omarchyMenu",
  ) => {
    if (!lease || !canInput) return;
    const current = active.current;
    void request({ op: "windowAction", action, lease: lease.lease }).catch(
      () => {
        if (active.current === current)
          Alert.alert(
            t(`remoteDesktop.${action}`),
            t("remoteDesktop.settingFailed"),
          );
      },
    );
  };
  const button = (
    label: string,
    onPress: () => void,
    selected = false,
    disabled = false,
    key = label,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        selected && styles.selected,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  const keyLabel = (code: string) => {
    if (caps?.platform === "darwin") {
      const mac: Record<string, string> = {
        ControlLeft: "Control",
        AltLeft: "Option",
        MetaLeft: "Command",
        Enter: "Return",
        Delete: "⌦",
      };
      if (mac[code]) return mac[code];
    }
    if (code === "MetaLeft")
      return caps?.platform === "win32"
        ? "Win"
        : caps?.platform === "linux"
          ? "Super"
          : "Meta";
    if (code === "Backspace" && caps?.platform !== "darwin") return "Backspace";
    return LABELS[code] ?? code.replace(/^Key|^Digit/, "");
  };
  const openWindows = () => {
    if (caps?.windowActions) {
      setOperations(false);
      Keyboard.dismiss();
      setKeyboard(false);
      setWindowsOpen(true);
      return;
    }
    shortcut(
      caps?.platform === "darwin"
        ? ["ControlLeft", "ArrowUp"]
        : ["MetaLeft", "Tab"],
    );
  };
  const showDesktop = () =>
    caps?.windowActions && lease && canInput
      ? void request({
          op: "windowAction",
          action: "desktop",
          lease: lease.lease,
        }).catch(() =>
          Alert.alert(
            t("remoteDesktop.showDesktop"),
            t("remoteDesktop.settingFailed"),
          ),
        )
      : shortcut(caps?.platform === "darwin" ? ["F11"] : ["MetaLeft", "KeyD"]);
  const toggleOperations = () => {
    Keyboard.dismiss();
    setKeyboard(false);
    send({ type: "events", events: [{ kind: "release" }] });
    setOperations(!operations);
  };
  const foldKeyInputAllowed = () =>
    inputAllowed(Boolean(active.current?.controlling));
  const openFoldInputMethod = () => {
    setOperations(false);
    setKeyboard(true);
    selectKeyboardMode(false);
  };
  const foldUndo = () =>
    shortcut([
      caps?.platform === "darwin" ? "MetaLeft" : "ControlLeft",
      "KeyZ",
    ]);
  const foldRedo = () =>
    shortcut(
      caps?.platform === "darwin"
        ? ["MetaLeft", "ShiftLeft", "KeyZ"]
        : ["ControlLeft", "KeyY"],
    );
  // Desktop-level shortcuts cannot reach anything in a single-window handoff.
  const foldDesktopAction = {
    id: "desktop",
    label: t("remoteDesktop.showDesktop"),
    Icon: ShowDesktopIcon,
    press: showDesktop,
  };
  const foldSystemActions: SystemKeyAction[] = handoff
    ? []
    : caps?.workspaceNavigation
      ? [
          ...(caps.omarchyMenu
            ? [
                {
                  id: "omarchyMenu",
                  label: t("remoteDesktop.omarchyMenu"),
                  Icon: OmarchyMenuIcon,
                  press: () => workspaceAction("omarchyMenu"),
                },
              ]
            : []),
          {
            id: "workspaceLeft",
            label: t("remoteDesktop.workspaceLeft"),
            Icon: WorkspaceLeftIcon,
            press: () => workspaceAction("workspaceLeft"),
          },
          {
            id: "workspaceRight",
            label: t("remoteDesktop.workspaceRight"),
            Icon: WorkspaceRightIcon,
            press: () => workspaceAction("workspaceRight"),
          },
        ]
      : [
          {
            id: "search",
            label:
              caps?.platform === "darwin"
                ? "Spotlight"
                : t("remoteDesktop.keySearch"),
            Icon: Search,
            press: () =>
              shortcut(
                caps?.platform === "darwin"
                  ? ["MetaLeft", "Space"]
                  : caps?.platform === "win32"
                    ? ["MetaLeft", "KeyS"]
                    : ["MetaLeft"],
              ),
          },
          {
            id: "overview",
            label:
              caps?.platform === "darwin"
                ? "Mission Control"
                : t("remoteDesktop.keyTaskView"),
            Icon: LayoutGrid,
            press: () =>
              shortcut(
                caps?.platform === "darwin"
                  ? ["ControlLeft", "ArrowUp"]
                  : ["MetaLeft", "Tab"],
              ),
          },
          // Cindy's own window list when the host offers it; otherwise App Exposé.
          ...(caps?.windowActions
            ? [
                {
                  id: "windows",
                  label: t("remoteDesktop.allWindows"),
                  Icon: AllWindowsIcon,
                  press: openWindows,
                },
              ]
            : caps?.platform === "darwin"
              ? [
                  {
                    id: "windows",
                    label: t("remoteDesktop.keyAppWindows"),
                    Icon: AllWindowsIcon,
                    press: () => shortcut(["ControlLeft", "ArrowDown"]),
                  },
                ]
              : []),
          foldDesktopAction,
        ];
  const foldDeckInsets = {
    top: Math.max(0, foldControls.y - hardwareControls.y),
    bottom: Math.max(0, geometry.height - foldControls.y - foldControls.height),
    left: foldControls.x,
    right: Math.max(0, geometry.width - foldControls.x - foldControls.width),
  };
  // A device screen turns with the phone by default: hold the phone sideways
  // and the device goes landscape; upright again, and it turns back. Turning
  // it by hand (an iPad on an iPhone, a landscape game, upside down) stops
  // following, and the device stays put whatever the phone does. `turn`
  // counts quarter turns clockwise from portrait, as the plugin does.
  const [turn, setTurn] = useState<number | null>(null);
  const [picture, setPicture] = useState<LiveScreenPicture>("fit");
  const [zoomEditing, setZoomEditing] = useState(false);
  const deviceTurn = useRef<string | null>(null);
  const hasButton = (id: string) =>
    Boolean(lease?.screen?.buttons.some((b) => b.id === id));
  const turnable =
    hasButton("orientation-portrait") && hasButton("orientation-landscape");
  const rotatable = hasButton("rotate-left") && hasButton("rotate-right");
  const following = turn === null;
  // Following matches the window's own shape. Not `landscape`, which also
  // means a system side rail: iPhone Duo's cover screen has one upright.
  const deviceLandscape = following
    ? orientationSize.width > orientationSize.height
    : turn % 2 === 1;
  // Follow the device's shape as it turns: the host answers a screenShape
  // request once the shape differs from the one we know (or after a few
  // seconds), so one request is always waiting. Older hosts refuse it; then
  // heartbeats, or the guess, carry the shape instead.
  const leaseId = lease?.lease;
  const watchesShape = Boolean(lease?.screen) && frameReady;
  useEffect(() => {
    const current = active.current;
    if (!watchesShape || !current?.screen) return;
    let stopped = false;
    let known: { width: number; height: number } | null = null;
    void (async () => {
      while (!stopped && active.current === current) {
        try {
          const result = await request<{ shape?: unknown }>({
            op: "screenShape",
            lease: current.lease,
            ...(known ? { known } : {}),
          });
          const shape = liveScreenShape(result.shape);
          if (stopped || active.current !== current) return;
          if (
            shape &&
            (shape.width !== known?.width || shape.height !== known?.height)
          ) {
            known = shape;
            setDeviceShape({ lease: current.lease, ...shape });
          } else {
            // Nothing new (a host that answers at once): never spin.
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (cause) {
          const code = (cause as { code?: unknown })?.code;
          if (code === "INVALID_REQUEST" || code === "DESKTOP_SCREEN_ONLY")
            return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [watchesShape, leaseId, request]);
  useEffect(() => {
    if (!lease || !frameReady || !canInput) return;
    if (following) {
      if (!turnable) return;
      const pose = `${lease.lease}:${deviceLandscape}`;
      if (deviceTurn.current !== pose) {
        deviceTurn.current = pose;
        send({
          type: "events",
          events: [
            {
              kind: "press",
              button: deviceLandscape
                ? "orientation-landscape"
                : "orientation-portrait",
            },
          ],
        });
      }
    }
  }, [lease, turnable, following, frameReady, canInput, deviceLandscape, send]);
  // Lay the picture out at the shape the device shows. The host reports it
  // (a pose the device or app refuses, such as upside down, changes nothing;
  // an app may also turn the device itself); older hosts do not, and then the
  // pose asked for is the best guess.
  const reported = deviceShape?.lease === lease?.lease ? deviceShape : null;
  useEffect(() => {
    if (!lease?.screen || !frameReady) return;
    const { width, height } = lease.display;
    let shape = reported;
    if (!shape) {
      if ((following && !turnable) || width > height === deviceLandscape)
        return;
      shape = { lease: lease.lease, width: height, height: width };
    }
    if (shape.width === width && shape.height === height) return;
    const display = {
      ...lease.display,
      width: shape.width,
      height: shape.height,
    };
    send({ type: "displayGeometry", ...display, restore: true });
    setLease({ ...lease, display });
  }, [lease, reported, following, turnable, frameReady, deviceLandscape, send]);
  const rotateDevice = (direction: "left" | "right") => {
    if (!canInput) return;
    // Following, the device was last set upright or to landscape-left.
    const from = turn ?? (deviceLandscape ? 1 : 0);
    deviceTurn.current = null;
    send({
      type: "events",
      events: [{ kind: "press", button: `rotate-${direction}` }],
    });
    setTurn((from + (direction === "right" ? 1 : 3)) % 4);
  };
  // Filling depends on both shapes: size it again whenever either one turns.
  // A free zoom does not survive a new shape; the picture fits again.
  const pictureShape = `${lease?.display.width}x${lease?.display.height}:${landscape}`;
  useEffect(() => {
    if (!frameReady || !lease?.screen) return;
    if (picture === "fill") send({ type: "fill" });
  }, [frameReady, lease?.screen, picture, pictureShape, send]);
  const shapeRef = useRef(pictureShape);
  useEffect(() => {
    if (shapeRef.current === pictureShape) return;
    shapeRef.current = pictureShape;
    if (picture !== "zoom") return;
    setPicture("fit");
    setZoomEditing(false);
  }, [picture, pictureShape]);
  const changePicture = (next: LiveScreenPicture) => {
    setPicture(next);
    setZoomEditing(next === "zoom");
    if (next === "fit") send({ type: "fit" });
    if (next === "fill") send({ type: "fill" });
  };
  // Fingers on a live screen are device touches, except while zooming the
  // picture: then they pan and pinch it, and nothing reaches the device.
  // A reloaded viewer and a new lease start without either setting (touches
  // would become desktop pointers the host refuses), so send them again.
  const liveScreenTouches = lease?.screen ? lease.screen.maxTouches : null;
  useEffect(() => {
    if (!frameReady) return;
    send(
      liveScreenTouches === null || zoomEditing
        ? { type: "deviceTouch", enabled: false }
        : { type: "deviceTouch", enabled: true, maxTouches: liveScreenTouches },
    );
  }, [
    frameReady,
    liveScreenTouches,
    zoomEditing,
    leaseId,
    viewerReadyRevision,
    send,
  ]);
  const wasZooming = useRef(false);
  useEffect(() => {
    if (zoomEditing) send({ type: "mode", mode: "pan" });
    // Done zooming: hand the fingers back. Otherwise the desktop mode effect
    // and connect already own `mode`.
    else if (wasZooming.current && frameReady) send({ type: "mode", mode });
    wasZooming.current = zoomEditing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomEditing, leaseId, viewerReadyRevision]);
  const selectKeyboardMode = (computer: boolean) => {
    send({ type: "events", events: [{ kind: "release" }] });
    setAwaitingSystemKeyboard(
      !computer && fullKeys && keyboard && Platform.OS === "ios",
    );
    setFullKeys(computer);
    if (!computer) setKeyboardFocusRequest((value) => value + 1);
  };
  const keyboardCompact =
    (foldLayout ? foldControls.width : windowSize.width) < 560;
  const panelBottomPadding = foldLayout
    ? 0
    : panelKeys
      ? Math.max(spacing.sm, insets.bottom)
      : spacing.xs;
  const rememberedKeyboard =
    systemKeyboardHeight.current[landscape ? "landscape" : "portrait"];
  const keysHeight = rememberedKeyboard
    ? rememberedKeyboard - panelBottomPadding + spacing.xs
    : landscape
      ? 180
      : keyboardCompact
        ? 276
        : 300;
  const keyboardSurfaceHeight = Math.min(
    KEY_BAR_HEIGHT +
      Math.max(
        landscape ? 160 : 220,
        Math.min(landscape ? 240 : 320, keysHeight),
      ),
    foldLayout ? foldControls.height : windowSize.height * 0.7,
  );
  const keySurface = {
    onKeyDown: (code: string) => {
      const feedback = remotePresentation?.keyFeedbackForSkin
        ? remotePresentation.keyFeedbackForSkin(
            retroDesktop ? foldSkin : "modern",
            code,
          )
        : remotePresentation?.keyFeedback?.();
      void feedback?.catch(() => {});
    },
    platform: caps?.platform,
    // Inactive already released host input; latched modifiers must not outlive it.
    enabled: canInput && appState === "active",
    allowInput: foldKeyInputAllowed,
    resyncRef: keyResync,
    send,
    systemActions: foldSystemActions,
    undo: foldUndo,
    redo: foldRedo,
    keyLabel,
  };
  // A plugin live screen: its own buttons, in the plugin's order of importance.
  const liveScreen = lease?.screen;
  const deviceButtons: RemoteDesktopDeviceButton[] = (
    liveScreen?.buttons ?? []
  ).map((button) => ({
    key: `device-${button.id}`,
    icon: LIVE_SCREEN_ICONS[button.icon] ?? LIVE_SCREEN_ICONS.home,
    label: button.label,
    press: () =>
      send({ type: "events", events: [{ kind: "press", button: button.id }] }),
  }));
  const toolbarDeviceButtons = deviceButtons.slice(
    0,
    LIVE_SCREEN_TOOLBAR_BUTTONS,
  );
  const windowView = Boolean(handoff || liveScreen);
  const toggleKeyboard = () => {
    setOperations(false);
    if (keyboard) {
      Keyboard.dismiss();
      send({ type: "events", events: [{ kind: "release" }] });
    }
    setKeyboard(!keyboard);
  };
  // A device screen fills the phone: everything else is in one movable panel.
  const shownButton = (id: string) => !LIVE_SCREEN_NOT_IN_MENU.has(id);
  const liveScreenAction = (id: string): LiveScreenAction | undefined => {
    const button = deviceButtons.find((b) => b.key === `device-${id}`);
    return (
      button && {
        key: id,
        icon: button.icon,
        label: button.label,
        onPress: button.press,
      }
    );
  };
  const volumeDown = liveScreenAction("volume-down");
  const volumeUp = liveScreenAction("volume-up");
  const liveScreenActions: LiveScreenAction[] = (liveScreen?.buttons ?? [])
    .filter(
      (b) =>
        shownButton(b.id) &&
        !b.id.startsWith("volume-") &&
        !LIVE_SCREEN_POSTURES.includes(b.id),
    )
    .map((b) => liveScreenAction(b.id)!)
    .filter(Boolean);
  // A foldable's postures get a row of their own, in the plugin's order,
  // with the desktop viewer's glyphs.
  const postureActions = LIVE_SCREEN_POSTURES.flatMap((id) => {
    const action = liveScreenAction(id);
    return action ? [{ ...action, icon: POSTURE_ICONS[id] }] : [];
  });
  const rotation = (direction: "left" | "right") => {
    const action = rotatable && liveScreenAction(`rotate-${direction}`);
    return action
      ? { ...action, onPress: () => rotateDevice(direction) }
      : undefined;
  };
  const rotateLeft = rotation("left");
  const rotateRight = rotation("right");
  const controlDisabled =
    !lease ||
    busy ||
    settingInFlight.current ||
    Boolean(presentationTimer.current) ||
    connecting.current ||
    !caps?.canControl;
  const pipAvailable = Boolean(
    remotePresentation &&
    caps?.backgroundViewing &&
    (NativeRemoteDesktopView || canPip),
  );
  const latency = network?.latencyMs;
  const deckClipboard = (
    <RemoteDesktopClipboardButton
      enabled={!connectionPending && canInput}
      supported={caps?.clipboardText === true}
      transfer={transferClipboard}
      tint={colors.textSecondary}
    />
  );
  return (
    <KeyboardAvoidingView
      testID="remoteDesktop.layout"
      enabled={!landscapeKeyboardOverlay && !foldLayout && !panelKeys}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      {Platform.OS === "android" && focused && <StatusBar hidden />}
      <View style={[styles.body, landscape && styles.landscape]}>
        {retroDesktop && focused && foldLayout && foldSkin === "macbook" ? (
          <FoldDesktopBezel
            region={hardwareMedia}
            skin={foldSkin}
            viewport={retroViewport}
          />
        ) : null}
        <View
          style={[
            styles.canvas,
            {
              marginLeft: landscape ? 0 : edgePadding.paddingLeft,
              marginRight: landscape ? 0 : edgePadding.paddingRight,
            },
            fullScreenFoldBackground
              ? {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  marginLeft: 0,
                  marginRight: 0,
                }
              : foldLayout && {
                  position: "absolute",
                  flex: 0,
                  left: foldLayout.media.x,
                  top: foldLayout.media.y,
                  width: foldLayout.media.width,
                  height: foldLayout.media.height,
                  marginLeft: 0,
                  marginRight: 0,
                },
          ]}
        >
          {retroDesktop && focused && foldLayout && foldSkin !== "macbook" ? (
            <FoldDesktopBezel
              region={hardwareMedia}
              skin={foldSkin}
              viewport={retroViewport}
            />
          ) : null}
          <Animated.View
            testID="remoteDesktop.media"
            pointerEvents={frameReady ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFill,
              mediaReveal,
              retroViewport && {
                left: retroViewport.x,
                right: geometry.width - retroViewport.x - retroViewport.width,
                top: retroViewport.y,
                bottom:
                  geometry.height - retroViewport.y - retroViewport.height,
                borderRadius: foldSkin === "macbook" ? 0 : radius.control,
                overflow: "hidden",
              },
            ]}
          >
            {NativeRemoteDesktopView && (
              <NativeRemoteDesktopView
                ref={nativeViewer}
                inlineVisible={focused}
                onMessage={(event) => nativeMessage.current(event)}
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: retroDesktop
                      ? darkColors.surface
                      : colors.surface,
                  },
                ]}
              />
            )}
            <WebView
              ref={webview}
              source={{ html, baseUrl: "https://cindy-desktop.invalid/" }}
              originWhitelist={["*"]}
              onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank" ||
                request.url === "https://cindy-desktop.invalid/"
              }
              onMessage={onMessage}
              onError={restartViewer}
              onContentProcessDidTerminate={restartViewer}
              onRenderProcessGone={restartViewer}
              keyboardDisplayRequiresUserAction={false}
              hideKeyboardAccessoryView
              textInteractionEnabled={false}
              allowsLinkPreview={false}
              {...(Platform.OS === "ios"
                ? { dataDetectorTypes: "none" as const }
                : {})}
              javaScriptEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              allowsPictureInPictureMediaPlayback
              scrollEnabled={false}
              contentInsetAdjustmentBehavior="never"
              bounces={false}
              allowFileAccess={false}
              allowUniversalAccessFromFileURLs={false}
              allowFileAccessFromFileURLs={false}
              setSupportMultipleWindows={false}
              javaScriptCanOpenWindowsAutomatically={false}
              mixedContentMode="never"
              style={[
                styles.webview,
                NativeRemoteDesktopView && { backgroundColor: "transparent" },
              ]}
              testID="remoteDesktop.viewer"
            />
          </Animated.View>
          {frameReady &&
            Platform.OS === "ios" &&
            !tableRegion &&
            showMouseButtons &&
            !liveScreen &&
            focused &&
            !operations &&
            !keyboard &&
            canInput && (
              <RemoteDesktopMouseControls
                send={send}
                bottom={landscape ? 0 : toolbarSize.height}
                right={
                  landscape
                    ? !toolbarOnLeft
                      ? toolbarSize.width
                      : insets.right
                    : 0
                }
                compact={screenSize.height <= 400}
                labels={{
                  left: t("remoteDesktop.leftClick"),
                  right: t("remoteDesktop.rightClick"),
                  wheel: t("remoteDesktop.mouseWheel"),
                }}
              />
            )}
          {(showConnectionStatus ||
            showExitLockStatus ||
            (!lease && error) ||
            unlockNotice) && (
            <View
              pointerEvents="box-none"
              style={[
                styles.connectionStatus,
                !frameReady && error !== "permissionHint"
                  ? styles.initialConnection
                  : {
                      top:
                        edgePadding.paddingTop + spacing.xs + 44 + spacing.lg,
                    },
                error === "permissionHint" && {
                  bottom:
                    (landscape ? insets.bottom : toolbarSize.height) +
                    spacing.md,
                  right: (landscape ? toolbarSize.width : 0) + spacing.md,
                },
              ]}
            >
              {!frameReady && error !== "permissionHint" && (
                <View style={styles.waitingComputer}>
                  <ConnectionIcon
                    size={iconSize.lg}
                    strokeWidth={iconStroke.regular}
                    color={colors.textTertiary}
                  />
                  <Text numberOfLines={2} style={styles.waitingComputerName}>
                    {screenPlugin
                      ? (lease?.screen?.name ??
                        t("remoteDesktop.liveScreenTitle"))
                      : deviceName}
                  </Text>
                  {screenPlugin && (
                    <Text numberOfLines={2} style={styles.waitingLabel}>
                      {deviceName}
                    </Text>
                  )}
                </View>
              )}
              {unlockNotice ? (
                <ErrorNotice
                  message={unlockNotice}
                  testID="remoteDesktop.autoUnlockNotice"
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  onDismiss={security.clearNotice}
                  dismissLabel={t("remoteDesktop.close")}
                  dismissTestID="remoteDesktop.dismissUnlockNotice"
                />
              ) : showConnectionStatus || showExitLockStatus ? (
                <View
                  style={[
                    styles.connectionBadge,
                    !frameReady && styles.initialConnectionBadge,
                  ]}
                  accessibilityRole="progressbar"
                  accessibilityLabel={connectionLabel}
                  accessibilityState={{ busy: true }}
                  testID="remoteDesktop.connectingStatus"
                >
                  {reduceMotion === false && (
                    <ActivityIndicator
                      size="small"
                      color={colors.textSecondary}
                    />
                  )}
                  <Text
                    style={[
                      styles.connectionLabel,
                      !frameReady && styles.waitingLabel,
                    ]}
                  >
                    {connectionLabel}
                  </Text>
                </View>
              ) : (
                error !== "permissionHint" && (
                  <Text
                    accessibilityRole={error ? "alert" : undefined}
                    style={styles.caption}
                  >
                    {t(
                      error === "accessRevoked" || error === "remoteDisabled"
                        ? `deviceLink.remoteError.${error}`
                        : `remoteDesktop.${error === "connectionBusy" && caps?.connectionTakeover ? "connectionBusyTakeover" : (error ?? status)}`,
                    )}
                  </Text>
                )
              )}
              {!frameReady && showConnectionStatus && connectionTakingLong && (
                <Text style={styles.waitingLabel}>
                  {t("remoteDesktop.connectionTakingLong")}
                </Text>
              )}
              {error &&
                error !== "permissionHint" &&
                button(
                  t(
                    error === "connectionBusy" && caps?.connectionTakeover
                      ? "remoteDesktop.takeoverConnection"
                      : error === "disabled"
                        ? "remoteDesktop.reconnectAfterPermissions"
                        : "remoteDesktop.connect",
                  ),
                  retry,
                )}
              {error === "permissionHint" && focused && (
                <ScrollView style={{ flex: 1 }}>
                  <PermissionGuide
                    key={deviceId}
                    initial={caps?.permissions}
                    request={request}
                    reconnect={retry}
                  />
                </ScrollView>
              )}
            </View>
          )}
          {lease &&
            !showConnectionStatus &&
            viewOnlySelected &&
            !operations && (
              <Text
                style={[
                  styles.viewOnly,
                  {
                    bottom:
                      spacing.sm +
                      (!keyboard && !landscape ? toolbarSize.height : 0),
                    left: spacing.sm,
                  },
                ]}
              >
                {t("remoteDesktop.viewOnly")}
              </Text>
            )}
          {lease &&
            !screenPlugin &&
            !showConnectionStatus &&
            !operations &&
            !landscape && (
              <RemoteDesktopNetworkStatus
                foreground={viewerColors.textPrimary}
                send={send}
                stats={network}
                video={status === "live"}
                top={edgePadding.paddingTop + spacing.sm}
              />
            )}
          {windowsOpen &&
            focused &&
            lease &&
            canInput &&
            caps?.windowActions && (
              <RemoteDesktopWindows
                key={lease.lease}
                lease={lease.lease}
                request={request}
                caption={deviceName}
                landscape={landscape}
                topInset={edgePadding.paddingTop}
                onClose={() => setWindowsOpen(false)}
              />
            )}
          {(operations || Platform.OS === "ios") && (
            <View
              pointerEvents="box-none"
              style={[
                StyleSheet.absoluteFill,
                {
                  bottom:
                    Platform.OS === "ios" || landscape ? 0 : toolbarSize.height,
                  right:
                    Platform.OS === "ios"
                      ? 0
                      : landscape
                        ? toolbarSize.width
                        : 0,
                },
              ]}
            >
              <RemoteDesktopPanel
                railAnchor={
                  systemSideRail
                    ? {
                        right: (sideRailWidth - navigationChrome.target) / 2,
                        top:
                          (sideRailTop +
                            navigationChrome.target +
                            spacing.lg +
                            windowSize.height -
                            insets.bottom -
                            navigationChrome.target *
                              (liveScreen
                                ? toolbarDeviceButtons.length +
                                  (liveScreen.keyboard ? 2 : 1)
                                : handoff
                                  ? 2
                                  : caps?.omarchyMenu
                                    ? 5
                                    : 4)) /
                          2,
                      }
                    : undefined
                }
                toolbarOnLeft={toolbarOnLeft}
                toolbarActionCount={
                  liveScreen
                    ? toolbarDeviceButtons.length +
                      (liveScreen.keyboard ? 2 : 1)
                    : handoff
                      ? 2
                      : caps?.omarchyMenu
                        ? 5
                        : 4
                }
                visible={operations && focused}
                landscape={landscape}
                topInset={edgePadding.paddingTop}
                title={t(
                  liveScreen
                    ? "remoteDesktop.settings"
                    : `remoteDesktop.${controlPage === "controls" ? "operations" : controlPage === "display" ? "displaySettings" : "security"}`,
                )}
                page={controlPage}
                onBack={
                  controlPage === "controls"
                    ? undefined
                    : () => setControlPage("controls")
                }
                caption={`${lease?.window ? t("remoteDesktop.handoffWindow", { app: lease.window.app }) : liveScreen ? liveScreen.name : deviceName} · ${showConnectionStatus ? connectionLabel : t(`remoteDesktop.${status}`)}`}
                onClose={() => setOperations(false)}
                footer={
                  // A device screen leaves with Back in its own panel.
                  liveScreen ? undefined : (
                    <RemoteDesktopDisconnect onPress={() => void leave()} />
                  )
                }
              >
                {!liveScreen && foldSkinAvailable && controlPage === "controls" ? (
                  <FoldDesktopSkinSwitch
                    skin={foldSkin}
                    onChange={setFoldSkin}
                  />
                ) : null}
                {liveScreen ? (
                  <LiveScreenSettings
                    background={{
                      enabled: pipEnabled,
                      available: pipAvailable,
                      onChange: togglePictureInPicture,
                    }}
                    video={{
                      supported: Boolean(caps?.videoSettings),
                      settings: videoSettings,
                      busy: settingBusy,
                      notice: settingNotice,
                      onChange: (settings) => {
                        void changeVideoSettings(settings);
                      },
                    }}
                    connected={Boolean(lease) && !connectionPending}
                    controlling={Boolean(lease?.controlling)}
                  />
                ) : (
                  <RemoteDesktopControls
                    page={controlPage}
                    onPage={setControlPage}
                    device={
                      // The device's buttons are all in the floating menu.
                      liveScreen ? { buttons: [] } : undefined
                    }
                    security={
                      liveScreen
                        ? undefined
                        : {
                            ...security,
                            ...safety,
                            notice: security.notice,
                            hostPlatform: caps?.platform,
                            lockOnExit,
                            lockOnExitAvailable:
                              lockOnExitLoaded && caps?.lockOnExit === true,
                            onLockOnExit: updateLockOnExit,
                            idleTimeoutMinutes,
                            idleTimeoutAvailable:
                              idleTimeoutLoaded && caps?.idleLock === true,
                            onIdleTimeout: updateIdleTimeout,
                          }
                    }
                    connected={Boolean(lease) && !connectionPending}
                    controlling={Boolean(lease?.controlling)}
                    viewOnly={viewOnlySelected}
                    controlDisabled={controlDisabled}
                    presentation={{
                      enabled: pipEnabled,
                      canPip: pipAvailable,
                      canAudio: Boolean(caps?.systemAudio),
                      onPip: togglePictureInPicture,
                    }}
                    video={{
                      supported: Boolean(caps?.videoSettings),
                      settings: videoSettings,
                      busy: settingBusy,
                      modesSupported: Boolean(caps?.displayModes),
                      displayGeometry: lease
                        ? `${lease.display.id}:${lease.display.width}:${lease.display.height}:${Boolean(fittedDisplay)}`
                        : undefined,
                      viewerDisplaySupported: caps?.viewerDisplay === true,
                      autoFitEnabled: Boolean(fittedDisplay),
                      onFitDisplay: toggleFitDisplay,
                      notice: audioUnavailable.current
                        ? t("remoteDesktop.audioUnavailable")
                        : settingNotice,
                      onChange: (settings) => {
                        void changeVideoSettings(settings);
                      },
                      readModes: readResolutionModes,
                      onResolution: changeResolution,
                    }}
                    inputMode={inputMode}
                    displays={windowView ? [] : (caps?.displays ?? [])}
                    displayId={recovery.current.displayId ?? lease?.display.id}
                    onViewOnly={() => void toggleControl()}
                    onInputMode={(value) => {
                      setInputMode(value);
                      send({ type: "mode", mode: value });
                    }}
                    showMouseButtons={showMouseButtons}
                    onShowMouseButtons={setShowMouseButtons}
                    onDisplay={(id) => {
                      setOperations(false);
                      void connect(id);
                    }}
                  />
                )}
              </RemoteDesktopPanel>
            </View>
          )}
        </View>
        {tableRegion && frameReady && focused && !keyboard && !operations ? (
          <View
            testID="remoteDesktop.foldControls"
            style={{
              position: "absolute",
              left: physicalDeck ? hardwareControls.x : foldControls.x,
              top: physicalDeck ? hardwareControls.y : foldControls.y,
              width: physicalDeck ? hardwareControls.width : foldControls.width,
              height: physicalDeck
                ? hardwareControls.height
                : foldControls.height,
              paddingBottom: physicalDeck
                ? 0
                : toolbarSize.height + (showMouseButtons ? 80 : 0),
            }}
          >
            {keyboardDeck ? (
              <FoldDesktopKeyboard
                {...keySurface}
                skin={foldSkin}
                onSkinChange={setFoldSkin}
                onInputMethod={openFoldInputMethod}
                onOperations={toggleOperations}
                clipboard={deckClipboard}
                safeInsets={foldDeckInsets}
                bottomReserve={showMouseButtons ? 80 : 0}
              />
            ) : retroDesktop ? (
              <FoldDesktopDeck
                keys={keySurface}
                skin={foldSkin}
                onChange={setFoldSkin}
                safeInsets={foldDeckInsets}
                bottomReserve={toolbarSize.height + (showMouseButtons ? 80 : 0)}
              />
            ) : (
              <>
                {foldSkinAvailable ? (
                  <FoldDesktopSkinSwitch
                    skin={foldSkin}
                    onChange={(value) => {
                      send({ type: "releaseInput" });
                      setFoldSkin(value);
                    }}
                  />
                ) : null}
                <FoldTouchpad send={send} enabled={canInput} />
              </>
            )}
            {showMouseButtons && canInput ? (
              <RemoteDesktopMouseControls
                send={send}
                bottom={keyboardDeck ? 0 : toolbarSize.height}
                right={0}
                compact
                labels={{
                  left: t("remoteDesktop.leftClick"),
                  right: t("remoteDesktop.rightClick"),
                  wheel: t("remoteDesktop.mouseWheel"),
                }}
              />
            ) : null}
          </View>
        ) : null}
        {!keyboard && !keyboardDeck && !screenPlugin && (
          <Animated.View
            key={landscape ? "landscape-toolbar" : "portrait-toolbar"}
            testID="remoteDesktop.toolbarPosition"
            pointerEvents={frameReady ? "box-none" : "none"}
            accessibilityElementsHidden={!frameReady}
            importantForAccessibility={
              frameReady ? "auto" : "no-hide-descendants"
            }
            onLayout={({ nativeEvent: { layout } }) => {
              setToolbarSize((previous) =>
                previous.width === layout.width &&
                previous.height === layout.height
                  ? previous
                  : { width: layout.width, height: layout.height },
              );
            }}
            style={[
              styles.floatingToolbar,
              mediaReveal,
              landscape ? styles.floatingRail : styles.floatingBottom,
              {
                paddingRight: landscape ? spacing.xs : edgePadding.paddingRight,
                paddingLeft: landscape ? 0 : edgePadding.paddingLeft,
                paddingBottom: keyboard || nativeKeyboard ? 0 : insets.bottom,
              },
              Platform.OS === "ios" && {
                backgroundColor: "transparent",
                ...(landscape
                  ? {
                      top: insets.top,
                      bottom: insets.bottom,
                      left: toolbarOnLeft ? 0 : undefined,
                      right: toolbarOnLeft ? undefined : 0,
                      justifyContent: "center",
                      paddingLeft: toolbarOnLeft ? spacing.lg : 0,
                      paddingRight: toolbarOnLeft ? 0 : spacing.lg,
                      paddingBottom: 0,
                    }
                  : {
                      left: 0,
                      right: 0,
                      top: undefined,
                      bottom: 0,
                      alignItems: "center",
                      justifyContent: "center",
                      paddingLeft: 0,
                      paddingRight: 0,
                      paddingBottom: Math.max(spacing.sm, insets.bottom),
                    }),
              },
              tableRegion && {
                left: foldControls.x,
                right: undefined,
                width: foldControls.width,
                bottom: geometry.height - foldControls.y - foldControls.height,
                paddingBottom: spacing.sm,
              },
              systemSideRail && {
                left: toolbarOnLeft ? 0 : undefined,
                right: toolbarOnLeft ? undefined : 0,
                width: sideRailWidth,
                // Leave room for the system clock/signal and the 44pt Back control.
                top: sideRailTop + navigationChrome.target + spacing.lg,
                bottom: insets.bottom,
                paddingLeft: 0,
                paddingRight: 0,
                paddingBottom: 0,
                alignItems: "center",
                justifyContent: "center",
              },
            ]}
          >
            <RemoteDesktopToolbar
              landscape={landscape || systemSideRail}
              windowOnly={windowView}
              device={
                liveScreen
                  ? {
                      buttons: toolbarDeviceButtons,
                      keyboard: liveScreen.keyboard,
                    }
                  : undefined
              }
              onWorkspaceLeft={
                caps?.workspaceNavigation
                  ? () => workspaceAction("workspaceLeft")
                  : undefined
              }
              onWorkspaceRight={
                caps?.workspaceNavigation
                  ? () => workspaceAction("workspaceRight")
                  : undefined
              }
              onOmarchyMenu={
                caps?.omarchyMenu
                  ? () => workspaceAction("omarchyMenu")
                  : undefined
              }
              canControl={canInput}
              keyboard={keyboard}
              operations={operations}
              onWindows={openWindows}
              onDesktop={showDesktop}
              onKeyboard={toggleKeyboard}
              onOperations={toggleOperations}
            />
          </Animated.View>
        )}
      </View>
      {(!screenPlugin ||
        !frameReady ||
        showConnectionStatus ||
        Boolean(error)) && (
        <View
          testID="remoteDesktop.backPosition"
          pointerEvents="auto"
          onLayout={({ nativeEvent: { layout } }) =>
            setBackControlHeight(layout.height)
          }
          style={[
            styles.back,
            {
              top: landscape
                ? insets.top + spacing.lg
                : sharedStatusRow
                  ? sharedBackTop
                  : edgePadding.paddingTop + spacing.xs,
              // iOS landscape: Island/notch sits mid-edge, so the top-left
              // corner stays clear even when insets.left is large. Skip that
              // inset unless the top edge is also unsafe — a physical cutout
              // occupying the corner, not a centered island. Android left
              // insets are an unsafe strip (cutout/curve), not an island.
              left: landscape
                ? (Platform.OS === "ios" &&
                  !geometry.reservedRegionsSupported &&
                  insets.top === 0
                    ? 0
                    : insets.left) +
                  spacing.lg +
                  (Platform.OS === "ios" ? spacing.xs : 0)
                : portraitBackLeft,
            },
            systemSideRail && {
              top: sideRailTop,
              left:
                windowSize.width -
                (sideRailWidth + navigationChrome.target) / 2,
              width: navigationChrome.target,
            },
          ]}
        >
          <RemoteDesktopBackButton
            label={t("remoteDesktop.back")}
            onPress={back}
          />
        </View>
      )}
      {keyboard && (
        <View
          testID="remoteDesktop.keyboardPanel"
          onLayout={({ nativeEvent: { layout } }) =>
            setKeyboardPanelHeight(layout.height)
          }
          style={[
            styles.keyboard,
            landscapeKeyboardOverlay && [
              styles.keyboardOverlay,
              { bottom: keyboardBottom },
            ],
            {
              paddingLeft: Math.max(spacing.xs, edgePadding.paddingLeft),
              paddingRight: Math.max(spacing.sm, edgePadding.paddingRight),
              paddingBottom: panelBottomPadding,
            },
            foldLayout && {
              position: "absolute",
              left: foldControls.x,
              width: foldControls.width,
              bottom: geometry.height - foldControls.y - foldControls.height,
              maxHeight: foldControls.height,
              paddingLeft: spacing.xs,
              paddingRight: spacing.sm,
              paddingBottom: 0,
            },
          ]}
        >
          <View
            testID="remoteDesktop.keyboardSurface"
            style={{
              height: panelKeys ? keyboardSurfaceHeight : KEY_BAR_HEIGHT,
            }}
          >
            <RemoteKeySurface
              key={panelKeys ? "keys" : "bar"}
              {...keySurface}
              compact={keyboardCompact}
              mode={panelKeys ? "keyboard" : "bar"}
              strip={{
                height: KEY_BAR_HEIGHT,
                left: KEY_BAR_HEIGHT,
                right: KEY_BAR_HEIGHT * 2,
              }}
            />
            {/* The same bar in both modes: only the keys between these change. */}
            <View pointerEvents="box-none" style={styles.keyboardBar}>
              <Pressable
                testID="remoteDesktop.keyboardMode"
                accessibilityRole="button"
                accessibilityLabel={t(
                  fullKeys
                    ? "remoteDesktop.inputMethod"
                    : "remoteDesktop.computerKeyboard",
                )}
                onPress={() => selectKeyboardMode(!fullKeys)}
                style={({ pressed }) => [
                  styles.keyboardBarButton,
                  pressed && mobileInteractionStyles.pressed,
                ]}
              >
                {fullKeys ? (
                  <Languages
                    size={iconSize.action}
                    strokeWidth={iconStroke.regular}
                    color={colors.textSecondary}
                  />
                ) : (
                  <KeyboardIcon
                    size={iconSize.action}
                    strokeWidth={iconStroke.regular}
                    color={colors.textSecondary}
                  />
                )}
              </Pressable>
              <View style={styles.keyboardBarEnd}>
                {deckClipboard}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("remoteDesktop.close")}
                  onPress={() => {
                    setKeyboard(false);
                    setAwaitingSystemKeyboard(false);
                    send({ type: "events", events: [{ kind: "release" }] });
                  }}
                  style={({ pressed }) => [
                    styles.keyboardBarButton,
                    pressed && mobileInteractionStyles.pressed,
                  ]}
                >
                  <ChevronDown
                    size={iconSize.action}
                    strokeWidth={iconStroke.regular}
                    color={colors.textSecondary}
                  />
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
      {screenPlugin && (
        <LiveScreenControls
          platform={liveScreen?.platform}
          name={liveScreen?.name ?? deviceName}
          status={{
            text: showConnectionStatus
              ? connectionLabel
              : status === "live" && typeof latency === "number"
                ? `${t(`remoteDesktop.${status}`)} · ${Math.round(latency)} ms`
                : t(`remoteDesktop.${status}`),
            tone:
              status === "live"
                ? "live"
                : status === "disconnected"
                  ? "failed"
                  : "connecting",
          }}
          actions={liveScreenActions}
          volume={
            volumeDown && volumeUp
              ? { down: volumeDown, up: volumeUp }
              : undefined
          }
          posture={postureActions.length ? postureActions : undefined}
          orientation={
            rotateLeft && rotateRight
              ? {
                  following,
                  onFollow: turnable ? () => setTurn(null) : undefined,
                  rotate: { left: rotateLeft, right: rotateRight },
                }
              : undefined
          }
          picture={{
            value: picture,
            editing: zoomEditing,
            onChange: changePicture,
            onDone: () => setZoomEditing(false),
          }}
          inputDisabled={!canInput}
          onSettings={() => {
            Keyboard.dismiss();
            setKeyboard(false);
            setZoomEditing(false);
            send({ type: "events", events: [{ kind: "release" }] });
            setControlPage("controls");
            setOperations(true);
          }}
          onBack={() => void back()}
          insets={{
            top: insets.top,
            bottom: insets.bottom + (keyboard ? keyboardPanelHeight : 0),
            left: insets.left,
            right: insets.right,
          }}
          hidden={operations}
          labels={{
            menu: t("remoteDesktop.deviceMenu"),
            orientation: t("remoteDesktop.orientation"),
            follow: t("remoteDesktop.orientationFollow"),
            posture: t("remoteDesktop.posture"),
            picture: t("remoteDesktop.picture"),
            pictures: {
              fit: t("remoteDesktop.pictureFit"),
              fill: t("remoteDesktop.pictureFill"),
              zoom: t("remoteDesktop.pictureZoom"),
            },
            zoomHint: t("remoteDesktop.zoomHint"),
            zoomDone: t("remoteDesktop.zoomDone"),
            volume: t("remoteDesktop.volume"),
            settings: t("remoteDesktop.settings"),
            back: t("remoteDesktop.back"),
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    caption: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    back: {
      position: "absolute",
    },
    connectionStatus: {
      position: "absolute",
      left: spacing.md,
      right: spacing.md,
      gap: spacing.sm,
    },
    initialConnection: {
      top: 0,
      bottom: 0,
      justifyContent: "center",
      alignItems: "center",
    },
    waitingComputer: {
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    waitingComputerName: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
      textAlign: "center",
    },
    initialConnectionBadge: {
      backgroundColor: "transparent",
      paddingHorizontal: 0,
      paddingVertical: spacing.xs,
    },
    waitingLabel: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      textAlign: "center",
    },
    connectionBadge: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceElevated,
    },
    connectionLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    viewOnly: {
      position: "absolute",
      alignSelf: "center",
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      backgroundColor: colors.surfaceElevated,
      padding: spacing.xs,
      borderRadius: radius.control,
    },
    body: { flex: 1 },
    floatingToolbar: {
      position: "absolute",
      backgroundColor: colors.surfaceTranslucent,
    },
    floatingBottom: { left: 0, right: 0, bottom: 0 },
    floatingRail: { right: 0, top: 0, bottom: 0 },
    landscape: { flexDirection: "row" },
    canvas: { flex: 1, overflow: "hidden" },
    webview: { flex: 1, backgroundColor: colors.surface },
    button: {
      minHeight: 44,
      minWidth: 44,
      flexShrink: 1,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceElevated,
      paddingHorizontal: spacing.sm,
      justifyContent: "center",
      alignItems: "center",
    },
    selected: {
      backgroundColor: colors.surfaceChip,
      borderWidth: 1,
      borderColor: colors.textPrimary,
    },
    disabled: { opacity: 0.4 },
    buttonText: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    keyboardOverlay: { position: "absolute", left: 0, right: 0 },
    keyboard: {
      backgroundColor: colors.surfaceTranslucent,
      paddingHorizontal: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    keyboardBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: KEY_BAR_HEIGHT,
      flexDirection: "row",
      justifyContent: "space-between",
    },
    keyboardBarEnd: { flexDirection: "row" },
    keyboardBarButton: {
      width: KEY_BAR_HEIGHT,
      height: KEY_BAR_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
    },
    // 选中只换色,字重保持与未选一致。
  });

/** A device screen's reported upright size, or null when absent or malformed. */
function liveScreenShape(
  value: unknown,
): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    (width as number) > 0 &&
    (height as number) > 0 &&
    (width as number) <= 16384 &&
    (height as number) <= 16384
    ? { width: width as number, height: height as number }
    : null;
}
