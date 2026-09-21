import { foldDesktopLayout } from './foldDesktopLayout';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { windowDivision, controlRegion } from '@/platform/windowGeometry';
import { FoldTouchpad } from './FoldTouchpad';
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
import { Monitor } from "lucide-react-native";
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
import { RemoteDesktopPanelButton } from "./RemoteDesktopPanelButton";
import { useTranslation } from "react-i18next";
import SegmentedControl from "@expo/ui/community/segmented-control";
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
import { useScreenEdgePadding } from "@/components/screenEdgeInsets";
import { goBackGuarded } from "@/utils/backGuard";
import { mobileDebugEnabled, mobileDebugLog } from "@/debug/mobileDebugLog";
import {
  RTC_DIAGNOSTIC_REVISION,
  rtcDiagnosticSummary,
} from "./rtcDiagnostics";
import {
  fontWeight,
  iconSize,
  iconStroke,
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
import { useLockOnExitPreference } from "./useLockOnExitPreference";
import { useRemoteDesktopSafety } from "./useRemoteDesktopSafety";
import { useVideoSettingsPreference } from "./useVideoSettingsPreference";
import { usePictureInPicturePreference } from "./usePictureInPicturePreference";
import { PermissionGuide } from "./PermissionGuide";
import { navigationChrome } from "@/theme/tokens";
import { RemoteDesktopBackButton } from "./RemoteDesktopBackButton";
import { RemoteDesktopWindows } from "./RemoteDesktopWindows";
import { RemoteDesktopNetworkStatus } from "./RemoteDesktopNetworkStatus";
import type { DesktopNetworkStats } from "./networkStats";
import {
  RemoteDesktopControls,
  RemoteDesktopDisconnect,
} from "./RemoteDesktopControls";
import {
  RemoteDesktopPanel,
  RemoteDesktopToolbar,
} from "./RemoteDesktopChrome";

type Mode = "pointer" | "touch" | "pan";
const MODIFIERS = ["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft"];
const KEY_PAGES = [
  [
    [
      "Minus",
      "Equal",
      "BracketLeft",
      "BracketRight",
      "Backslash",
      "Semicolon",
      "Quote",
      "Comma",
      "Period",
      "Slash",
    ],
    [..."1234567890"].map((key) => `Digit${key}`),
    [..."QWERTYUIOP"].map((key) => `Key${key}`),
    [..."ASDFGHJKL"].map((key) => `Key${key}`).concat("Backspace"),
    [..."ZXCVBNM"].map((key) => `Key${key}`).concat("Space", "Enter"),
  ],
  [
    ["Escape", "Tab", "Backquote", "Insert", "Home", "PageUp"],
    ["F1", "F2", "F3", "Delete", "End", "PageDown"],
    ["F4", "F5", "F6", "Backspace", "Space", "Enter"],
    ["F7", "F8", "F9", null, "ArrowUp", null],
    ["F10", "F11", "F12", "ArrowLeft", "ArrowDown", "ArrowRight"],
  ],
];
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
  const { deviceId: rawId, deviceName: rawName } = useLocalSearchParams<{
    deviceId: string;
    deviceName?: string;
  }>();
  const deviceId = typeof rawId === "string" ? rawId : "";
  const deviceName = typeof rawName === "string" ? rawName : deviceId;
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
        focused={focused}
        onBack={() => goBackGuarded(router)}
      />
    </>
  );
}

