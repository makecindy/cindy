import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  AppState,
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
import {
  Stack,
  useLocalSearchParams,
  useRouter,
  useIsFocused,
} from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { transferClipboardContent } from "./clipboardTransfer";
import * as Clipboard from "expo-clipboard";
import { RemoteDesktopClipboardButton } from "./RemoteDesktopClipboardButton";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  isDesktopAttemptId,
  isDesktopIceCursor,
  parseDesktopIceCandidates,
  parseDesktopIceReply,
  type RemoteDesktopIceReply,
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
import { useMouseButtonsPreference } from "./useMouseButtonsPreference";
import { useInputModePreference } from "./useInputModePreference";
import { useVideoSettingsPreference } from "./useVideoSettingsPreference";
import { PermissionGuide } from "./PermissionGuide";
import { RemoteDesktopBackButton } from "./RemoteDesktopBackButton";
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
  const auth = useAuth();
  const { deviceId: rawId, deviceName: rawName } = useLocalSearchParams<{
    deviceId: string;
    deviceName?: string;
  }>();
  const deviceId = typeof rawId === "string" ? rawId : "";
  const deviceName = typeof rawName === "string" ? rawName : deviceId;
  const router = useRouter();
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const link = useDeviceLink();
  const linkRef = useRef(link);
  linkRef.current = link;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const windowSize = useWindowDimensions();
  const edgePadding = useScreenEdgePadding({
    insets,
    windowWidth: windowSize.width,
    windowHeight: windowSize.height,
  });
  const screenSize = Dimensions.get("screen");
  const landscape = screenSize.width > screenSize.height;
  const webview = useRef<ComponentRef<typeof WebView>>(null);
  const html = useRef(
    remoteDesktopViewerHtml(colors.surface, colors.textPrimary),
  ).current;
  const active = useRef<RemoteDesktopLease | null>(null);
  const wantsControl = useRef(true);
  const recovery = useRef({
    enabled: true,
    at: 0,
    delay: 1000,
    displayId: undefined as string | undefined,
    resuming: false,
  });
  const generation = useRef(0);
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
  const inputBusy = useRef<string | null>(null);
  const [lease, setLease] = useState<RemoteDesktopLease | null>(null);
  const [caps, setCaps] = useState<RemoteDesktopCapabilities | null>(null);
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [controlReady, setControlReady] = useState(false);
  const connectionPending = !error && (!lease || !frameReady || !controlReady);
  const showConnectionStatus = connectionPending || (!error && status === "reconnecting");
  const connectionLabel = t(
    recovery.current.at || status === "reconnecting"
      ? "remoteDesktop.reconnecting"
      : "remoteDesktop.connecting",
  );
  const [busy, setBusy] = useState(false);
  const [inputMode, setInputMode] = useInputModePreference();
  const mode: Mode = lease?.controlling ? inputMode : "pan";
  const [operations, setOperations] = useState(false);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  const [videoSettings, setVideoSettings, videoPreferencesLoaded] = useVideoSettingsPreference();
  const videoSettingsRef = useRef(videoSettings);
  videoSettingsRef.current = videoSettings;
  const audioUnavailable = useRef(false);
  const [settingNotice, setSettingNotice] = useState<string | null>(null);
  const [settingBusy, setSettingBusy] = useState(false);
  const settingInFlight = useRef(false);
  const [canPip, setCanPip] = useState(false);
  const presentation = useRef(false);
  const presentationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showMouseButtons, setShowMouseButtons] = useMouseButtonsPreference();
  const [keyboard, setKeyboard] = useState(false);
  const [fullKeys, setFullKeys] = useState(false);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [nativeKeyboard, setNativeKeyboard] = useState(false);
  const [nativeKeyboardHeight, setNativeKeyboardHeight] = useState(0);
  const [keyboardPanelHeight, setKeyboardPanelHeight] = useState(0);
  // Android's system keyboard already resizes the window. Keep its existing
  // flow layout; only iOS needs an offset above the native keyboard.
  const landscapeKeyboardOverlay = landscape && (Platform.OS === "ios" || fullKeys);
  const keyboardBottom = Platform.OS === "ios" && keyboard && !fullKeys
    ? nativeKeyboardHeight : 0;
  const heldKeys = useRef(new Map<string, string[]>());
  const [keyPage, setKeyPage] = useState(0);
  const [comboMode, setComboMode] = useState(true);
  const [modifiers, setModifiers] = useState<string[]>([]);
  const send = useCallback(
    (message: object) => webview.current?.postMessage(JSON.stringify(message)),
    [],
  );
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
  const transferClipboard = async (action: "copy" | "paste") => {
    const current = active.current;
    const epoch = generation.current;
    const check = () => {
      if (!alive.current || generation.current !== epoch || active.current !== current || !current?.controlling || AppState.currentState !== "active")
        throw new Error("DESKTOP_LEASE_EXPIRED");
    };
    check();
    send({ type: "events", events: [{ kind: "release" }] });
    heldKeys.current.clear();
    setModifiers([]);
    if (caps?.clipboardContent && remotePresentation?.readClipboard && remotePresentation?.writeClipboard) {
      await transferClipboardContent(action, current!.lease, request, check);
      return;
    }
    if (action === "paste" && (await Clipboard.hasImageAsync())) throw new Error("CLIPBOARD_UPGRADE");
    if (action === "copy") {
      const result = await request<{ text: string }>({ op: "clipboard", lease: current!.lease, action });
      check();
      if (typeof result.text !== "string" || !result.text) throw new Error("CLIPBOARD_EMPTY");
      if (result.text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS) throw new Error("CLIPBOARD_TOO_LONG");
      if (!(await Clipboard.setStringAsync(result.text))) throw new Error("CLIPBOARD_WRITE_FAILED");
    } else {
      const text = await Clipboard.getStringAsync();
      check();
      if (!text) throw new Error("CLIPBOARD_EMPTY");
      if (text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS) throw new Error("CLIPBOARD_TOO_LONG");
      await request({ op: "clipboard", lease: current!.lease, action, text });
      check();
    }
  };
  useEffect(() => {
    const updateFrame = (event: KeyboardEvent) => {
      const height = Math.max(
        0,
        Dimensions.get("screen").height - event.endCoordinates.screenY,
      );
      setNativeKeyboardHeight(height);
      setNativeKeyboard(height > 0);
    };
    const show = Keyboard.addListener("keyboardDidShow", updateFrame);
    const frame = Platform.OS === "ios"
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

  const stop = useCallback((preserveFrame = false) => {
    generation.current++;
    presentation.current = false;
    if (presentationTimer.current) clearTimeout(presentationTimer.current);
    presentationTimer.current = null;
    void remotePresentation?.playback(false).catch(() => {});
    connecting.current = false;
    const previous = active.current;
    active.current = null;
    mediaAttempt.current = null;
    heldKeys.current.clear();
    streaming.current = false;
    receiveWindow.current = {
      since: Date.now(),
      bytes: 0,
      frameMs: null,
      frameAt: 0,
    };
    send({ type: "stop", preserveFrame });
    if (alive.current) {
      setLease(null);
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
    if (previous)
      void request({ op: "stop", lease: previous.lease }).catch(() => {});
  }, [request, send]);
  const fail = useCallback(
    (cause: unknown) => {
      if (!alive.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const code =
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : message.match(
              /\b(?:DESKTOP|CHANNEL|DEVICE|INVOKE|REMOTE|ACCESS)_[A-Z_]+\b/,
            )?.[0];
      // Keep diagnostics free of device names, input and signaling payloads.
      console.debug("[remote-desktop] connection failed", {
        code: code && /^[A-Z_]+$/.test(code) ? code : "UNKNOWN",
      });
      const blocked =
        code === "ACCESS_REVOKED"
          ? "accessRevoked"
          : code === "REMOTE_DISABLED"
            ? "remoteDisabled"
            : code === "DESKTOP_BUSY"
              ? "connectionBusy"
              : code === "CHANNEL_NOT_ALLOWED"
                ? "upgrade"
                : message.includes("DESKTOP_DISABLED")
                  ? "disabled"
                  : message.includes("PERMISSION") ||
                      message.includes("ACCESSIBILITY")
                    ? "permissionHint"
                    : message.includes("DESKTOP_STOPPED")
                      ? "disconnected"
                      : null;
      stop(!blocked);
      setError(blocked);
      if (blocked) recovery.current.enabled = false;
      else {
        recovery.current.at = Date.now() + recovery.current.delay;
        recovery.current.delay = Math.min(15_000, recovery.current.delay * 2);
        setStatus("reconnecting");
      }
    },
    [stop],
  );
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
      setError(null);
      setStatus(recovery.current.at ? "reconnecting" : "connecting");
      try {
        await linkRef.current.openLink(deviceId);
        if (current !== generation.current) return;
        const result = await request<RemoteDesktopCapabilities>({
          op: "capabilities",
        });
        if (current !== generation.current) return;
        if (result?.version !== 1) throw new Error("CHANNEL_NOT_ALLOWED");
        setCaps(result);
        if (!result.enabled) throw new Error("DESKTOP_DISABLED");
        if (recovery.current.resuming && !result.automaticReconnect)
          throw new Error("CHANNEL_NOT_ALLOWED");
        const display =
          result.displays.find(
            (d) => d.id === (displayId ?? recovery.current.displayId),
          ) ?? result.displays[0];
        if (!display) throw new Error("DESKTOP_DISPLAY_MISSING");
        recovery.current.displayId = display.id;
        const resuming = recovery.current.resuming;
        // The host may start successfully even when its reply is lost.
        recovery.current.resuming = true;
        const next = await request<RemoteDesktopLease>({
          op: "start",
          displayId: display.id,
          ...(takeover && result.connectionTakeover ? { takeover: true } : resuming ? { resume: true } : {}),
        });
        if (current !== generation.current) {
          void request({ op: "stop", lease: next.lease }).catch(() => {});
          return;
        }
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
        if (result.systemAudio && videoSettingsRef.current.audio) {
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
          audio: result.systemAudio && videoSettingsRef.current.audio && !audioUnavailable.current,
        });
        send({ type: "mode", mode });
        // Entering remote desktop is the user's intent to control. The existing
        // host permission and ownership gates still decide whether it is allowed.
        if (result.canControl && wantsControl.current) {
          const control = await request<{ controlling: boolean }>({
            op: "control",
            lease: next.lease,
            enabled: true,
          });
          if (current !== generation.current) return;
          // Control changes keep the same session identity for in-flight replies.
          next.controlling = control.controlling;
          setLease({ ...next });
          send({ type: "control", enabled: control.controlling });
        }
        setControlReady(true);
      } catch (cause) {
        if (current === generation.current) fail(cause);
      } finally {
        if (current === generation.current) connecting.current = false;
      }
    },
    [deviceId, fail, landscape, mode, request, send, stop, t, videoPreferencesLoaded],
  );
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const pause = useCallback(() => {
    stop(true);
    if (recovery.current.enabled) {
      recovery.current.at = Date.now();
      setStatus("reconnecting");
    }
  }, [stop]);
  const leave = () => {
    recovery.current.enabled = false;
    Keyboard.dismiss();
    stop();
    goBackGuarded(router);
  };
  const retry = () => {
    recovery.current.enabled = true;
    recovery.current.at = Date.now();
    recovery.current.delay = 1000;
    recovery.current.resuming = false;
    setError(null);
    setStatus("reconnecting");
    if (!ready.current) webview.current?.reload();
    else void connectRef.current(undefined, error === "connectionBusy" && caps?.connectionTakeover === true);
  };
  const restartViewer = () => {
    ready.current = false;
    if (!alive.current || !recovery.current.enabled) return;
    fail(new Error("DESKTOP_VIEWER_ERROR"));
  };
  useEffect(() => {
    send({ type: "viewport", fillHeight: landscape });
  }, [landscape, send]);

  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      // iOS enters inactive during an interrupted Home gesture or a system
      // overlay. Release held input, but keep this viewer's lease and stream.
      if (state === "inactive") {
        send({ type: "releaseInput" });
        heldKeys.current.clear();
        setModifiers([]);
      } else if (state === "background" && !presentation.current) pause();
      else if (state === "active" && active.current)
        send({ type: "resume" });
      else if (state === "active" && recovery.current.enabled && !active.current)
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
        (presentation.current && AppState.currentState !== "active")
      )
        return;
      heartbeatBusy = current.lease;
      void request({ op: "heartbeat", lease: current.lease })
        .catch((cause) => {
          // A missing reply does not prove renewal failed; the next interval
          // retries within the lease. Explicit host revocation still stops us.
          if (cause && typeof cause === "object" && cause.code === "INVOKE_TIMEOUT") return;
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
      void request<{ jpeg: string | null; cursor?: RemoteDesktopCursor | null }>({
        op: "frame",
        lease: current.lease,
        cursorOverlay: capsRef.current?.cursorOverlay === true,
      })
        .then((result) => {
          if (
            active.current === current &&
            !streaming.current &&
            typeof result.jpeg === "string" &&
            result.jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4
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
            send({ type: "frame", jpeg: result.jpeg, ...(isRemoteDesktopCursor(result.cursor) || result.cursor === null ? { cursor: result.cursor } : {}) });
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
  }, [request, fail, send, stop, pause]);
  useEffect(() => {
    if (!focused && !presentation.current) pause();
    else if (!active.current) void connectRef.current();
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
      bottomInset:
        keyboard && landscapeKeyboardOverlay
          ? keyboardPanelHeight + keyboardBottom
          : !keyboard && !landscape ? toolbarSize.height : 0,
      keyboardOpen: keyboard && landscapeKeyboardOverlay,
      rightInset: !keyboard && landscape ? toolbarSize.width : 0,
      leftInset: landscape ? insets.left : 0,
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
    showMouseButtons,
    insets.left,
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
    if (link.status !== "online" && !presentation.current) pause();
    else if (!active.current) void connectRef.current();
  }, [link.status, pause]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (!alive.current || event.nativeEvent.data.length > 65_536) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      ready.current = true;
      void connectRef.current();
      return;
    }
    const current = active.current;
    if (!current || message.epoch !== current.lease) return;
    const requireMediaAttempt = () => {
      if (
        active.current !== current ||
        mediaAttempt.current !== message.attemptId
      )
        throw new Error("DESKTOP_VIDEO_STOPPED");
    };
    switch (message.type) {
      case "iceConfig":
        if (!isDesktopAttemptId(message.attemptId)) return;
        mediaAttempt.current = message.attemptId;
        void resolveDesktopIceServers(() =>
          auth.apiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
            baseUrl: DEVICE_LINK_API_BASE_URL,
            timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
            cache: "no-store",
          }),
        ).then((iceServers) => {
          if (
            !alive.current ||
            active.current !== current ||
            mediaAttempt.current !== message.attemptId
          )
            return;
          send({
            type: "iceConfig",
            epoch: current.lease,
            attemptId: message.attemptId,
            iceServers,
          });
        });
        break;
      case "offer":
        if (
          typeof message.sdp !== "string" ||
          message.sdp.length > 64_000 ||
          !isDesktopAttemptId(message.attemptId)
        )
          return;
        mediaAttempt.current = message.attemptId;
        void request<{ sdp: string }>(
          {
            op: "offer",
            lease: current.lease,
            sdp: message.sdp,
            ...(caps?.trickleIce ? { attemptId: message.attemptId } : {}),
            cursorOverlay: caps?.cursorOverlay === true,
            ...(caps?.videoSettings
              ? {
                  settings: {
                    ...videoSettingsRef.current,
                    audio: Boolean(
                      caps.systemAudio && videoSettingsRef.current.audio && !audioUnavailable.current,
                    ),
                  },
                }
              : {}),
          },
          requireMediaAttempt,
        )
          .then((answer) => {
            if (
              active.current === current &&
              mediaAttempt.current === message.attemptId
            )
              send({
                type: "answer",
                epoch: current.lease,
                attemptId: message.attemptId,
                sdp: answer.sdp,
              });
          })
          .catch((error) => {
            if (
              active.current === current &&
              mediaAttempt.current === message.attemptId
            ) {
              const permanent =
                /DESKTOP_(AUDIO_UNAVAILABLE|SCREEN_PERMISSION_REQUIRED|DISABLED|STOPPED|LEASE_EXPIRED)/.test(
                  String(error),
                );
              send({
                type: "fallback",
                epoch: current.lease,
                attemptId: message.attemptId,
                retry: !permanent,
              });
              setStatus("compatibility");
              setSettingBusy(false);
              setSettingNotice(t("remoteDesktop.videoSettingsFailed"));
            }
          });
        break;
      case "ice": {
        if (
          !caps?.trickleIce ||
          message.attemptId !== mediaAttempt.current ||
          !isDesktopAttemptId(message.attemptId) ||
          !isDesktopIceCursor(message.after) ||
          !Number.isSafeInteger(message.exchangeId)
        )
          return;
        let candidates;
        try {
          candidates = parseDesktopIceCandidates(message.candidates);
        } catch {
          return;
        }
        void request<RemoteDesktopIceReply>(
          {
            op: "ice",
            lease: current.lease,
            attemptId: message.attemptId,
            after: message.after,
            candidates,
          },
          requireMediaAttempt,
        )
          .then((value) => {
            const reply = parseDesktopIceReply(value);
            if (
              active.current === current &&
              mediaAttempt.current === message.attemptId &&
              reply.attemptId === message.attemptId
            )
              send({
                type: "ice",
                epoch: current.lease,
                exchangeId: message.exchangeId,
                ...reply,
              });
          })
          .catch(() => {
            if (
              active.current === current &&
              mediaAttempt.current === message.attemptId
            )
              send({
                type: "ice",
                epoch: current.lease,
                attemptId: message.attemptId,
                exchangeId: message.exchangeId,
                error: true,
              });
          });
        break;
      }
      case "reconnecting":
        if (message.attemptId === mediaAttempt.current)
          setStatus("reconnecting");
        break;
      case "pipCapability":
        setCanPip(message.supported === true);
        break;
      case "presentation":
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        presentation.current = message.active === true;
        if (!presentation.current) {
          void request({
            op: "presentation",
            lease: current.lease,
            enabled: false,
          }).catch(() => {});
          if (!videoSettingsRef.current.audio)
            void remotePresentation?.playback(false).catch(() => {});
          if (AppState.currentState === "background") pause();
        }
        break;
      case "presentationFailed":
        presentation.current = false;
        if (presentationTimer.current) clearTimeout(presentationTimer.current);
        presentationTimer.current = null;
        void request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        }).catch(() => {});
        if (!videoSettingsRef.current.audio)
          void remotePresentation?.playback(false).catch(() => {});
        setSettingNotice(t("remoteDesktop.pipUnavailable"));
        setOperations(true);
        if (AppState.currentState === "background") pause();
        break;
      case "streaming":
        setFrameReady(true);
        setSettingBusy(false);
        recovery.current.delay = 1000;
        streaming.current = true;
        setNetwork(null);
        setStatus("live");
        break;
      case "framePresented":
        setFrameReady(true);
        break;
      case "fallback":
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
      case "inputOverflow":
        fail(new Error("DESKTOP_INPUT_UNAVAILABLE"));
        break;
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
        void request({
          op: "input",
          lease: current.lease,
          sequence: message.sequence as number,
          events: message.events,
        })
          .catch((cause) => {
            if (active.current === current) fail(cause);
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
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (presentation.current) {
        presentation.current = false;
        send({ type: "presentation", enabled: false });
      }
      send({ type: "control", enabled: false });
      const result = await request<{ controlling: boolean }>({
        op: "control",
        lease: current.lease,
        enabled: !current.controlling,
      });
      if (active.current !== current) return;
      wantsControl.current = result.controlling;
      current.controlling = result.controlling;
      setLease({ ...current });
      send({ type: "control", enabled: result.controlling });
      if (!result.controlling) {
        heldKeys.current.clear();
        setModifiers([]);
        setKeyboard(false);
      }
    } catch (cause) {
      if (active.current === current) fail(cause);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const changeVideoSettings = async (settings: RemoteDesktopVideoSettings) => {
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
      if (presentation.current) {
        presentation.current = false;
        send({ type: "presentation", enabled: false });
        await request({ op: "presentation", lease: current.lease, enabled: false });
      }
      if (settings.audio) await remotePresentation?.playback(true);
      else if (!presentation.current) await remotePresentation?.playback(false);
      if (active.current !== current) return;
      audioUnavailable.current = false;
      videoSettingsRef.current = settings;
      setVideoSettings(settings);
      streaming.current = false;
      setCanPip(false);
      send({ type: "videoSettings", audio: settings.audio });
    } catch {
      setSettingNotice(t("remoteDesktop.settingFailed"));
      setSettingBusy(false);
    } finally {
      settingInFlight.current = false;
    }
  };
  const startPresentation = async () => {
    const current = active.current;
    if (
      !current ||
      !caps?.backgroundViewing ||
      !canPip ||
      !remotePresentation ||
      settingInFlight.current
    )
      return;
    settingInFlight.current = true;
    setSettingNotice(null);
    try {
      await remotePresentation.playback(true);
      if (active.current !== current) return;
      await request({
        op: "presentation",
        lease: current.lease,
        enabled: true,
      }).catch((cause) => {
        // A lost reply leaves the host transition uncertain. Retire only this
        // lease and use normal recovery instead of guessing its control state.
        if (active.current === current) pause();
        throw cause;
      });
      if (active.current !== current) return;
      send({ type: "control", enabled: false });
      current.controlling = false;
      wantsControl.current = false;
      heldKeys.current.clear();
      setModifiers([]);
      setKeyboard(false);
      setLease({ ...current });
      presentation.current = true;
      setOperations(false);
      send({ type: "presentation", enabled: true });
      presentationTimer.current = setTimeout(() => {
        presentationTimer.current = null;
        presentation.current = false;
        send({ type: "presentation", enabled: false });
        void request({
          op: "presentation",
          lease: current.lease,
          enabled: false,
        }).catch(() => {});
        if (!videoSettingsRef.current.audio)
          void remotePresentation?.playback(false).catch(() => {});
        setSettingNotice(t("remoteDesktop.pipUnavailable"));
        setOperations(true);
        if (AppState.currentState === "background") pause();
      }, 4000);
    } catch {
      if (active.current !== current) return;
      presentation.current = false;
      if (!videoSettingsRef.current.audio)
        void remotePresentation?.playback(false).catch(() => {});
      setSettingNotice(t("remoteDesktop.pipUnavailable"));
    } finally {
      settingInFlight.current = false;
    }
  };
  const changeResolution = async (modeId: string) => {
    const current = active.current;
    if (!current?.controlling || settingInFlight.current) return;
    settingInFlight.current = true;
    setSettingBusy(true);
    setSettingNotice(null);
    try {
      await request({ op: "resolution", lease: current.lease, modeId });
      if (active.current === current) {
        stop(true);
        recovery.current.at = Date.now() + 500;
        setStatus("reconnecting");
      }
    } catch (cause) {
      // Geometry changes may end the old lease before its reply reaches us.
      if (active.current === current)
        setSettingNotice(t("remoteDesktop.settingFailed"));
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
  return (
    <KeyboardAvoidingView
      testID="remoteDesktop.layout"
      enabled={!landscapeKeyboardOverlay}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      <Stack.Screen
        options={{
          headerShown: false,
          gestureEnabled: false,
          statusBarHidden: true,
        }}
      />
      {Platform.OS === "android" && focused && <StatusBar hidden />}
      <View style={[styles.body, landscape && styles.landscape]}>
        <View style={[styles.canvas, { marginLeft: landscape ? 0 : edgePadding.paddingLeft }]}>
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
            dataDetectorTypes="none"
            javaScriptEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsPictureInPictureMediaPlayback
            scrollEnabled={false}
            bounces={false}
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            allowFileAccessFromFileURLs={false}
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            mixedContentMode="never"
            style={styles.webview}
            testID="remoteDesktop.viewer"
          />
          {(showConnectionStatus || (!lease && error)) && (
            <View
              pointerEvents="box-none"
              style={[
                styles.connectionStatus,
                { top: edgePadding.paddingTop + spacing.xs + 44 + spacing.lg },
              ]}
            >
              {showConnectionStatus ? (
                <View
                  style={styles.connectionBadge}
                  accessibilityRole="progressbar"
                  accessibilityLabel={connectionLabel}
                  accessibilityState={{ busy: true }}
                  testID="remoteDesktop.connectingStatus"
                >
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                  <Text style={styles.connectionLabel}>{connectionLabel}</Text>
                </View>
              ) : error !== "permissionHint" && (
                <Text
                  accessibilityRole={error ? "alert" : undefined}
                  style={styles.caption}
                >
                  {t(error === "accessRevoked" || error === "remoteDisabled"
                    ? `deviceLink.remoteError.${error}`
                    : `remoteDesktop.${error === "connectionBusy" && caps?.connectionTakeover ? "connectionBusyTakeover" : error ?? status}`)}
                </Text>
              )}
              {error &&
                error !== "permissionHint" &&
                button(t(error === "connectionBusy" && caps?.connectionTakeover ? "remoteDesktop.takeoverConnection" : "remoteDesktop.connect"), retry)}
              {error === "permissionHint" && focused && (
                <PermissionGuide
                  key={deviceId}
                  initial={caps?.permissions}
                  request={request}
                  reconnect={retry}
                />
              )}
            </View>
          )}
          {lease && !showConnectionStatus && !lease.controlling && !operations && (
            <Text
              style={[
                styles.viewOnly,
                { bottom: spacing.sm + (!keyboard && !landscape ? toolbarSize.height : 0), left: spacing.sm },
              ]}
            >
              {t("remoteDesktop.viewOnly")}
            </Text>
          )}
          {lease && !showConnectionStatus && !operations && !landscape && (
            <RemoteDesktopNetworkStatus
              stats={network}
              video={status === "live"}
              top={edgePadding.paddingTop + spacing.sm}
            />
          )}
          {operations && (
            <View
              pointerEvents="box-none"
              style={[
                StyleSheet.absoluteFill,
                { bottom: landscape ? 0 : toolbarSize.height,
                  right: landscape ? toolbarSize.width : 0 },
              ]}
            >
            <RemoteDesktopPanel
              landscape={landscape}
              topInset={edgePadding.paddingTop}
              title={deviceName}
              caption={showConnectionStatus ? connectionLabel : `${t(`remoteDesktop.${status}`)}${lease ? ` · ${t(lease.controlling ? "remoteDesktop.controlling" : "remoteDesktop.viewOnly")}` : ""}`}
              onClose={() => setOperations(false)}
              footer={<RemoteDesktopDisconnect onPress={leave} />}
            >
              <RemoteDesktopControls
                connected={Boolean(lease) && !connectionPending}
                controlling={Boolean(lease?.controlling)}
                controlDisabled={
                  !lease || busy || connecting.current || !caps?.canControl
                }
                presentation={{
                  canRotate: Boolean(remotePresentation),
                  canPip: Boolean(
                    remotePresentation && caps?.backgroundViewing && canPip,
                  ),
                  canAudio: Boolean(caps?.systemAudio),
                  onRotate: () => {
                    void remotePresentation
                      ?.rotate(!landscape)
                      .then(() => setOperations(false))
                      .catch(() =>
                        setSettingNotice(t("remoteDesktop.settingFailed")),
                      );
                  },
                  onPip: () => {
                    void startPresentation();
                  },
                }}
                video={{
                  supported: Boolean(caps?.videoSettings),
                  settings: videoSettings,
                  busy: settingBusy,
                  modesSupported: Boolean(caps?.displayModes),
                  notice: audioUnavailable.current ? t("remoteDesktop.audioUnavailable") : settingNotice,
                  onChange: (settings) => {
                    void changeVideoSettings(settings);
                  },
                  readModes: () =>
                    active.current
                      ? request<RemoteDesktopDisplayMode[]>({
                          op: "displayModes",
                          lease: active.current.lease,
                        })
                      : Promise.resolve([]),
                  onResolution: changeResolution,
                }}
                inputMode={inputMode}
                displays={caps?.displays ?? []}
                displayId={lease?.display.id}
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
        {!keyboard && (
          <View
            onLayout={({ nativeEvent: { layout } }) => {
              setToolbarSize((previous) =>
                previous.width === layout.width && previous.height === layout.height
                  ? previous : { width: layout.width, height: layout.height });
            }}
            style={[styles.floatingToolbar, landscape ? styles.floatingRail : styles.floatingBottom, {
              paddingRight: landscape
                ? spacing.xs
                : edgePadding.paddingRight,
              paddingLeft: landscape ? 0 : edgePadding.paddingLeft,
              paddingBottom: keyboard || nativeKeyboard ? 0 : insets.bottom,
            }]}
          >
            <RemoteDesktopToolbar
              landscape={landscape}
              canControl={Boolean(lease?.controlling)}
              keyboard={keyboard}
              operations={operations}
              onWindows={() =>
                shortcut(
                  caps?.platform === "darwin"
                    ? ["ControlLeft", "ArrowUp"]
                    : ["MetaLeft", "Tab"],
                )
              }
              onDesktop={() =>
                shortcut(
                  caps?.platform === "darwin" ? ["F11"] : ["MetaLeft", "KeyD"],
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
          </View>
        )}
      </View>
      {!landscape && (
        <View
          style={[
            styles.back,
            {
              top: edgePadding.paddingTop + spacing.xs,
              left: edgePadding.paddingLeft + spacing.lg,
            },
          ]}
        >
          <RemoteDesktopBackButton
            label={t("remoteDesktop.back")}
            onPress={leave}
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
            landscapeKeyboardOverlay && [styles.keyboardOverlay, { bottom: keyboardBottom }],
            {
              paddingLeft: Math.max(spacing.xs, edgePadding.paddingLeft),
              paddingRight: Math.max(spacing.sm, edgePadding.paddingRight),
              paddingBottom: fullKeys
                ? Math.max(spacing.sm, insets.bottom)
                : spacing.xs,
            },
          ]}
        >
          <View style={styles.keyboardHeader}>
            <RemoteDesktopClipboardButton
              enabled={!connectionPending && Boolean(lease?.controlling)}
              supported={caps?.clipboardText === true}
              transfer={transferClipboard}
            />
            <View style={styles.modeSegments}>
              {[false, true].map((computer) => (
                <Pressable
                  key={String(computer)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: fullKeys === computer }}
                  onPress={() => {
                    send({ type: "events", events: [{ kind: "release" }] });
                    heldKeys.current.clear();
                    setFullKeys(computer);
                    setModifiers([]);
                    if (!computer)
                      setKeyboardFocusRequest((value) => value + 1);
                  }}
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("remoteDesktop.close")}
              onPress={() => {
                setKeyboard(false);
                heldKeys.current.clear();
                setModifiers([]);
                send({ type: "events", events: [{ kind: "release" }] });
              }}
              style={({ pressed }) => [
                styles.closeKey,
                pressed && styles.keyPressed,
              ]}
            >
              <X size={iconSize.action} strokeWidth={iconStroke.thin} color={colors.textPrimary} />
            </Pressable>
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
                style={{ maxHeight: landscape ? 156 : 300 }}
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
              <View style={styles.pageNavigation}>
                {[0, 1].map((page) => (
                  <Pressable
                    key={page}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: keyPage === page }}
                    onPress={() => setKeyPage(page)}
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
      height: 22,
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