export function RemoteDesktopSession({
  deviceId,
  deviceName,
  focused,
  onBack,
  onRestore,
  onVisibility,
  onEnded,
}: {
  deviceId: string;
  deviceName: string;
  focused: boolean;
  onBack(): void;
  onRestore?(): void;
  onVisibility?(visible: boolean): void;
  onEnded?(): void;
}) {
  const auth = useAuth();
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
  const [lockOnExit, setLockOnExit, lockOnExitLoaded] =
    useLockOnExitPreference(deviceId);
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
  const division = windowDivision(geometry);
  const tableRegion = division && division.first.height >= 160 && division.second.height >= 160 && division.first.width >= 160 && division.second.width >= 160 ? division : null;

  const systemSideRail = Platform.OS === 'ios' && !tableRegion && (geometry.barEdge !== 'none' || (geometry.reservedRegionsSupported && geometry.regularWidth && windowSize.width > windowSize.height));
  // Android adjustResize shrinks the window for the IME, not the display.
  // Keep its device orientation stable; iOS/Duo still use the adaptive window.
  const orientationSize = Platform.OS === 'android' ? Dimensions.get('screen') : windowSize;
  const landscape = systemSideRail || (!tableRegion && orientationSize.width > orientationSize.height);
  const sideRailWidth = Math.max(60, geometry.insets.right + spacing.md);
  // The native status/navigation center sits 6pt inward from the safe strip center.
  // Use the reported status reservation for vertical clearance when available.
  const statusReservation = geometry.regions.filter(r => r.kind === 'occlusion' && r.y === 0 && r.x + r.width >= geometry.width);
  const sideRailTop = Math.max(insets.top, statusReservation.length ? Math.max(...statusReservation.map(r => r.y + r.height)) : 120);
  const [interfaceAngle, setInterfaceAngle] = useState<number | null>(null);
  const toolbarOnLeft =
    systemSideRail ? false :
    Platform.OS === "ios" &&
    landscape &&
    (interfaceAngle === 270 ||
      (interfaceAngle === null && insets.right > insets.left));
  const webview = useRef<ComponentRef<typeof WebView>>(null);
  const nativeViewer = useRef<NativeRemoteDesktopHandle>(null);
  // Memo survives ordinary renders, but Fast Refresh invalidates it when the
  // bundled viewer changes. A ref kept the old script alongside new RN layout.
  const html = useMemo(() =>
    remoteDesktopViewerHtml(
      colors.surface,
      colors.textPrimary,
      Boolean(NativeRemoteDesktopView),
    ),
  []);
  const [viewerReadyRevision, setViewerReadyRevision] = useState(0);
  const active = useRef<RemoteDesktopLease | null>(null);
  const wantsControl = useRef(true);
  const [viewOnlySelected, setViewOnlySelected] = useState(false);
  // Last control bit we asked the host for but have not confirmed. Overflow and
  // take-control can time out after the local bit already moved; heartbeats use
  // this to retry a release or restore local control instead of ignoring host-true.
  const pendingHostControl = useRef<boolean | null>(null);
  const controlInFlight = useRef(false);
  const controlRestoration = useRef<Promise<void> | null>(null);
  // Revoking background permission must not lose the pending fullscreen input restore.
  const restoreAfterPipDisabled = useRef(false);
  const finishBackgroundTransition = useRef<(() => void) | null>(null);
  const recovery = useRef({
    enabled: true,
    at: 0,
    delay: 1000,
    displayId: undefined as string | undefined,
    resuming: false,
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
  const inputBusy = useRef<string | null>(null);
  const [lease, setLease] = useState<RemoteDesktopLease | null>(null);
  const [windowsOpen, setWindowsOpen] = useState(false);
  useEffect(() => {
    setWindowsOpen(false);
  }, [lease?.lease, lease?.controlling, focused]);
  const [fittedDisplay, setFittedDisplay] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewerViewport, setViewerViewport] = useState({ width: 0, height: 0 });
  const viewportGeneration = useRef(0);
  const matchesViewer = (
    display: { width: number; height: number },
    width: number,
    height: number,
  ) =>
    width > 0 &&
    height > 0 &&
    Math.abs(display.width / display.height - width / height) < 0.003;
  const viewerDisplayMatched = Boolean(
    fittedDisplay &&
    caps?.viewerDisplayRestore &&
    lease &&
    matchesViewer(fittedDisplay, viewerViewport.width, viewerViewport.height),
  );
  exitLock.current =
    lockOnExitLoaded && lockOnExit && caps?.lockOnExit === true;
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
        ? "remoteDesktop.reconnecting"
        : "remoteDesktop.connecting",
  );
  const [busy, setBusy] = useState(false);
  const [inputMode, setInputMode] = useInputModePreference();
  const mode: Mode = lease?.controlling ? inputMode : "pan";
  const [operations, setOperations] = useState(false);
  const [controlPage, setControlPage] = useState<
    "controls" | "display" | "security"
  >("controls");
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
  const [pipEnabled, setPipEnabled] = usePictureInPicturePreference();
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
  // Android's system keyboard already resizes the window. Keep its existing
  // flow layout; only iOS needs an offset above the native keyboard.
  const landscapeKeyboardOverlay =
    landscape && (Platform.OS === "ios" || fullKeys);
  const keyboardBottom =
    Platform.OS === "ios" && keyboard && !fullKeys ? nativeKeyboardHeight : 0;
  const foldLayout = foldDesktopLayout(geometry, keyboardBottom, keyboardPanelHeight, keyboard);
  const fullScreenFoldBackground = Boolean(foldLayout && division?.axis === 'horizontal');
  const foldControls = foldLayout?.controls ?? controlRegion(geometry);
  const heldKeys = useRef(new Map<string, string[]>());
  const [keyPage, setKeyPage] = useState(0);
  const [comboMode, setComboMode] = useState(true);
  const [modifiers, setModifiers] = useState<string[]>([]);
  const send = useCallback((message: object) => {
    const command = message as Record<string, unknown>;
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
    const enabled =
      keyboard && !fullKeys && focused && Boolean(lease?.controlling);
    if (!enabled) {
      send({ type: "keyboard", enabled: false });
      Keyboard.dismiss();
      return;
    }
    // Focus synchronously in the native-to-WebView script call. Deferring DOM
    // focus to a web animation frame loses WebKit's user-interaction context.
    webview.current?.requestFocus();
    send({ type: "keyboard", enabled: true });
  }, [
    keyboard,
    fullKeys,
    focused,
    lease?.controlling,
    keyboardFocusRequest,
    send,
  ]);
  const request = useCallback(
    <T,>(message: RemoteDesktopRequest, preSend?: () => void) =>
      linkRef.current.invoke<T>(deviceId, REMOTE_DESKTOP_CHANNEL, [message], {
        preSend,
      }),
    [deviceId],
  );
  const viewerSession = useMemo(
    () => ({ current: new RemoteDesktopViewerSession(request) }),
    [request],
  );
  const authRef = useRef(auth);
  authRef.current = auth;
  const viewerMedia = useMemo(
    () =>
      new RemoteDesktopViewerMedia({
        request,
        send,
        loadIce: (attemptId) =>
          resolveDesktopIceServers(
            () =>
              authRef.current.apiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
                baseUrl: DEVICE_LINK_API_BASE_URL,
                timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
                cache: "no-store",
              }),
            (result) =>
              mobileDebugLog(
                "info",
                "device-link",
                "remote desktop ICE config",
                {
                  revision: RTC_DIAGNOSTIC_REVISION,
                  attempt: attemptId.slice(0, 8),
                  ...result,
                },
              ),
          ),
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
    caps,
    request,
    exitLock.current,
  );
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
    heldKeys.current.clear();
    setModifiers([]);
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
    };
    const show = Keyboard.addListener("keyboardDidShow", updateFrame);
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
    (preserveFrame = false, exiting = false) => {
      timing.current?.("stopped");
      timing.current = null;
      generation.current++;
      unlockFrame.current?.(false);
      unlockFrame.current = null;
      presentation.current = false;
      actualPresentation.current = false;
      pipPrepared.current = false;
      restoreAfterPipDisabled.current = false;
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
      setExitLockPending(Boolean(previous && exiting && exitLock.current));
      active.current = null;
      pendingVideoSettings.current = null;
      if (previous) pendingMediaOffers.current.delete(previous);
      mediaAttempt.current = null;
      viewerMedia.reset();
      heldKeys.current.clear();
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
        setModifiers([]);
        setKeyboard(false);
        setBusy(false);
      }
      const lockScreen = Boolean(previous && exiting && exitLock.current);
      return viewerSession
        .current!.stop(lockScreen)
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
      stop(!blocked);
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
   * lease, the picture and the existing view-only hint all survive, and taking
   * control again retries from where the user is.
   */
  const releaseControl = useCallback(() => {
    const current = active.current;
    if (!current?.controlling) return;
    current.controlling = false;
    heldKeys.current.clear();
    send({ type: "control", enabled: false });
    if (alive.current) {
      setModifiers([]);
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
  const resolveControlFailure = (cause: unknown) => {
    switch (controlFailureAction(cause)) {
      case "release":
        releaseControl();
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
    wantsControl.current = controlling;
    if (current.controlling !== controlling) {
      current.controlling = controlling;
      if (!controlling) {
        heldKeys.current.clear();
        if (alive.current) {
          setModifiers([]);
          setKeyboard(false);
        }
      }
    }
    // The shared session may already have mutated this lease before returning.
    // Always publish the confirmation to React's separate snapshot as well.
    if (alive.current) setLease({ ...current });
    send({ type: "control", enabled: controlling });
  };
  const requestHostControl = (
    current: RemoteDesktopLease,
    enabled: boolean,
  ) => {
    if (controlInFlight.current) return;
    controlInFlight.current = true;
    pendingHostControl.current = enabled;
    return request<{ controlling: boolean }>({
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
        if (active.current === current) controlInFlight.current = false;
      });
  };
  const requestHostControlRef = useRef(requestHostControl);
  const restoreInlinePresentation = () => {
    const current = active.current;
    if (
      !current ||
      (!pipPrepared.current && !restoreAfterPipDisabled.current) ||
      presentation.current ||
      actualPresentation.current ||
      !focusedRef.current ||
      linkRef.current.status !== "online" ||
      AppState.currentState !== "active"
    )
      return;
    pipPrepared.current = false;
    restoreAfterPipDisabled.current = false;
    send({
      type: "pipPolicy",
      enabled: pipEnabledRef.current && frameReady,
      authorized: false,
    });
    // Returning to a visible viewer restores the user's previous input mode
    // through the host's normal authorization path, never by a local override.
    const restoration = wantsControl.current
      ? requestHostControlRef.current(current, true)
      : request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        })
          .then(() => {})
          .catch((cause) => {
            if (active.current === current) fail(cause);
          });
    if (restoration) {
      controlRestoration.current = restoration;
      void restoration.finally(() => {
        if (controlRestoration.current === restoration)
          controlRestoration.current = null;
      });
    }
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
            onStart: () => {
              recovery.current.resuming = true;
            },
            isCurrent: () => current === generation.current && alive.current,
            onCapabilities: (result) => {
              mark("capabilities");
              capsRef.current = { deviceId, value: result };
              setHostCaps({ deviceId, value: result });
              if (supportsAutoUnlock(result.platform)) {
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
                void securityRef.current.maybeUnlock(async () => {
                  if (
                    !(await firstFrame) ||
                    current !== generation.current ||
                    !focusedRef.current ||
                    !recovery.current.enabled
                  )
                    throw new Error("CREDENTIAL_CANCELLED");
                });
              }
            },
          });
        const display = next.display;
        recovery.current.displayId = display.id;
        mark("capture-started");
        active.current = next;
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
        send({
          type: "init",
          trickleIce: result.trickleIce === true,
          epoch: next.lease,
          width: display.width,
          height: display.height,
          fillHeight: landscape,
          audio:
            result.systemAudio &&
            videoSettingsRef.current.audio &&
            !audioUnavailable.current,
        });
        send({ type: "mode", mode });
        // Entering remote desktop is the user's intent to control. The existing
        // host permission and ownership gates still decide whether it is allowed.
        if (result.canControl && wantsControl.current) {
          try {
            const control = await viewerSession.current!.control(true);
            if (current !== generation.current) return;
            // Control changes keep the same session identity for in-flight replies.
            next.controlling = control.controlling;
            setLease({ ...next });
            send({ type: "control", enabled: control.controlling });
          } catch (cause) {
            if (current === generation.current) resolveControlFailure(cause);
          }
        }
        mark("control-ready");
        setControlReady(true);
      } catch (cause) {
        if (current === generation.current) fail(cause);
      } finally {
        if (current === generation.current) connecting.current = false;
      }
    },
    [
      deviceId,
      fail,
      landscape,
      mode,
      request,
      resolveControlFailure,
      send,
      stop,
      t,
      videoPreferencesLoaded,
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
    alive.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      setAppState(state);
      if (state === "active") presentationReturnedToActive.current = true;
      // iOS enters inactive during an interrupted Home gesture or a system
      // overlay. Release held input, but keep this viewer's lease and stream.
      if (state === "inactive") {
        send({ type: "releaseInput" });
        heldKeys.current.clear();
        setModifiers([]);
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
        pause();
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
      void request<{ controlling: boolean }>({
        op: "heartbeat",
        lease: current.lease,
      })
        .then((result) => {
          // The host owns the control bit. Follow it when it retracts control;
          // when a local transition timed out, retry a release or restore the
          // local bit so a held key cannot stay down behind a view-only phone.
          if (active.current !== current || presentation.current) return;
          if (result.controlling === false) {
            // startInput can still be settling while this heartbeat was in
            // flight. Clearing a pending take-control here would leave later
            // host-true beats with nothing to restore after a lost reply.
            if (pendingHostControl.current === true) return;
            pendingHostControl.current = null;
            if (current.controlling) releaseControl();
            return;
          }
          if (pendingHostControl.current === false) {
            requestHostControlRef.current(current, false);
            return;
          }
          if (!current.controlling && pendingHostControl.current === true)
            applyConfirmedControl(current, true);
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
  }, [focused, pause, videoPreferencesLoaded]);
  useEffect(() => {
    send({
      type: "theme",
      surface: colors.surface,
      foreground: colors.textPrimary,
    });
  }, [colors.surface, colors.textPrimary, send]);
  useEffect(() => {
    send({ type: "mode", mode });
  }, [mode, send]);
  useEffect(() => {
    send({
      type: "mouseButtons",
      native: Platform.OS === "ios",
      fitToInsets: fullScreenFoldBackground,
      topInset: fullScreenFoldBackground ? foldLayout!.media.y : tableRegion ? 0 : edgePadding.paddingTop,
      bottomInset: fullScreenFoldBackground
        ? Math.max(0, geometry.height - foldLayout!.media.y - foldLayout!.media.height) : tableRegion ? 0 :
        keyboard && landscapeKeyboardOverlay
          ? keyboardPanelHeight + keyboardBottom
          : !keyboard && !landscape
            ? toolbarSize.height
            : 0,
      keyboardOpen: keyboard && landscapeKeyboardOverlay,
      portraitKeyboardTopInset:
        keyboard && !landscape && !tableRegion
          ? edgePadding.paddingTop + spacing.xs + backControlHeight + spacing.sm
          : 0,
      // Side controls float over the desktop; fit against the full canvas width
      // in either landscape direction, including while the keyboard is open.
      rightInset: 0,
      leftInset: 0,
      enabled:
        showMouseButtons &&
        focused &&
        !operations &&
        !keyboard &&
        Boolean(lease?.controlling),
      labels: {
        left: t("remoteDesktop.leftClick"),
        right: t("remoteDesktop.rightClick"),
        wheel: t("remoteDesktop.mouseWheel"),
      },
    });
  }, [
    tableRegion?.first.height, tableRegion?.first.width,
    fullScreenFoldBackground, foldLayout?.media.y, foldLayout?.media.height, geometry.height,
    viewerReadyRevision,
    showMouseButtons,
    edgePadding.paddingTop,
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
    lease?.controlling,
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
      setViewerReadyRevision(revision => revision + 1);
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
      case "viewportSize":
        if (
          typeof message.width === "number" &&
          typeof message.height === "number"
        )
          void fitViewerDisplay(message.width, message.height);
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
          pause(!focusedRef.current);
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
          void stop(false, true);
          navigation.current.onEnded?.();
        } else if (!presentation.current) {
          restoreInlinePresentationRef.current();
          if (!NativeRemoteDesktopView && !videoSettingsRef.current.audio)
            void remotePresentation?.playback(false).catch(() => {});
          if (
            !NativeRemoteDesktopView &&
            AppState.currentState === "background"
          )
            pause();
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
        if (AppState.currentState === "background") pause();
        if (!focusedRef.current) {
          void stop(false, true);
          navigation.current.onEnded?.();
        }
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
        releaseControl();
        requestHostControl(current, false);
        break;
      }
      case "input": {
        const ack = {
          type: "ack",
          epoch: current.lease,
          sequence: message.sequence,
        };
        if (
          !current.controlling ||
          inputBusy.current === current.lease ||
          !Number.isSafeInteger(message.sequence) ||
          !Array.isArray(message.events) ||
          message.events.length > 64 ||
          !message.events.every(isDesktopInput)
        ) {
          send(ack);
          return;
        }
        inputBusy.current = current.lease;
        const events = message.events;
        void (async () => {
          if (
            NativeRemoteDesktopView &&
            (await nativeViewer.current?.sendInput(message).catch(() => false))
          )
            return;
          if (active.current !== current || !current.controlling) return;
          await request({
            op: "input",
            lease: current.lease,
            sequence: message.sequence as number,
            events,
          });
        })()
          .catch((cause) => {
            if (active.current !== current) return;
            resolveControlFailure(cause);
          })
          .finally(() => {
            if (inputBusy.current === current.lease) inputBusy.current = null;
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
    setBusy(true);
    setError(null);
    controlInFlight.current = true;
    try {
      pipPrepared.current = false;
      presentationGeneration.current++;
      send({ type: "pipPolicy", enabled: false });
      if (presentation.current) {
        presentation.current = false;
        send({ type: "presentation", enabled: false });
      }
      send({ type: "control", enabled: false });
      const enabled = viewOnlySelected;
      setViewOnlySelected(!enabled);
      wantsControl.current = enabled;
      if (pendingHostControl.current === false && enabled) {
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
      pendingHostControl.current = enabled;
      const result = await request<{ controlling: boolean }>({
        op: "control",
        lease: current.lease,
        enabled,
      });
      if (active.current !== current) return;
      applyConfirmedControl(current, result.controlling);
    } catch (cause) {
      // Taking control can fail because this computer cannot inject input right
      // now. Stay in view only and let the user retry; a session rebuild would
      // cost the picture and the lease for a control-only fault.
      if (active.current === current) resolveControlFailure(cause);
    } finally {
      controlInFlight.current = false;
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
      setCanPip(false);
      send({ type: "videoSettings", audio: settings.audio });
    } catch {
      if (active.current === current) {
        setSettingNotice(t("remoteDesktop.settingFailed"));
        setSettingBusy(false);
      }
    } finally {
      settingInFlight.current = false;
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
        pause(true);
        navigation.current.onEnded?.();
      }
      return;
    }
    settingInFlight.current = true;
    const startedAt = performance.now();
    const alreadyAuthorized = Boolean(
      NativeRemoteDesktopView && pipPrepared.current && !restoration,
    );
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
      pause(!focusedRef.current);
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
      heldKeys.current.clear();
      setModifiers([]);
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
      pause(!focusedRef.current);
      if (!focusedRef.current) navigation.current.onEnded?.();
    } finally {
      finishTransition?.();
      if (finishBackgroundTransition.current === finishTransition)
        finishBackgroundTransition.current = null;
      if (presentationGeneration.current === transition)
        settingInFlight.current = false;
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
      restoreAfterPipDisabled.current ||= pipPrepared.current;
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
    // CoreGraphics modes keep their own orientation when Electron's display
    // geometry is rotated. Compare modes in the enumeration's coordinate space.
    const reference = modes.find((mode) => mode.current) ?? { width, height };
    return modes.filter((mode) =>
      matchesViewer(mode, reference.width, reference.height),
    );
  };
  const changeResolution = async (modeId: string) => {
    const current = active.current;
    if (!current?.controlling || settingInFlight.current) return;
    if (
      caps?.resolutionRestore ||
      (caps?.viewerDisplay && caps.viewerDisplayRestore)
    ) {
      try {
        const modes = await readResolutionModes();
        if (active.current !== current) return;
        const mode = modes.find((item) => item.id === modeId);
        if (!mode) throw new Error("DESKTOP_DISPLAY_MODE_MISSING");
        if (
          caps?.resolutionRestore ||
          [mode.width, mode.height].every((size) => size >= 320 && size <= 2560)
        ) {
          await fitViewerDisplay(
            mode.width,
            mode.height,
            true,
            !fittedDisplay && caps?.resolutionRestore ? mode.id : undefined,
          );
          return;
        }
      } catch {
        if (active.current === current)
          setSettingNotice(t("remoteDesktop.settingFailed"));
        return;
      }
    }
    setSettingNotice(t("remoteDesktop.settingUnsupported"));
  };
  const fitViewerDisplay = async (
    width: number,
    height: number,
    exactResolution = false,
    modeId?: string,
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
      : viewerDisplaySize(width, height);
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
    setSettingBusy(true);
    setSettingNotice(null);
    const sourceDisplayId = recovery.current.displayId || current.display.id;
    send({ type: "control", enabled: false });
    try {
      viewerMedia.reset();
      const restore = Boolean(
        !exactResolution &&
        fittedDisplay &&
        caps?.viewerDisplayRestore &&
        matchesViewer(fittedDisplay, width, height),
      );
      const requestGeneration = viewportGeneration.current;
      const next = await viewerSession.current.fitDisplay(
        size.width,
        size.height,
        restore,
        modeId,
      );
      if (active.current !== current) return;
      // Reconnect the physical source display after the temporary mirror ends.
      recovery.current.displayId = sourceDisplayId;
      if (!exactResolution && viewportGeneration.current === requestGeneration)
        setViewerViewport({ width, height });
      setFittedDisplay((previous) =>
        modeId || restore
          ? null
          : exactResolution && previous
            ? previous
            : { width: next.display.width, height: next.display.height },
      );
      setLease({ ...next });
      streaming.current = false;
      setCanPip(false);
      send({
        type: "videoSettings",
        width: next.display.width,
        height: next.display.height,
        restore: restore || Boolean(modeId),
        audio: Boolean(caps?.systemAudio && videoSettingsRef.current.audio),
      });
      const control = await viewerSession.current.control(true);
      if (active.current === current)
        applyConfirmedControl(current, control.controlling);
    } catch (cause) {
      if (active.current === current) {
        setSettingNotice(t("remoteDesktop.settingFailed"));
        if ((cause as { code?: string })?.code === "INVOKE_TIMEOUT")
          fail(cause);
        else resolveControlFailure(cause);
      }
    } finally {
      settingInFlight.current = false;
      setSettingBusy(false);
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
    if (!lease?.controlling) return;
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
  const heldKey = (code: string) => (
    <Pressable
      key={code}
      accessibilityRole="button"
      accessibilityLabel={keyLabel(code)}
      style={({ pressed }) => [
        styles.computerKey,
        pressed && styles.keyPressed,
      ]}
      onPressIn={() => {
        if (!active.current?.controlling) return;
        const alreadyHeld = new Set([...heldKeys.current.values()].flat());
        const keys = comboMode ? [...modifiers, code] : [code];
        heldKeys.current.set(code, keys);
        send({
          type: "events",
          events: keys
            .filter((key) => !alreadyHeld.has(key))
            .map((key) => ({
              kind: "key",
              code: key,
              down: true,
            })),
        });
      }}
      onPressOut={() => {
        const keys = heldKeys.current.get(code) ?? [];
        heldKeys.current.delete(code);
        const stillHeld = new Set([...heldKeys.current.values()].flat());
        send({
          type: "events",
          events: keys
            .filter((key) => !stillHeld.has(key))
            .toReversed()
            .map((key) => ({ kind: "key", code: key, down: false })),
        });
        if (!comboMode) setModifiers([]);
      }}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[
          /^Key|^Digit|^Arrow/.test(code)
            ? styles.keyText
            : styles.specialKeyText,
        ]}
      >
        {keyLabel(code)}
      </Text>
    </Pressable>
  );
  const selectKeyboardMode = (computer: boolean) => {
    send({ type: "events", events: [{ kind: "release" }] });
    heldKeys.current.clear();
    setFullKeys(computer);
    setModifiers([]);
    if (!computer) setKeyboardFocusRequest((value) => value + 1);
  };
  const selectKeyPage = (page: number) => {
    if (page !== 0 && page !== 1) return;
    send({ type: "events", events: [{ kind: "release" }] });
    heldKeys.current.clear();
    setModifiers([]);
    setKeyPage(page);
  };
  return (
    <KeyboardAvoidingView
      testID="remoteDesktop.layout"
      enabled={!landscapeKeyboardOverlay && !foldLayout}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      {Platform.OS === "android" && focused && <StatusBar hidden />}
      <View style={[styles.body, landscape && styles.landscape]}>
        <View
          style={[
            styles.canvas,
            { marginLeft: landscape ? 0 : edgePadding.paddingLeft, marginRight: landscape ? 0 : edgePadding.paddingRight },
            fullScreenFoldBackground ? { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, marginLeft: 0, marginRight: 0 } : foldLayout && { position: 'absolute', flex: 0, left: foldLayout.media.x, top: foldLayout.media.y,
              width: foldLayout.media.width, height: foldLayout.media.height, marginLeft: 0, marginRight: 0 },
          ]}
        >
          <Animated.View
            testID="remoteDesktop.media"
            pointerEvents={frameReady ? "auto" : "none"}
            style={[StyleSheet.absoluteFill, mediaReveal]}
          >
            {NativeRemoteDesktopView && (
              <NativeRemoteDesktopView
                ref={nativeViewer}
                inlineVisible={focused}
                onMessage={(event) => nativeMessage.current(event)}
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: colors.surface },
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
            focused &&
            !operations &&
            !keyboard &&
            lease?.controlling && (
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
            (!lease && error)) && (
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
                  <Monitor
                    size={iconSize.lg}
                    strokeWidth={iconStroke.regular}
                    color={colors.textTertiary}
                  />
                  <Text numberOfLines={2} style={styles.waitingComputerName}>
                    {deviceName}
                  </Text>
                </View>
              )}
              {showConnectionStatus || showExitLockStatus ? (
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
          {lease && !showConnectionStatus && !operations && !landscape && (
            <RemoteDesktopNetworkStatus
              send={send}
              stats={network}
              video={status === "live"}
              top={edgePadding.paddingTop + spacing.sm}
            />
          )}
          {windowsOpen &&
            focused &&
            lease?.controlling &&
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
                railAnchor={systemSideRail ? {
                  right: (sideRailWidth - navigationChrome.target) / 2,
                  top: (sideRailTop + navigationChrome.target + spacing.lg + windowSize.height - insets.bottom - navigationChrome.target * (caps?.omarchyMenu ? 5 : 4)) / 2,
                } : undefined}
                toolbarOnLeft={toolbarOnLeft}
                toolbarActionCount={caps?.omarchyMenu ? 5 : 4}
                visible={operations && focused}
                landscape={landscape}
                topInset={edgePadding.paddingTop}
                title={t(
                  `remoteDesktop.${controlPage === "controls" ? "operations" : controlPage === "display" ? "displaySettings" : "security"}`,
                )}
                page={controlPage}
                onBack={
                  controlPage === "controls"
                    ? undefined
                    : () => setControlPage("controls")
                }
                caption={`${deviceName} · ${showConnectionStatus ? connectionLabel : t(`remoteDesktop.${status}`)}`}
                onClose={() => setOperations(false)}
                footer={
                  <RemoteDesktopDisconnect onPress={() => void leave()} />
                }
              >
                <RemoteDesktopControls
                  page={controlPage}
                  onPage={setControlPage}
                  security={{
                    ...security,
                    ...safety,
                    hostPlatform: caps?.platform,
                    lockOnExit,
                    lockOnExitAvailable:
                      lockOnExitLoaded && caps?.lockOnExit === true,
                    onLockOnExit: setLockOnExit,
                  }}
                  connected={Boolean(lease) && !connectionPending}
                  controlling={Boolean(lease?.controlling)}
                  viewOnly={viewOnlySelected}
                  controlDisabled={
                    !lease ||
                    busy ||
                    settingInFlight.current ||
                    Boolean(presentationTimer.current) ||
                    connecting.current ||
                    !caps?.canControl
                  }
                  presentation={{
                    enabled: pipEnabled,
                    canRotate: typeof remotePresentation?.rotate === "function" && !(geometry.reservedRegionsSupported && Platform.OS === "ios" && !Platform.isPad && geometry.regularWidth && geometry.regularHeight),
                    canPip: Boolean(
                      remotePresentation &&
                      caps?.backgroundViewing &&
                      (NativeRemoteDesktopView || canPip),
                    ),
                    canAudio: Boolean(caps?.systemAudio),
                    onRotate: () => {
                      void remotePresentation
                        ?.rotate?.(!landscape)
                        .then(() => setOperations(false))
                        .catch(() =>
                          setSettingNotice(t("remoteDesktop.settingFailed")),
                        );
                    },
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
                    viewerDisplayMatched,
                    onFitDisplay: () => send({ type: "measureViewport" }),
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
                  displays={caps?.displays ?? []}
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
              </RemoteDesktopPanel>
            </View>
          )}
        </View>
        {tableRegion && frameReady && focused && !keyboard && !operations ? (
          <View testID="remoteDesktop.foldControls" style={{ position: 'absolute', left: foldControls.x,
            top: foldControls.y, width: foldControls.width, height: foldControls.height,
            paddingBottom: toolbarSize.height + (showMouseButtons ? 80 : 0) }}>
            <FoldTouchpad send={send} enabled={Boolean(lease?.controlling)} />
            {showMouseButtons && lease?.controlling ? <RemoteDesktopMouseControls send={send}
              bottom={toolbarSize.height} right={0} compact labels={{ left: t("remoteDesktop.leftClick"),
                right: t("remoteDesktop.rightClick"), wheel: t("remoteDesktop.mouseWheel") }} /> : null}
          </View>
        ) : null}
        {!keyboard && (
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
              tableRegion && { left: foldControls.x, right: undefined, width: foldControls.width,
                bottom: geometry.height - foldControls.y - foldControls.height, paddingBottom: spacing.sm },
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
                alignItems: 'center',
                justifyContent: 'center',
              },
            ]}
          >
            <RemoteDesktopToolbar
              landscape={landscape || systemSideRail}
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
              canControl={Boolean(lease?.controlling)}
              keyboard={keyboard}
              operations={operations}
              onWindows={() => {
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
              }}
              onDesktop={() =>
                caps?.windowActions && lease?.controlling
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
                  : shortcut(
                      caps?.platform === "darwin"
                        ? ["F11"]
                        : ["MetaLeft", "KeyD"],
                    )
              }
              onKeyboard={() => {
                setOperations(false);
                if (keyboard) {
                  Keyboard.dismiss();
                  send({ type: "events", events: [{ kind: "release" }] });
                }
                setKeyboard(!keyboard);
              }}
              onOperations={() => {
                Keyboard.dismiss();
                setKeyboard(false);
                send({ type: "events", events: [{ kind: "release" }] });
                setOperations(!operations);
              }}
            />
          </Animated.View>
        )}
      </View>
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
              : edgePadding.paddingTop + spacing.xs,
            // iOS landscape: Island/notch sits mid-edge, so the top-left
            // corner stays clear even when insets.left is large. Skip that
            // inset unless the top edge is also unsafe — a physical cutout
            // occupying the corner, not a centered island. Android left
            // insets are an unsafe strip (cutout/curve), not an island.
            left: landscape
              ? (Platform.OS === "ios" && !geometry.reservedRegionsSupported && insets.top === 0 ? 0 : insets.left) +
                spacing.lg +
                (Platform.OS === "ios" ? spacing.xs : 0)
              : edgePadding.paddingLeft + spacing.lg,
          },
          systemSideRail && {
            top: sideRailTop,
            left: windowSize.width - (sideRailWidth + navigationChrome.target) / 2,
            width: navigationChrome.target,
          },
        ]}
      >
        <RemoteDesktopBackButton
          label={t("remoteDesktop.back")}
          onPress={back}
        />
      </View>
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
              paddingBottom: fullKeys
                ? Math.max(spacing.sm, insets.bottom)
                : spacing.xs,
            },
            foldLayout && { position: 'absolute', left: foldControls.x, width: foldControls.width,
              bottom: geometry.height - foldControls.y - foldControls.height,
              maxHeight: foldControls.height, paddingLeft: spacing.xs, paddingRight: spacing.sm, paddingBottom: 0 },
          ]}
        >
          <View style={styles.keyboardHeader}>
            <RemoteDesktopClipboardButton
              enabled={!connectionPending && Boolean(lease?.controlling)}
              supported={caps?.clipboardText === true}
              transfer={transferClipboard}
            />
            {Platform.OS === "ios" ? (
              <View style={{ flex: 1 }}>
                <SegmentedControl
                  values={[
                    t("remoteDesktop.inputMethod"),
                    t("remoteDesktop.computerKeyboard"),
                  ]}
                  selectedIndex={fullKeys ? 1 : 0}
                  appearance={colorScheme}
                  style={{ height: 44 }}
                  onChange={({ nativeEvent }) => {
                    if ([0, 1].includes(nativeEvent.selectedSegmentIndex))
                      selectKeyboardMode(
                        nativeEvent.selectedSegmentIndex === 1,
                      );
                  }}
                />
              </View>
            ) : (
              <View style={styles.modeSegments}>
                {[false, true].map((computer) => (
                  <Pressable
                    key={String(computer)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: fullKeys === computer }}
                    onPress={() => selectKeyboardMode(computer)}
                    style={({ pressed }) => [
                      styles.modeTab,
                      fullKeys === computer && styles.modeTabSelected,
                      pressed && styles.keyPressed,
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.modeText,
                        fullKeys === computer && styles.modeTextSelected,
                      ]}
                    >
                      {t(
                        computer
                          ? "remoteDesktop.computerKeyboard"
                          : "remoteDesktop.inputMethod",
                      )}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <RemoteDesktopPanelButton
              label={t("remoteDesktop.close")}
              onPress={() => {
                setKeyboard(false);
                heldKeys.current.clear();
                setModifiers([]);
                send({ type: "events", events: [{ kind: "release" }] });
              }}
            />
          </View>
          {fullKeys && (
            <View>
              <View style={styles.modifierRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: comboMode }}
                  accessibilityLabel={t("remoteDesktop.comboMode")}
                  onPress={() => {
                    send({ type: "events", events: [{ kind: "release" }] });
                    heldKeys.current.clear();
                    setComboMode(!comboMode);
                    setModifiers([]);
                  }}
                  style={({ pressed }) => [
                    styles.comboKey,
                    comboMode && styles.modifierSelected,
                    pressed && styles.keyPressed,
                  ]}
                >
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.modifierText,
                      comboMode && styles.modifierTextSelected,
                    ]}
                  >
                    {t("remoteDesktop.comboMode")}
                  </Text>
                </Pressable>
                {MODIFIERS.map((code) => (
                  <Pressable
                    key={code}
                    accessibilityRole="button"
                    accessibilityState={{ selected: modifiers.includes(code) }}
                    onPressIn={() => {
                      if (
                        comboMode ||
                        !active.current?.controlling ||
                        heldKeys.current.has(code)
                      )
                        return;
                      heldKeys.current.set(code, [code]);
                      send({
                        type: "events",
                        events: [{ kind: "key", code, down: true }],
                      });
                    }}
                    onPressOut={() => {
                      if (!heldKeys.current.has(code)) return;
                      heldKeys.current.delete(code);
                      send({
                        type: "events",
                        events: [{ kind: "key", code, down: false }],
                      });
                    }}
                    onPress={() => {
                      if (!comboMode || !active.current?.controlling) return;
                      setModifiers((previous) =>
                        previous.includes(code)
                          ? previous.filter((v) => v !== code)
                          : [...previous, code],
                      );
                    }}
                    style={({ pressed }) => [
                      styles.modifierKey,
                      modifiers.includes(code) && styles.modifierSelected,
                      pressed && styles.keyPressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.modifierText,
                        modifiers.includes(code) && styles.modifierTextSelected,
                      ]}
                    >
                      {keyLabel(code)}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <ScrollView
                testID="remoteDesktop.keyPageViewport"
                style={{ flexShrink: 1, maxHeight: landscape ? 156 : 300 }}
                keyboardShouldPersistTaps="always"
              >
                <View style={styles.tools}>
                  {KEY_PAGES[keyPage].map((row, index) => (
                    <View
                      key={index}
                      style={keyPage === 1 ? styles.functionRow : styles.keyRow}
                    >
                      {keyPage === 1
                        ? [row.slice(0, 3), row.slice(3)].map(
                            (group, groupIndex) => (
                              <View
                                key={groupIndex}
                                style={styles.functionGroup}
                              >
                                {group.map((code, slot) =>
                                  code ? (
                                    heldKey(code)
                                  ) : (
                                    <View
                                      key={`gap-${slot}`}
                                      style={styles.emptyKey}
                                      pointerEvents="none"
                                    />
                                  ),
                                )}
                              </View>
                            ),
                          )
                        : row.map((code) => (code ? heldKey(code) : null))}
                    </View>
                  ))}
                </View>
              </ScrollView>
              {Platform.OS === "ios" ? (
                <SegmentedControl
                  values={["ABC", t("remoteDesktop.functionKeys")]}
                  selectedIndex={keyPage}
                  appearance={colorScheme}
                  style={{ height: 44 }}
                  onChange={({ nativeEvent }) => {
                    selectKeyPage(nativeEvent.selectedSegmentIndex);
                  }}
                />
              ) : (
                <View style={styles.pageNavigation}>
                  {[0, 1].map((page) => (
                    <Pressable
                      key={page}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: keyPage === page }}
                      onPress={() => selectKeyPage(page)}
                      style={styles.pageTab}
                    >
                      <Text
                        style={[
                          styles.pageLabel,
                          keyPage === page && styles.pageLabelSelected,
                        ]}
                      >
                        {page === 0 ? "ABC" : t("remoteDesktop.functionKeys")}
                      </Text>
                      <View
                        style={[
                          styles.pageIndicator,
                          keyPage === page && styles.pageIndicatorSelected,
                        ]}
                      />
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    caption: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
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
      fontSize: typeScale.caption,
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
      fontWeight: fontWeight.semibold,
    },
    actionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    viewOnly: {
      position: "absolute",
      alignSelf: "center",
      color: colors.textPrimary,
      fontSize: typeScale.caption,
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
    tools: { gap: spacing.xs, paddingVertical: spacing.xs },
    keyRow: { flexDirection: "row", gap: spacing.xs },
    functionRow: { flexDirection: "row", gap: spacing.md },
    functionGroup: { flex: 1, flexDirection: "row", gap: spacing.xs },
    emptyKey: { flex: 1, minHeight: 44 },
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
    buttonText: { color: colors.textPrimary, fontSize: typeScale.caption },
    keyboardOverlay: { position: "absolute", left: 0, right: 0 },
    keyboard: {
      backgroundColor: colors.surfaceTranslucent,
      paddingHorizontal: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    keyboardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    modeSegments: {
      flex: 1,
      flexDirection: "row",
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.container,
      padding: spacing.xs,
    },
    modeTab: {
      flex: 1,
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
    },
    modeTabSelected: { backgroundColor: colors.surfaceElevated },
    modeText: {
      fontSize: typeScale.listBody,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    modeTextSelected: {
      color: colors.textPrimary,
      fontWeight: fontWeight.semibold,
    },
    closeKey: {
      width: 44,
      height: 44,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: radius.pill,
    },
    modifierRow: {
      flexDirection: "row",
      gap: spacing.xs,
      paddingBottom: spacing.xs,
    },
    comboKey: {
      flex: 1.25,
      minHeight: 44,
      paddingHorizontal: spacing.xs,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.control,
    },
    modifierKey: {
      flex: 1,
      minHeight: 40,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.control,
    },
    modifierSelected: { backgroundColor: colors.textPrimary },
    modifierText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    modifierTextSelected: { color: colors.surface },
    keyPressed: { opacity: 0.55 },
    keyText: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    specialKeyText: { color: colors.textPrimary, fontSize: typeScale.caption },
    pageNavigation: {
      flexDirection: "row",
      justifyContent: "center",
      gap: spacing.lg,
      paddingTop: 0,
    },
    pageTab: {
      minWidth: 64,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      gap: 0,
    },
    pageLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    pageLabelSelected: { color: colors.textPrimary },
    pageIndicator: {
      width: 16,
      height: 2,
      borderRadius: radius.pill,
      backgroundColor: "transparent",
    },
    pageIndicatorSelected: { backgroundColor: colors.textPrimary },
    computerKey: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.control,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
  });
