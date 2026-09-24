import { GeometryContext } from '@/platform/AdaptiveWindowContext';
import type { WindowGeometry } from '@/platform/windowGeometry';
// @vitest-environment jsdom
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RemoteDesktopScreen, {
  RemoteDesktopSession,
} from "../RemoteDesktopScreen";
import { RemoteDesktopDisplaySettings } from "../RemoteDesktopDisplaySettings";
import { AppState } from "react-native";
import { goBackGuarded } from "@/utils/backGuard";
import AsyncStorage from "@react-native-async-storage/async-storage";

vi.mock('expo-blur', async () => ({ BlurView: (await import('react-native')).View }));

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return { default: { View } };
});

vi.mock("../useAutoUnlockSettings", () => ({
  useAutoUnlockSettings: (
    _target: string,
    _active: boolean,
    getHost: () => string | undefined,
  ) => {
    fixture.getHost = getHost;
    return {
      autoUnlock: fixture.securityAutoUnlock,
      biometricVerification: true,
      available: true,
      busy: fixture.securityBusy,
      notice: null,
      onAutoUnlock: vi.fn(),
      onBiometricVerification: vi.fn(),
      maybeUnlock: fixture.maybeUnlock,
      resetConnectionAttempt: fixture.resetUnlockAttempt,
    };
  },
}));
vi.mock("../useLockOnExitPreference", () => ({
  useRemoteDesktopPreference: () => [false, vi.fn(), true],
  useLockOnExitPreference: () => [
    fixture.lockOnExit,
    (value: boolean) => {
      fixture.lockOnExit = value;
    },
    true,
  ],
}));
vi.mock("../usePictureInPicturePreference", () => ({
  usePictureInPicturePreference: () => {
    const [enabled, setEnabled] = useState(fixture.pipEnabled);
    return [
      enabled,
      (value: boolean) => {
        fixture.pipEnabled = value;
        setEnabled(value);
      },
    ];
  },
}));

const fixture = vi.hoisted(() => ({
  nativeMedia: false,
  iosVersion: 26,
  pipEnabled: false,
  nativeReceive: vi.fn(async (_message: object) => {}),
  nativeInput: vi.fn(async (_message: object) => true),
  nativeMessage: null as
    null | ((event: { nativeEvent: { data: string } }) => void),
  nativeMenus: false,
  safe: { top: 59, bottom: 34, left: 0, right: 0 },
  securityAutoUnlock: false,
  securityBusy: false,
  themeMode: "light",
  lockOnExit: false,
  lockSupported: true,
  alert: vi.fn(),
  resetUnlockAttempt: vi.fn(),
  maybeUnlock: vi.fn(async (_beforeAuthentication?: () => Promise<void>) => {}),
  hostPlatform: "darwin" as string | undefined,
  deviceId: "computer",
  getHost: (() => undefined) as () => string | undefined,
  platform: "ios",
  keyboardListeners: {} as Record<string, (event: unknown) => void>,
  views: {} as Record<string, any>,
  invoke: vi.fn(),
  finishBackgroundTransition: vi.fn(),
  beginBackgroundTransition: vi.fn(),
  apiFetch: vi.fn(),
  openLink: vi.fn(),
  post: vi.fn(),
  reload: vi.fn(),
  message: null as null | ((e: unknown) => void),
  size: { width: 390, height: 844 },
  displaySize: null as { width: number; height: number } | null,
  canControl: true,
  systemAudio: false,
  playback: vi.fn(async (_enabled: boolean) => {}),
  trickleIce: false,
  focused: true,
  status: "online",
  appState: null as null | ((state: string) => void),
  crashed: null as null | (() => void),
  webViewProps: null as null | Record<string, unknown>,
  retryPermissions: null as null | (() => void),
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const view = (tag: string) => (p: any) => {
    if (p.testID) fixture.views[p.testID] = p;
    return createElement(
      tag,
      {
        onClick: p.onPress,
        disabled: p.disabled,
        "aria-label": p.accessibilityLabel,
        "aria-selected": p.accessibilityState?.selected,
        "data-testid": p.testID,
      },
      p.children,
    );
  };
  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove() {} }),
    },
    Alert: { alert: fixture.alert },
    View: view("div"),
    Modal: (p: any) =>
      p.visible ? createElement("div", {}, p.children) : null,
    Pressable: view("button"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    StatusBar: () => null,
    ActivityIndicator: () => null,
    StyleSheet: {
      create: (s: unknown) => s,
      absoluteFill: {},
      hairlineWidth: 1,
    },
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        fixture.appState = listener;
        return { remove() {} };
      },
    },
    Keyboard: {
      dismiss() {},
      addListener: (name: string, listener: (event: unknown) => void) => {
        fixture.keyboardListeners[name] = listener;
        return { remove() {} };
      },
    },
    Dimensions: { get: (kind: string) => kind === "screen" ? fixture.displaySize ?? fixture.size : fixture.size },
    useWindowDimensions: () => fixture.size,
    Platform: {
      get Version() { return fixture.iosVersion; },
      isPad: false,
      get OS() {
        return fixture.platform;
      },
    },
  };
});
vi.mock("@/components/AppText", () => ({
  Text: (p: any) => createElement("span", {}, p.children),
  TextInput: () => createElement("input"),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useIsFocused: () => fixture.focused,
  useRouter: () => ({}),
  useLocalSearchParams: () => ({
    deviceId: fixture.deviceId,
    deviceName: "My Mac",
  }),
}));
vi.mock("@/utils/backGuard", () => ({ goBackGuarded: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => fixture.safe,
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => null,
}));
vi.mock("../../../modules/cindy-remote-presentation/src", () => ({
  remotePresentation: {
    playback: fixture.playback,
    rotate: vi.fn(async () => {}),
  },
}));
vi.mock("expo-clipboard", () => ({
  getStringAsync: vi.fn(),
  setStringAsync: vi.fn(),
}));
vi.mock("@expo/ui/community/segmented-control", () => ({
  default: (props: any) =>
    createElement(
      "div",
      {},
      props.values.map((value: string, index: number) =>
        createElement(
          "button",
          {
            key: value,
            "aria-label": value,
            "aria-selected": props.selectedIndex === index,
            disabled: props.enabled === false,
            onClick: () =>
              props.onChange({ nativeEvent: { selectedSegmentIndex: index } }),
          },
          value,
        ),
      ),
    ),
}));
vi.mock("@/platform/chrome/NativePullDownMenu", () => ({
  usesNativePullDownMenu: () => fixture.nativeMenus,
  NativePullDownMenu: (p: any) =>
    createElement(
      "div",
      {},
      p.children,
      fixture.nativeMenus &&
        p.actions.map((action: any) =>
          createElement(
            "button",
            {
              key: action.id,
              "data-testid": `native-menu.${action.id}`,
              disabled: action.disabled,
              onClick: () => p.onAction(action.id),
            },
            action.title,
          ),
        ),
    ),
}));
vi.mock("lucide-react-native", () => ({
  createLucideIcon: () => () => null,
  Clipboard: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  Menu: () => null,
  RotateCw: () => null,
  Volume2: () => null,
  VolumeX: () => null,
  PictureInPicture2: () => null,
  Check: () => null,
  ClipboardList: () => null,
  ChevronDown: () => null,
  RotateCcw: () => null,
  ChevronRight: () => null,
  Eye: () => null,
  LogOut: () => null,
  Maximize: () => null,
  MousePointer2: () => null,
  Move: () => null,
  ChevronLeft: () => null,
  PanelsTopLeft: () => null,
  Monitor: () => null,
  Shield: () => null,
  LockKeyhole: () => null,
  ScanFace: () => null,
  Keyboard: () => null,
  SlidersHorizontal: () => null,
  X: () => null,
}));
vi.mock("@/platform/chrome/NativeSwitch", () => ({
  NativeSwitch: (p: any) =>
    createElement("button", {
      "aria-label": p.accessibilityLabel,
      "aria-checked": p.value,
      "data-testid": p.testID,
      disabled: p.disabled,
      onClick: () => p.onValueChange(!p.value),
    }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({
      colors:
        fixture.themeMode === "dark" ? tokens.darkColors : tokens.lightColors,
      mode: fixture.themeMode,
    }),
    useThemedStyles: (make: any) =>
      make(
        fixture.themeMode === "dark" ? tokens.darkColors : tokens.lightColors,
      ),
  };
});
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({
    status: fixture.status,
    invoke: fixture.invoke,
    beginBackgroundTransition: fixture.beginBackgroundTransition,
    openLink: fixture.openLink,
  }),
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ apiFetch: fixture.apiFetch }),
}));
vi.mock("@/config/env", () => ({
  DEVICE_LINK_API_BASE_URL: "https://relay.example.test",
}));
vi.mock("../PermissionGuide", () => ({
  PermissionGuide: (p: any) => {
    fixture.retryPermissions = p.reconnect;
    return createElement("span", {}, "permission guide");
  },
}));
vi.mock("react-native-webview", () => ({
  WebView: forwardRef((p: any, ref) => {
    fixture.webViewProps = p;
    fixture.message = p.onMessage;
    fixture.crashed = p.onContentProcessDidTerminate;
    useImperativeHandle(ref, () => ({
      postMessage: fixture.post,
      requestFocus() {},
      reload: fixture.reload,
    }));
    return createElement("div", { "data-testid": p.testID });
  }),
}));
vi.mock("../NativeRemoteDesktopView", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../NativeRemoteDesktopView")>();
  const Native = forwardRef((props: any, ref) => {
    fixture.nativeMessage = props.onMessage;
    useImperativeHandle(ref, () => ({
      receive: fixture.nativeReceive,
      sendInput: fixture.nativeInput,
    }));
    return createElement("div", {
      "data-native-inline": String(props.inlineVisible),
    });
  });
  return {
    ...actual,
    get NativeRemoteDesktopView() {
      return fixture.nativeMedia ? Native : null;
    },
  };
});

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
const display = { id: "display", width: 1920, height: 1080 };
const requests = () => fixture.invoke.mock.calls.map((call) => call[2][0]);
const sent = () => fixture.post.mock.calls.map(([data]) => JSON.parse(data));
const visibleInputHint = () =>
  host.querySelector('[data-testid="remoteDesktop.inputHintSlot"]')
    ?.lastElementChild?.textContent;
const button = (key: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="remoteDesktop.${key}"]`)!;
beforeEach(async () => {
  await AsyncStorage.removeItem(
    "cindy.mobile.remote-desktop.show-mouse-buttons.v1",
  ).catch(() => undefined);
  await AsyncStorage.removeItem("cindy.mobile.remote-desktop.audio.v1").catch(
    () => undefined,
  );
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  fixture.beginBackgroundTransition.mockImplementation(
    () => fixture.finishBackgroundTransition,
  );
  fixture.nativeMedia = false;
  fixture.iosVersion = 26;
  fixture.pipEnabled = false;
  fixture.nativeReceive.mockReset().mockResolvedValue(undefined);
  fixture.nativeInput.mockReset().mockResolvedValue(true);
  fixture.platform = "ios";
  fixture.safe = { top: 59, bottom: 34, left: 0, right: 0 };
  fixture.hostPlatform = "darwin";
  fixture.deviceId = "computer";
  fixture.securityAutoUnlock = false;
  fixture.securityBusy = false;
  fixture.maybeUnlock.mockReset().mockResolvedValue(undefined);
  fixture.themeMode = "light";
  fixture.lockOnExit = false;
  fixture.lockSupported = true;
  fixture.views = {};
  fixture.keyboardListeners = {};
  fixture.webViewProps = null;
  vi.useFakeTimers();
  fixture.focused = true;
  fixture.status = "online";
  AppState.currentState = "active";
  fixture.canControl = true;
  fixture.trickleIce = false;
  fixture.size = { width: 390, height: 844 };
  fixture.displaySize = null;
  fixture.openLink.mockResolvedValue({});
  fixture.apiFetch
    .mockReset()
    .mockResolvedValue({ iceServers: [], expiresAt: null });
  fixture.systemAudio = false;
  fixture.playback.mockReset().mockResolvedValue(undefined);
  fixture.invoke.mockImplementation(async (_device, _channel, [request]) => {
    switch (request.op) {
      case "capabilities":
        return {
          version: 1,
          lockOnExit: fixture.lockSupported,
          trickleIce: fixture.trickleIce,
          automaticReconnect: true,
          connectionTakeover: true,
          backgroundViewing: true,
          enabled: true,
          canControl: fixture.canControl,
          systemAudio: fixture.systemAudio,
          videoSettings: fixture.systemAudio,
          platform: fixture.hostPlatform,
          displays: [display],
        };
      case "start":
        return {
          lease: "lease",
          controlling: false,
          display: { ...display, id: request.displayId },
        };
      case "control":
        return { controlling: request.enabled };
      default:
        return {};
    }
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  act(() => root.render(<RemoteDesktopScreen />));
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const connect = async () => {
  await act(async () => {
    fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
  });
  act(() => {
    fixture.message!({
      nativeEvent: { data: '{"type":"framePresented","epoch":"lease"}' },
    });
  });
};

describe("remote desktop controls", () => {
  it.each([false, true])(
    "allows the Wayland consent window while keeping the overall wait bounded (native=%s)",
    async (native) => {
      fixture.nativeMedia = native;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[2][0].op === "capabilities")
          return {
            ...result,
            displays: [{ ...display, id: "wayland-portal" }],
          };
        return result;
      });
      await act(async () => {
        fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
      });
      if (native) {
        const init = fixture.nativeReceive.mock.calls
          .map(([message]) => message as Record<string, any>)
          .find((message) => message.type === "init");
        expect(init?.net.retryMs).toEqual([
          ...Array(15).fill(8000),
          1000,
          3000,
          8000,
        ]);
      }
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(host.textContent).not.toContain("remoteDesktop.connectionTimeout");
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(host.textContent).toContain("remoteDesktop.connectionTimeout");
    },
  );

  it("bounds repeated failures without renewing the deadline on each retry", async () => {
    fixture.openLink.mockRejectedValue(new Error("INVOKE_TIMEOUT"));
    await act(async () => {
      fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.textContent).toContain("remoteDesktop.connectionTimeout");
    const attempts = fixture.openLink.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.openLink).toHaveBeenCalledTimes(attempts);
    fixture.openLink.mockResolvedValue({});
    await act(async () => button("connect").click());
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: '{"type":"framePresented","epoch":"lease"}',
        },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.textContent).not.toContain("remoteDesktop.connectionTimeout");
  });

  it("times out while waiting for the first frame and ignores late presentation", async () => {
    await act(async () => {
      fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.textContent).toContain("remoteDesktop.connectionTimeout");
    expect(requests().filter((r) => r.op === "stop")).toEqual([
      { op: "stop", lease: "lease" },
    ]);
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: '{"type":"framePresented","epoch":"lease"}',
        },
      }),
    );
    expect(host.textContent).toContain("remoteDesktop.connectionTimeout");
  });

  it("cancels the deadline after a frame and gives background resume a fresh budget", async () => {
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(150_000));
    expect(host.textContent).not.toContain("remoteDesktop.connectionTimeout");
    await act(async () => {
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await act(async () => vi.advanceTimersByTimeAsync(150_000));
    expect(host.textContent).not.toContain("remoteDesktop.connectionTimeout");
    await act(async () => {
      AppState.currentState = "active";
      fixture.appState!("active");
    });
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(host.textContent).not.toContain("remoteDesktop.connectionTimeout");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain("remoteDesktop.connectionTimeout");
  });

  it("uses advertised Omarchy actions instead of the legacy desktop buttons", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[2][0].op === "capabilities"
        ? {
            ...result,
            platform: "linux",
            workspaceNavigation: true,
            omarchyMenu: true,
          }
        : result;
    });
    await connect();
    for (const action of ["workspaceLeft", "workspaceRight", "omarchyMenu"])
      await act(async () => button(action).click());
    expect(requests().filter((r) => r.op === "windowAction")).toEqual(
      ["workspaceLeft", "workspaceRight", "omarchyMenu"].map((action) => ({
        op: "windowAction",
        action,
        lease: "lease",
      })),
    );
    expect(button("showDesktop")).toBeNull();
    expect(button("allWindows")).toBeNull();
  });

  const nativePresentation = async (
    type: string,
    values: Record<string, unknown> = {},
  ) => {
    await act(async () =>
      fixture.nativeMessage!({
        nativeEvent: {
          data: JSON.stringify({ type, epoch: "lease", ...values }),
        },
      }),
    );
  };
  const retainedViewer = async () => {
    fixture.nativeMedia = true;
    const callbacks = {
      onBack: vi.fn(),
      onRestore: vi.fn(),
      onVisibility: vi.fn(),
      onEnded: vi.fn(),
    };
    const render = (focused: boolean) =>
      act(() =>
        root.render(
          <RemoteDesktopSession
            deviceId="computer"
            deviceName="My Mac"
            focused={focused}
            {...callbacks}
          />,
        ),
      );
    render(true);
    await connect();
    await nativePresentation("pipCapability", { supported: true });
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await nativePresentation("presentation", { active: true });
    await act(async () => {
      AppState.currentState = "active";
      fixture.appState!("active");
    });
    return { ...callbacks, render };
  };
  it.each(["unsupported", "no-frame", "control-busy", "settings-busy"])(
    "ends a detached native lease when PiP admission is refused: %s",
    async (reason) => {
      fixture.nativeMedia = true;
      fixture.pipEnabled = true;
      fixture.systemAudio = true;
      fixture.lockOnExit = true;
      const invoke = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const result = await invoke(...args);
        return args[2][0].op === "capabilities" && reason === "unsupported"
          ? { ...result, backgroundViewing: false }
          : result;
      });
      const onEnded = vi.fn();
      const render = (focused: boolean) =>
        root.render(
          <RemoteDesktopSession
            deviceId="computer"
            deviceName="My Mac"
            focused={focused}
            onEnded={onEnded}
            onBack={() => {}}
          />,
        );
      await act(async () => render(true));
      if (reason === "no-frame") {
        await act(async () =>
          fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } }),
        );
      } else await connect();
      let finish: (() => void) | undefined;
      if (reason === "control-busy") {
        const original = fixture.invoke.getMockImplementation()!;
        fixture.invoke.mockImplementation((...args) => {
          const op = args[2][0].op;
          if (op === "control") {
            return new Promise((resolve) => {
              finish = () => resolve({ controlling: false });
            });
          }
          return original(...args);
        });
      } else if (reason === "settings-busy") {
        fixture.playback.mockImplementation((enabled) =>
          enabled
            ? new Promise((resolve) => {
                finish = () => resolve();
              })
            : Promise.resolve(),
        );
      }
      if (reason === "control-busy" || reason === "settings-busy") {
        act(() => button("operations").click());
        await act(async () =>
          button(reason === "control-busy" ? "viewOnly" : "sound").click(),
        );
        expect(finish).toBeDefined();
      }
      await act(async () => render(false));
      expect(onEnded).toHaveBeenCalledOnce();
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
      expect(requests().find((r) => r.op === "stop")).toMatchObject({
        lockScreen: true,
      });
      expect(
        requests().filter((r) => r.op === "presentation" && r.enabled),
      ).toHaveLength(0);
      fixture.invoke.mockClear();
      await act(async () => {
        finish?.();
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(
        requests().filter((r) =>
          ["heartbeat", "start", "presentation"].includes(r.op),
        ),
      ).toHaveLength(0);
      expect(fixture.pipEnabled).toBe(true);
    },
  );
  it("arms automatic native PiP in foreground without releasing control", async () => {
    fixture.nativeMedia = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    await nativePresentation("pipCapability", { supported: true });
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    expect(sent()).toContainEqual(
      expect.objectContaining({ type: "pipPolicy", enabled: true }),
    );
    expect(requests().filter((r) => r.op === "presentation")).toHaveLength(0);
    expect(
      requests()
        .filter((r) => r.op === "control")
        .at(-1),
    ).toMatchObject({ enabled: true });
  });

  it("does not confuse a fast native Home handoff with a cancelled gesture", async () => {
    fixture.nativeMedia = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    await nativePresentation("pipCapability", { supported: true });
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    const controls = requests().filter((r) => r.op === "control").length;
    await nativePresentation("presentationStarting");
    expect(
      sent()
        .filter((m) => m.type === "pipPolicy" && "authorized" in m)
        .at(-1),
    ).toMatchObject({ authorized: true });
    expect(requests().filter((r) => r.op === "control")).toHaveLength(controls);
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await nativePresentation("presentation", { active: true });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(
      requests().filter((r) => r.op === "presentation" && r.enabled),
    ).toHaveLength(1);
  });

  it.each(["grant", "timeout", "reject", "close"])(
    "keeps authorization bounded when native PiP starts before the host reply: %s",
    async (outcome) => {
      fixture.nativeMedia = true;
      act(() => root.render(<RemoteDesktopScreen />));
      await connect();
      await nativePresentation("pipCapability", { supported: true });
      act(() => button("operations").click());
      await act(async () => button("smallWindow").click());
      let grant!: (value: unknown) => void;
      let reject!: (cause: Error) => void;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation((...args) =>
        args[2][0].op === "presentation" && args[2][0].enabled
          ? new Promise((resolve, fail) => {
              grant = resolve;
              reject = fail;
            })
          : original(...args),
      );
      // willStart may precede JS inactive; a second event must not duplicate auth.
      await nativePresentation("presentationStarting");
      expect(fixture.beginBackgroundTransition).toHaveBeenCalledTimes(1);
      expect(fixture.finishBackgroundTransition).not.toHaveBeenCalled();
      await act(async () => {
        AppState.currentState = "inactive";
        fixture.appState!("inactive");
      });
      await nativePresentation("presentation", { active: true });
      await act(async () => {
        AppState.currentState = "background";
        fixture.appState!("background");
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(
        requests().filter((r) => r.op === "presentation" && r.enabled),
      ).toHaveLength(1);
      expect(
        sent().filter((m) => m.type === "pipPolicy" && m.authorized),
      ).toHaveLength(0);
      if (outcome === "grant") {
        await act(async () => grant({}));
        expect(sent()).toContainEqual(
          expect.objectContaining({ type: "pipPolicy", authorized: true }),
        );
        expect(
          sent().filter((m) => m.type === "presentation" && m.enabled),
        ).toHaveLength(0);
        await act(async () => vi.advanceTimersByTimeAsync(5000));
        expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
      } else {
        if (outcome === "timeout")
          await act(async () => vi.advanceTimersByTimeAsync(4000));
        if (outcome === "reject")
          await act(async () => reject(new Error("denied")));
        if (outcome === "close")
          await nativePresentation("presentation", { active: false });
        expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
        await act(async () => grant({}));
        expect(
          sent().filter((m) => m.type === "pipPolicy" && m.authorized),
        ).toHaveLength(0);
      }
      expect(fixture.finishBackgroundTransition).toHaveBeenCalled();
    },
  );

  it("reveals media and toolbar only after the first presented frame", async () => {
    expect(fixture.views["remoteDesktop.media"].pointerEvents).toBe("none");
    expect(
      fixture.views["remoteDesktop.toolbarPosition"]
        .accessibilityElementsHidden,
    ).toBe(true);
    expect(host.textContent).toContain("My Mac");
    expect(fixture.views["remoteDesktop.connectingStatus"].style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: "transparent" }),
      ]),
    );
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(host.textContent).toContain("remoteDesktop.connectionTakingLong");
    await connect();
    expect(fixture.views["remoteDesktop.media"].pointerEvents).toBe("auto");
    expect(
      fixture.views["remoteDesktop.toolbarPosition"]
        .accessibilityElementsHidden,
    ).toBe(false);
    expect(host.textContent).not.toContain(
      "remoteDesktop.connectionTakingLong",
    );
  });

  it("changes only the background preference while controlling and during sound renegotiation", async () => {
    fixture.nativeMedia = true;
    fixture.systemAudio = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    await nativePresentation("pipCapability", { supported: true });
    act(() => button("operations").click());
    const controls = requests().filter((r) => r.op === "control").length;
    await act(async () => button("smallWindow").click());
    expect(fixture.pipEnabled).toBe(true);
    expect(requests().filter((r) => r.op === "presentation")).toHaveLength(0);
    expect(requests().filter((r) => r.op === "control")).toHaveLength(controls);
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
    await act(async () => button("sound").click());
    await nativePresentation("pipCapability", { supported: false });
    await act(async () => button("smallWindow").click());
    expect(fixture.pipEnabled).toBe(false);
    expect(button("smallWindow").disabled).toBe(false);
    await act(async () => button("smallWindow").click());
    expect(fixture.pipEnabled).toBe(true);
    expect(
      requests().filter((r) => r.op === "presentation" && r.enabled),
    ).toHaveLength(0);
    expect(requests().filter((r) => r.op === "control")).toHaveLength(controls);
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
  });
  it("keeps native PiP available after muting, restoring fullscreen and disabling PiP", async () => {
    fixture.nativeMedia = true;
    fixture.systemAudio = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    await nativePresentation("pipCapability", { supported: true });
    act(() => button("operations").click());
    fixture.playback.mockClear();
    await act(async () => button("sound").click());
    expect(fixture.playback).toHaveBeenLastCalledWith(true);
    expect(
      sent()
        .filter((m) => m.type === "videoSettings")
        .at(-1),
    ).toMatchObject({ audio: false });
    // Native readiness is reported again after the muted stream reconnects.
    await nativePresentation("streaming");
    await nativePresentation("pipCapability", { supported: true });
    expect(button("smallWindow").disabled).toBe(false);
    await act(async () => button("smallWindow").click());
    await act(async () => button("back").click());
    await nativePresentation("presentation", { active: true });
    await nativePresentation("presentation", { active: false });
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    await nativePresentation("presentation", { active: false });
    await nativePresentation("presentationFailed");
    expect(fixture.playback).not.toHaveBeenCalledWith(false);
    expect(fixture.pipEnabled).toBe(false);
    expect(button("smallWindow").disabled).toBe(false);
    act(() => root.unmount());
    mounted = false;
    expect(fixture.playback).toHaveBeenLastCalledWith(false);
  });
  it("prepares native video playback even when the host has no audio", async () => {
    fixture.nativeMedia = true;
    fixture.systemAudio = false;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    expect(fixture.playback).toHaveBeenCalledWith(true);
    expect(sent().find((m) => m.type === "init")).toMatchObject({
      audio: false,
    });
  });
  it.each([true, false])(
    "restores browser PiP's prior control choice (%s) without clearing the preference",
    async (controlling) => {
      await connect();
      const web = async (
        type: string,
        values: Record<string, unknown> = {},
      ) => {
        await act(async () =>
          fixture.message!({
            nativeEvent: {
              data: JSON.stringify({ type, epoch: "lease", ...values }),
            },
          }),
        );
      };
      await web("pipCapability", { supported: true });
      act(() => button("operations").click());
      if (!controlling) await act(async () => button("viewOnly").click());
      await act(async () => button("smallWindow").click());
      await web("presentation", { active: true });
      fixture.invoke.mockClear();
      await web("presentation", { active: false });
      await web("presentation", { active: false });
      expect(fixture.pipEnabled).toBe(true);
      if (controlling) {
        expect(
          requests().filter((r) => r.op === "control" && r.enabled),
        ).toHaveLength(1);
      } else {
        expect(
          requests().filter((r) => r.op === "control" && r.enabled),
        ).toHaveLength(0);
        expect(
          requests().filter((r) => r.op === "presentation" && !r.enabled),
        ).toHaveLength(1);
      }
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    },
  );
  it("keeps the background option and restores control after returning fullscreen", async () => {
    const viewer = await retainedViewer();
    const controls = requests().filter(
      (r) => r.op === "control" && r.enabled,
    ).length;
    await nativePresentation("presentationRestore");
    await nativePresentation("presentation", { active: false });
    expect(fixture.pipEnabled).toBe(true);
    expect(sent()).toContainEqual(
      expect.objectContaining({ type: "restorePresentation" }),
    );
    expect(
      requests().filter((r) => r.op === "presentation" && !r.enabled),
    ).toHaveLength(0);
    expect(viewer.onEnded).not.toHaveBeenCalled();
    expect(
      requests().filter((r) => r.op === "control" && r.enabled),
    ).toHaveLength(controls + 1);
    act(() => button("operations").click());
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
  });
  it("does not select view-only or label the viewer as view-only during actual PiP", async () => {
    await retainedViewer();
    expect(host.textContent).not.toContain("remoteDesktop.viewOnly");
    act(() => button("operations").click());
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
    expect(visibleInputHint()).toBe("remoteDesktop.controlUnavailableHint");
    await act(async () => button("viewOnly").click());
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("true");
    await nativePresentation("presentation", { active: false });
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("true");
    expect(visibleInputHint()).toBe("remoteDesktop.viewOnlyHint");
  });
  it("waits for actual PiP before navigating back and keeps the connection mounted", async () => {
    const viewer = await retainedViewer();
    await nativePresentation("presentation", { active: false });
    await act(async () => button("back").click());
    expect(viewer.onBack).not.toHaveBeenCalled();
    await nativePresentation("presentation", { active: true });
    expect(viewer.onBack).toHaveBeenCalledOnce();
    viewer.render(false);
    expect(host.querySelector('[data-native-inline="false"]')).not.toBeNull();
    expect(viewer.onVisibility).toHaveBeenLastCalledWith(false);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    await nativePresentation("presentationRestore");
    expect(viewer.onRestore).toHaveBeenCalledOnce();
    viewer.render(true);
    expect(host.querySelector('[data-native-inline="true"]')).not.toBeNull();
  });
  it("finishes delayed Back using the callback from its original route", async () => {
    const viewer = await retainedViewer();
    await nativePresentation("presentation", { active: false });
    await act(async () => button("back").click());
    const laterBack = vi.fn();
    act(() =>
      root.render(
        <RemoteDesktopSession
          deviceId="computer"
          deviceName="My Mac"
          focused={true}
          onBack={laterBack}
          onRestore={viewer.onRestore}
          onVisibility={viewer.onVisibility}
          onEnded={viewer.onEnded}
        />,
      ),
    );
    await nativePresentation("presentation", { active: true });
    expect(viewer.onBack).toHaveBeenCalledOnce();
    expect(laterBack).not.toHaveBeenCalled();
  });
  it("starts PiP on route blur before hiding and restores the route on system fullscreen", async () => {
    const viewer = await retainedViewer();
    await nativePresentation("presentation", { active: false });
    viewer.onVisibility.mockClear();
    await act(async () => viewer.render(false));
    expect(viewer.onVisibility).not.toHaveBeenCalledWith(false);
    await nativePresentation("presentation", { active: true });
    expect(viewer.onVisibility).toHaveBeenLastCalledWith(false);
    await nativePresentation("presentationRestore");
    expect(viewer.onRestore).toHaveBeenCalledOnce();
    expect(viewer.onVisibility).toHaveBeenLastCalledWith(true);
    viewer.render(true);
    await nativePresentation("presentation", { active: false });
    expect(fixture.pipEnabled).toBe(true);
    expect(viewer.onEnded).not.toHaveBeenCalled();
  });
  it("does not let a control toggle strand an in-flight PiP handoff", async () => {
    await retainedViewer();
    await nativePresentation("presentation", { active: false });
    act(() => button("operations").click());
    let finish!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "presentation"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    const before = requests().filter((r) => r.op === "control").length;
    await act(async () => button("back").click());
    await act(async () => button("viewOnly").click());
    expect(requests().filter((r) => r.op === "control")).toHaveLength(before);
    await act(async () => finish({}));
    await nativePresentation("presentation", { active: true });
    await nativePresentation("presentation", { active: false });
    expect(
      requests()
        .filter((r) => r.op === "control")
        .at(-1),
    ).toMatchObject({ enabled: true });
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    expect(requests().filter((r) => r.op === "control")).toHaveLength(
      before + 2,
    );
  });
  it.each([true, false])(
    "restores the prior control choice (%s) when a Home gesture is cancelled during preparation",
    async (controlling) => {
      fixture.nativeMedia = true;
      act(() => root.render(<RemoteDesktopScreen />));
      await connect();
      await nativePresentation("pipCapability", { supported: true });
      act(() => button("operations").click());
      if (!controlling) await act(async () => button("viewOnly").click());
      await act(async () => button("smallWindow").click());
      const before = requests().filter((r) => r.op === "control").length;
      let finish!: (value: unknown) => void;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation((...args) =>
        args[2][0].op === "presentation" && args[2][0].enabled
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(...args),
      );
      await act(async () => {
        AppState.currentState = "inactive";
        fixture.appState!("inactive");
      });
      await act(async () => {
        AppState.currentState = "active";
        fixture.appState!("active");
      });
      await act(async () => finish({}));
      expect(fixture.pipEnabled).toBe(true);
      expect(button("viewOnly").getAttribute("aria-selected")).toBe(
        String(!controlling),
      );
      expect(requests().filter((r) => r.op === "control")).toHaveLength(
        before + Number(controlling),
      );
      expect(
        sent().filter((m) => m.type === "presentation" && m.enabled),
      ).toHaveLength(0);
    },
  );
  it.each(["grant", "timeout"])(
    "keeps a cancelled foreground PiP start bounded until authorization: %s",
    async (outcome) => {
      fixture.nativeMedia = true;
      act(() => root.render(<RemoteDesktopScreen />));
      await connect();
      await nativePresentation("pipCapability", { supported: true });
      act(() => button("operations").click());
      await act(async () => button("smallWindow").click());
      let finish!: (value: unknown) => void;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation((...args) =>
        args[2][0].op === "presentation" && args[2][0].enabled
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(...args),
      );
      await nativePresentation("presentationStarting");
      await act(async () => {
        AppState.currentState = "inactive";
        fixture.appState!("inactive");
      });
      await nativePresentation("presentation", { active: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        AppState.currentState = "active";
        fixture.appState!("active");
      });
      await nativePresentation("presentation", { active: false });
      await nativePresentation("presentation", { active: false });
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
      if (outcome === "grant") await act(async () => finish({}));
      await act(async () => vi.advanceTimersByTimeAsync(1100));
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(
        outcome === "grant" ? 0 : 1,
      );
      expect(fixture.pipEnabled).toBe(true);
      if (outcome === "grant") {
        expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
      } else await act(async () => finish({}));
    },
  );
  it("ends a detached connection when PiP closes without clearing the option", async () => {
    const viewer = await retainedViewer();
    viewer.render(false);
    await nativePresentation("presentation", { active: false });
    expect(viewer.onEnded).toHaveBeenCalledOnce();
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    expect(fixture.pipEnabled).toBe(true);
  });
  it.each(["smallWindow", "sound"])(
    "restores control when %s stops an active PiP window",
    async (action) => {
      fixture.systemAudio = true;
      await retainedViewer();
      const controls = requests().filter(
        (r) => r.op === "control" && r.enabled,
      ).length;
      act(() => button("operations").click());
      await act(async () => button(action).click());
      await nativePresentation("presentation", { active: false });
      expect(
        requests().filter((r) => r.op === "control" && r.enabled),
      ).toHaveLength(controls + 1);
      expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
    },
  );
  it.each(["grant", "timeout"])(
    "orders rapid Home entry after pending fullscreen restoration: %s",
    async (outcome) => {
      await retainedViewer();
      let finish!: (value: unknown) => void;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation((...args) =>
        args[2][0].op === "control" && args[2][0].enabled
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(...args),
      );
      await nativePresentation("presentation", { active: false });
      const grants = () =>
        requests().filter((r) => r.op === "presentation" && r.enabled).length;
      const before = grants();
      await act(async () => {
        AppState.currentState = "inactive";
        fixture.appState!("inactive");
        AppState.currentState = "background";
        fixture.appState!("background");
      });
      await nativePresentation("presentation", { active: true });
      expect(grants()).toBe(before);
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
      if (outcome === "timeout")
        await act(async () => vi.advanceTimersByTimeAsync(4100));
      await act(async () => finish({ controlling: true }));
      expect(grants()).toBe(before + (outcome === "grant" ? 1 : 0));
      await act(async () => vi.advanceTimersByTimeAsync(4100));
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(
        outcome === "grant" ? 0 : 1,
      );
    },
  );
  it("preserves authorized native media while fullscreen signaling reconnects", async () => {
    const viewer = await retainedViewer();
    const controls = requests().filter((r) => r.op === "control").length;
    const authorizations = requests().filter(
      (r) => r.op === "presentation" && r.enabled,
    ).length;
    fixture.status = "offline";
    viewer.render(true);
    await nativePresentation("presentation", { active: false });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(requests().filter((r) => r.op === "control")).toHaveLength(controls);
    // Another immediate Home entry uses the still-acknowledged host permission.
    const beforeReentry = sent().length;
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await nativePresentation("presentation", { active: true });
    expect(sent().slice(beforeReentry)).toContainEqual(
      expect.objectContaining({ type: "pipPolicy", authorized: true }),
    );
    expect(
      requests().filter((r) => r.op === "presentation" && r.enabled),
    ).toHaveLength(authorizations);
    await act(async () => {
      AppState.currentState = "active";
      fixture.appState!("active");
    });
    await nativePresentation("presentation", { active: false });
    fixture.status = "online";
    await act(async () => viewer.render(true));
    expect(requests().filter((r) => r.op === "control")).toHaveLength(
      controls + 1,
    );
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    act(() => button("operations").click());
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
  });

  it("revokes cached presentation permission when disabled during signaling recovery", async () => {
    const viewer = await retainedViewer();
    fixture.status = "offline";
    viewer.render(true);
    await nativePresentation("presentation", { active: false });
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    const beforeBackground = sent().length;
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    expect(
      sent()
        .slice(beforeBackground)
        .some((m) => m.type === "pipPolicy" && m.authorized),
    ).toBe(false);
  });

  it("does not restore control from a preparation reply after disconnect", async () => {
    await retainedViewer();
    await nativePresentation("presentation", { active: false });
    act(() => button("operations").click());
    let finish!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "presentation" && args[2][0].enabled
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
    });
    await act(async () => button("disconnect").click());
    const controls = requests().filter((r) => r.op === "control").length;
    await act(async () => finish({}));
    expect(requests().filter((r) => r.op === "control")).toHaveLength(controls);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
  });
  it("explicit disconnect still ends an enabled PiP connection", async () => {
    const viewer = await retainedViewer();
    act(() => button("operations").click());
    await act(async () => button("disconnect").click());
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    expect(viewer.onBack).toHaveBeenCalledOnce();
    expect(fixture.pipEnabled).toBe(true);
  });
  it("keeps a bounded Home transition while waiting for view-only authorization", async () => {
    await retainedViewer();
    await nativePresentation("presentation", { active: false });
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    let finish!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "presentation"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    await act(async () => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(sent()).toContainEqual(
      expect.objectContaining({ type: "pipPolicy", preparing: true }),
    );
    await act(async () => finish({}));
    await nativePresentation("presentation", { active: true });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
  });
  it("routes native negotiation and stops the exact old native lease on pause", async () => {
    fixture.nativeMedia = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    expect(fixture.nativeReceive).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "init",
        epoch: "lease",
        net: expect.objectContaining({
          iceConfigMs: 8_000,
          iceConfigBridgeMs: 500,
        }),
      }),
    );
    await act(async () =>
      fixture.nativeMessage!({
        nativeEvent: {
          data: JSON.stringify({
            type: "iceConfig",
            epoch: "lease",
            attemptId: "native-1",
          }),
        },
      }),
    );
    expect(fixture.nativeReceive).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "iceConfig",
        epoch: "lease",
        attemptId: "native-1",
        iceServers: expect.any(Array),
      }),
    );
    expect(fixture.apiFetch).toHaveBeenCalledWith(
      "/api/device-link/ice-servers",
      expect.objectContaining({ timeoutMs: 8_000 }),
    );
    act(() => {
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    expect(fixture.nativeReceive).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop", epoch: "lease" }),
    );
  });

  it("uses native input transport with RPC fallback and rejects stale native streaming", async () => {
    fixture.nativeMedia = true;
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    await act(async () =>
      fixture.nativeMessage!({
        nativeEvent: {
          data: JSON.stringify({
            type: "iceConfig",
            epoch: "lease",
            attemptId: "native-2",
          }),
        },
      }),
    );
    act(() =>
      fixture.nativeMessage!({
        nativeEvent: {
          data: JSON.stringify({
            type: "streaming",
            epoch: "lease",
            attemptId: "native-1",
          }),
        },
      }),
    );
    expect(sent().some((m) => m.type === "nativeVideo" && m.active)).toBe(
      false,
    );
    act(() =>
      fixture.nativeMessage!({
        nativeEvent: {
          data: JSON.stringify({
            type: "streaming",
            epoch: "lease",
            attemptId: "native-2",
          }),
        },
      }),
    );
    expect(sent()).toContainEqual({
      type: "nativeVideo",
      epoch: "lease",
      active: true,
    });
    const input = {
      type: "input",
      epoch: "lease",
      sequence: 1,
      events: [{ kind: "move", x: 0.5, y: 0.5 }],
    };
    await act(async () =>
      fixture.message!({ nativeEvent: { data: JSON.stringify(input) } }),
    );
    expect(fixture.nativeInput).toHaveBeenCalledWith(input);
    expect(requests().filter((r) => r.op === "input")).toHaveLength(0);
    fixture.nativeInput.mockResolvedValue(false);
    await act(async () =>
      fixture.message!({
        nativeEvent: { data: JSON.stringify({ ...input, sequence: 2 }) },
      }),
    );
    expect(requests()).toContainEqual({
      op: "input",
      lease: "lease",
      sequence: 2,
      events: input.events,
    });
  });
  it("retries an initial capabilities timeout normally on a legacy host", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    let attempts = 0;
    fixture.invoke.mockImplementation(async (...args) => {
      if (args[2][0].op === "capabilities") {
        attempts++;
        if (attempts === 1)
          throw Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" });
        return { ...(await original(...args)), automaticReconnect: undefined };
      }
      return original(...args);
    });
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(host.textContent).not.toContain("remoteDesktop.upgrade");
    expect(requests().filter((request) => request.op === "start")).toEqual([
      { op: "start", displayId: "display" },
    ]);
  });
  it("keeps the video when a fallback input is rejected because control was released", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "input"
        ? Promise.reject(new Error("DESKTOP_VIEW_ONLY"))
        : original(...args),
    );
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "input",
            epoch: "lease",
            sequence: 1,
            events: [{ kind: "move", x: 0.5, y: 0.5 }],
          }),
        },
      });
    });
    expect(sent()).toContainEqual({ type: "control", enabled: false });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it("reports unavailable host input without selecting view-only or replacing the video lease", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "heartbeat"
        ? Promise.resolve({ controlling: false })
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(3100));
    expect(
      fixture.post.mock.calls.map(([json]) => JSON.parse(json)),
    ).toContainEqual({ type: "control", enabled: false });
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    act(() => button("operations").click());
    expect(visibleInputHint()).toBe("remoteDesktop.controlUnavailableHint");
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
  });
  it("keeps iOS data detection disabled without passing its prop to Android", async () => {
    await act(async () => {});
    expect(fixture.webViewProps).toMatchObject({ dataDetectorTypes: "none" });

    fixture.platform = "android";
    await act(async () => root.render(<RemoteDesktopScreen />));

    expect(fixture.webViewProps).not.toHaveProperty("dataDetectorTypes");
  });

  it("fetches ICE configuration only through native auth and sends sanitized short-term credentials", async () => {
    await connect();
    const iceServers = [
      {
        urls: ["turn:relay.example.test:3478"],
        username: "temporary",
        credential: "test-only",
      },
    ];
    fixture.apiFetch.mockResolvedValue({
      iceServers,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      secret: "must-not-cross-bridge",
    });
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "iceConfig",
            epoch: "lease",
            attemptId: "1",
            url: "https://untrusted.example.test",
          }),
        },
      });
    });
    expect(fixture.apiFetch).toHaveBeenCalledWith(
      "/api/device-link/ice-servers",
      {
        baseUrl: "https://relay.example.test",
        timeoutMs: 8000,
        cache: "no-store",
      },
    );
    expect(sent().find((m) => m.type === "iceConfig")).toEqual({
      type: "iceConfig",
      epoch: "lease",
      attemptId: "1",
      iceServers,
    });
    expect(JSON.stringify(sent())).not.toContain("must-not-cross-bridge");
  });

  it("drops a late ICE config response after the screen exits", async () => {
    await connect();
    let finish!: (value: unknown) => void;
    fixture.apiFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "iceConfig",
            epoch: "lease",
            attemptId: "1",
          }),
        },
      });
    });
    act(() => root.unmount());
    mounted = false;
    await act(async () => finish({ iceServers: [], expiresAt: null }));
    expect(sent().filter((m) => m.type === "iceConfig")).toHaveLength(0);
  });

  it("keeps native pickers interactive while settings are applying", () => {
    const onChange = vi.fn();
    const renderSettings = (busy: boolean) => {
      act(() =>
        root.render(
          <RemoteDesktopDisplaySettings
            connected
            controlling
            displayControl={null}
            video={{
              supported: true,
              busy,
              modesSupported: false,
              settings: { fps: 30, bitrate: 0, audio: false },
              onChange,
              readModes: async () => [],
              onResolution: async () => {},
            }}
          />,
        ),
      );
    };
    renderSettings(true);
    expect(fixture.views["remoteDesktop.frameRateControl"].pointerEvents).toBe(
      "auto",
    );
    expect(
      fixture.views["remoteDesktop.qualityControl"].accessibilityState,
    ).toEqual({ disabled: false });
    const pickerButton = host.querySelector("button")!;
    expect(pickerButton.disabled).toBe(false);
    act(() => pickerButton.click());
    expect(onChange).toHaveBeenCalledOnce();
    renderSettings(false);
    expect(fixture.views["remoteDesktop.frameRateControl"].pointerEvents).toBe(
      "auto",
    );
    act(() => host.querySelector("button")!.click());
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("offers viewer sizing only with host support and active control", () => {
    const onFitDisplay = vi.fn();
    const renderSettings = (
      supported: boolean,
      controlling: boolean,
      busy = false,
    ) => {
      act(() =>
        root.render(
          <RemoteDesktopDisplaySettings
            connected
            controlling={controlling}
            displayControl={null}
            video={{
              supported: true,
              busy,
              modesSupported: false,
              viewerDisplaySupported: supported,
              onFitDisplay,
              settings: { fps: 30, bitrate: 0, audio: false },
              onChange: vi.fn(),
              readModes: async () => [],
              onResolution: async () => {},
            }}
          />,
        ),
      );
    };
    const button = () =>
      host.querySelector<HTMLButtonElement>(
        '[aria-label="remoteDesktop.fitViewerDisplay"]',
      );
    renderSettings(false, true);
    expect(button()).toBeNull();
    renderSettings(true, false);
    expect(button()?.disabled).toBe(true);
    renderSettings(true, true, true);
    expect(button()?.disabled).toBe(true);
    renderSettings(true, true);
    act(() => button()?.click());
    expect(onFitDisplay).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "changes 4K system resolution without reconnecting (rotated monitor: %s)",
    async (rotated) => {
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const request = args[2][0];
        if (request.op === "start" && rotated)
          return {
            ...(await original(...args)),
            display: {
              ...display,
              width: display.height,
              height: display.width,
            },
          };
        if (request.op === "capabilities")
          return {
            ...(await original(...args)),
            viewerDisplay: true,
            viewerDisplayRestore: true,
            resolutionRestore: true,
            videoSettings: true,
            displayModes: true,
          };
        if (request.op === "displayModes")
          return [
            { id: "current", width: 1920, height: 1080, current: true },
            { id: "4k", width: 3840, height: 2160, current: false },
            { id: "4:3", width: 1024, height: 768, current: false },
          ];
        if (request.op === "resolution")
          return {
            lease: "lease",
            display: { id: "display", width: 3840, height: 2160 },
            controlling: false,
          };
        return original(...args);
      });
      await connect();
      act(() => button("operations").click());
      await act(async () => button("displaySettings").click());
      act(() => button("resolution").click());
      const mode = Array.from(
        host.querySelectorAll<HTMLButtonElement>("button"),
      ).find((item) => item.textContent === "3840 × 2160")!;
      expect(mode).toBeDefined();
      expect(host.textContent).toContain("1920 × 1080");
      expect(host.textContent).not.toContain("1024 × 768");
      await act(async () => mode.click());
      expect(requests()).toContainEqual({
        op: "resolution",
        lease: "lease",
        modeId: "4k",
        temporary: true,
      });
      expect(requests().some((request) => request.op === "viewerDisplay")).toBe(
        false,
      );
      expect(requests().some((request) => request.op === "stop")).toBe(false);
      expect(sent()).toContainEqual(
        expect.objectContaining({
          type: "videoSettings",
          width: 3840,
          restore: true,
        }),
      );
    },
  );

  it.each([
    [false, 390, 760, 658, 1280],
    [true, 760, 390, 1280, 658],
  ])(
    "keeps fitted resolution choices until explicit restore (native menu: %s)",
    async (nativeMenus, width, height, modeWidth, modeHeight) => {
      fixture.nativeMenus = nativeMenus;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const request = args[2][0];
        if (request.op === "capabilities")
          return {
            ...(await original(...args)),
            viewerDisplay: true,
            viewerDisplayRestore: true,
            resolutionRestore: true,
            videoSettings: true,
            displayModes: true,
          };
        if (request.op === "displayModes")
          return [
            { id: "4k", width: 3840, height: 2160, current: false },
            { id: "4:3", width: 1024, height: 768, current: false },
          ];
        if (request.op === "restoreViewerDisplay")
          return { lease: "lease", controlling: false, display };
        if (request.op === "viewerDisplay")
          return {
            lease: "lease",
            controlling: false,
            display: {
              ...display,
              id: "virtual",
              width: request.width,
              height: request.height,
            },
          };
        return original(...args);
      });
      await connect();
      act(() => button("operations").click());
      act(() => button("displaySettings").click());
      await act(async () =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "viewportSize",
              epoch: "lease",
              width,
              height,
            }),
          },
        }),
      );
      act(() => button("resolution").click());
      const mode = Array.from(
        host.querySelectorAll<HTMLButtonElement>("button"),
      ).find((item) => item.textContent === `${modeWidth} × ${modeHeight}`)!;
      expect(mode).toBeDefined();
      expect(host.textContent).not.toContain("3840 × 2160");
      await act(async () => mode.click());
      expect(
        requests()
          .filter((request) => request.op === "viewerDisplay")
          .at(-1),
      ).toEqual({
        op: "viewerDisplay",
        lease: "lease",
        width: modeWidth,
        height: modeHeight,
      });
      expect(
        requests().filter(
          (request) =>
            request.op === "resolution" ||
            request.op === "restoreViewerDisplay" ||
            request.op === "stop",
        ),
      ).toHaveLength(0);
      expect(
        requests().filter((request) => request.op === "start"),
      ).toHaveLength(1);
      expect(host.textContent).not.toContain(
        "remoteDesktop.resolutionControlHint",
      );
      expect(button("restoreViewerDisplay").disabled).toBe(false);
      act(() => button("resolution").click());
      expect(host.textContent).not.toContain("3840 × 2160");
      expect(host.textContent).toContain(`${modeWidth} × ${modeHeight}`);
      act(() => button("restoreViewerDisplay").click());
      await act(async () =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "viewportSize",
              epoch: "lease",
              width,
              height,
            }),
          },
        }),
      );
      expect(
        requests().filter((request) => request.op === "restoreViewerDisplay"),
      ).toHaveLength(1);
      expect(button("fitViewerDisplay").disabled).toBe(false);
      expect(host.textContent).toContain("3840 × 2160");
      expect(host.textContent).not.toContain("1024 × 768");
      expect(host.textContent).not.toContain(`${modeWidth} × ${modeHeight}`);
      await act(async () => root.unmount());
      mounted = false;
      expect(
        requests().filter((request) => request.op === "stop"),
      ).toHaveLength(1);
    },
  );
  it.each([true, false])(
    "keeps matching after rotation and supports restore when advertised: %s",
    async (canRestore) => {
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const request = args[2][0];
        if (request.op === "capabilities")
          return {
            ...(await original(...args)),
            viewerDisplay: true,
            viewerDisplayRestore: canRestore,
            videoSettings: true,
            displayModes: true,
          };
        if (request.op === "viewerDisplay")
          return {
            lease: "lease",
            controlling: false,
            display: {
              ...display,
              id: "virtual",
              width: request.width,
              height: request.height,
            },
          };
        if (request.op === "restoreViewerDisplay")
          return { lease: "lease", controlling: false, display };
        if (request.op === "displayModes") return [];
        return original(...args);
      });
      await connect();
      act(() => button("operations").click());
      act(() => button("displaySettings").click());
      for (const [width, height] of [
        [390, 760],
        [760, 390],
      ]) {
        await act(async () =>
          fixture.message!({
            nativeEvent: {
              data: JSON.stringify({
                type: "viewportChanged",
                epoch: "lease",
                width,
                height,
              }),
            },
          }),
        );
        expect(button("fitViewerDisplay").disabled).toBe(false);
        act(() => button("fitViewerDisplay").click());
        expect(sent()).toContainEqual({ type: "measureViewport" });
        await act(async () => {
          fixture.message!({
            nativeEvent: {
              data: JSON.stringify({
                type: "viewportSize",
                epoch: "lease",
                width,
                height,
              }),
            },
          });
        });
        expect(
          button(canRestore ? "restoreViewerDisplay" : "fitViewerDisplay")
            .disabled,
        ).toBe(false);
        expect(host.textContent).not.toContain(
          "remoteDesktop.resolutionControlHint",
        );
      }
      const matches = requests().filter(
        (request) => request.op === "viewerDisplay",
      );
      expect(matches).toHaveLength(2);
      expect(matches[0].height).toBeGreaterThan(matches[0].width);
      expect(matches[1].width).toBeGreaterThan(matches[1].height);
      if (canRestore) {
        act(() => button("restoreViewerDisplay").click());
        await act(async () =>
          fixture.message!({
            nativeEvent: {
              data: JSON.stringify({
                type: "viewportSize",
                epoch: "lease",
                width: 760,
                height: 390,
              }),
            },
          }),
        );
        expect(
          requests().filter((request) => request.op === "restoreViewerDisplay"),
        ).toHaveLength(1);
        expect(button("fitViewerDisplay").disabled).toBe(false);
        expect(sent()).toContainEqual(
          expect.objectContaining({
            type: "videoSettings",
            width: display.width,
            height: display.height,
          }),
        );
      }
    },
  );
  it.each(["streaming", "fallback"])(
    "coalesces continuous quality choices until %s",
    async (terminal) => {
      fixture.systemAudio = true;
      await connect();
      const message = async (value: object) =>
        act(async () => {
          fixture.message!({
            nativeEvent: { data: JSON.stringify({ epoch: "lease", ...value }) },
          });
        });
      await message({ type: "streaming" });
      act(() => button("operations").click());
      act(() => button("displaySettings").click());
      const select = async (control: string, index: number) =>
        act(async () => {
          host
            .querySelectorAll<HTMLButtonElement>(
              `[data-testid="remoteDesktop.${control}Control"] button`,
            )
            [index].click();
        });
      const changes = () => sent().filter((m) => m.type === "videoSettings");
      fixture.playback.mockClear();
      await select("frameRate", 1);
      expect(changes()).toHaveLength(1);
      await select("quality", 1);
      await select("quality", 2);
      await select("quality", 3);
      expect(button("original").getAttribute("aria-selected")).toBe("true");
      expect(changes()).toHaveLength(1);
      expect(fixture.playback).not.toHaveBeenCalled();
      await message({ type: terminal });
      expect(changes()).toHaveLength(2);
      await message({ type: "offer", sdp: "sdp", attemptId: "latest" });
      expect(
        requests()
          .filter((r) => r.op === "offer")
          .at(-1).settings,
      ).toMatchObject({ fps: 60, bitrate: 20000000 });
      await message({ type: "streaming" });
      expect(changes()).toHaveLength(2);
      await select("quality", 1);
      await select("quality", 2);
      expect(changes()).toHaveLength(3);
      act(() => root.unmount());
      mounted = false;
      await message({ type: "streaming" });
      expect(changes()).toHaveLength(3);
    },
  );
  it("waits for an outstanding host offer even after the viewer falls back", async () => {
    fixture.systemAudio = true;
    await connect();
    const message = async (value: object) =>
      act(async () => {
        fixture.message!({
          nativeEvent: { data: JSON.stringify({ epoch: "lease", ...value }) },
        });
      });
    let finish!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "offer"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    await message({ type: "offer", sdp: "sdp", attemptId: "pending" });
    await message({ type: "streaming" });
    act(() => button("operations").click());
    act(() => button("displaySettings").click());
    await act(async () => button("original").click());
    await message({ type: "fallback" });
    expect(sent().filter((m) => m.type === "videoSettings")).toHaveLength(0);
    await act(async () => finish({ sdp: "answer" }));
    expect(sent().filter((m) => m.type === "videoSettings")).toHaveLength(1);
  });
  it("preserves FPS and quality selected in the same render batch", async () => {
    fixture.systemAudio = true;
    await connect();
    act(() => button("operations").click());
    act(() => button("displaySettings").click());
    await act(async () => {
      host
        .querySelectorAll<HTMLButtonElement>(
          '[data-testid="remoteDesktop.frameRateControl"] button',
        )[1]
        .click();
      button("original").click();
    });
    expect(
      host
        .querySelectorAll<HTMLButtonElement>(
          '[data-testid="remoteDesktop.frameRateControl"] button',
        )[1]
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(button("original").getAttribute("aria-selected")).toBe("true");
  });
  it("cancels the PiP timeout when queued quality changes exit PiP", async () => {
    fixture.systemAudio = true;
    await connect();
    const message = async (value: object) =>
      act(async () => {
        fixture.message!({
          nativeEvent: { data: JSON.stringify({ epoch: "lease", ...value }) },
        });
      });
    await message({ type: "streaming" });
    await message({ type: "pipCapability", supported: true });
    let finish!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "presentation" && args[2][0].enabled
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    act(() => button("displaySettings").click());
    await act(async () => button("original").click());
    await act(async () => finish({}));
    expect(sent().filter((m) => m.type === "videoSettings")).toHaveLength(1);
    await message({ type: "streaming" });
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    act(() => button("operations").click());
    expect(host.textContent).not.toContain("remoteDesktop.pipUnavailable");
  });
  it("does not reuse Mac eligibility when the route changes to another host", async () => {
    await connect();
    expect(fixture.getHost()).toBe("darwin");
    act(() => button("operations").click());
    act(() => button("security").click());
    expect(
      host.querySelector('[data-testid="remoteDesktop.autoUnlock"]'),
    ).not.toBeNull();
    fixture.deviceId = "other-computer";
    act(() => root.render(<RemoteDesktopScreen />));
    expect(fixture.getHost()).toBeUndefined();
    expect(
      host.querySelector('[data-testid="remoteDesktop.autoUnlock"]'),
    ).toBeNull();
  });
  it.each([
    ["android", "darwin"],
    ["ios", "win32"],
    ["ios", undefined],
  ])(
    "hides unsupported unlock settings for %s / %s while retaining exit locking",
    async (controller, remote) => {
      fixture.platform = controller!;
      fixture.hostPlatform = remote;
      await connect();
      expect(fixture.maybeUnlock).not.toHaveBeenCalled();
      act(() => button("operations").click());
      act(() => button("security").click());
      expect(
        host.querySelector('[data-testid="remoteDesktop.autoUnlock"]'),
      ).toBeNull();
      expect(
        host.querySelector(
          '[data-testid="remoteDesktop.biometricVerification"]',
        ),
      ).toBeNull();
      expect(host.textContent).not.toContain(
        "remoteDesktop.autoUnlockStorageHint",
      );
      expect(host.textContent).not.toContain(
        "remoteDesktop.autoUnlockUnavailable",
      );
      expect(
        host.querySelector('[data-testid="remoteDesktop.lockOnExit"]'),
      ).not.toBeNull();
    },
  );
  it.each(["light", "dark"])(
    "keeps panel geometry and controls stable across pages and loading in %s",
    async (theme) => {
      fixture.themeMode = theme;
      await connect();
      act(() => button("operations").click());
      const initial = fixture.views["remoteDesktop.panelSurface"].style;
      expect(initial.flat(Infinity)).toContainEqual(
        expect.objectContaining({ height: "50%" }),
      );
      expect(fixture.views["remoteDesktop.panelScroll"].style).toMatchObject({
        flex: 1,
        minHeight: 0,
      });
      const firstScroll = host.querySelector(
        '[data-testid="remoteDesktop.panelScroll"]',
      );
      act(() => button("displaySettings").click());
      expect(fixture.views["remoteDesktop.panelSurface"].style).toEqual(
        initial,
      );
      expect(
        host.querySelector('[data-testid="remoteDesktop.panelScroll"]'),
      ).not.toBe(firstScroll);
      act(() => button("back").click());
      act(() => button("security").click());
      const slot = host.querySelector(
        '[data-testid="remoteDesktop.securityProgressSlot"]',
      );
      const automatic = host.querySelector(
        '[data-testid="remoteDesktop.autoUnlock"]',
      );
      fixture.securityBusy = true;
      act(() => root.render(<RemoteDesktopScreen />));
      expect(
        host.querySelector(
          '[data-testid="remoteDesktop.securityProgressSlot"]',
        ),
      ).toBe(slot);
      expect(
        host.querySelector('[data-testid="remoteDesktop.autoUnlock"]'),
      ).toBe(automatic);
      expect(fixture.views["remoteDesktop.panelSurface"].style).toEqual(
        initial,
      );
      expect(
        fixture.views["remoteDesktop.securityProgressSlot"].style,
      ).toMatchObject({ width: 24, height: 24 });
      expect(host.textContent).not.toContain("remoteDesktop.loadingSettings");
    },
  );
  it.each([false, true])(
    "allows keyboard content height within viewport bounds, landscape=%s",
    async (landscape) => {
      fixture.size = landscape
        ? { width: 844, height: 390 }
        : { width: 390, height: 844 };
      await act(async () => root.render(<RemoteDesktopScreen />));
      await connect();
      act(() => button("keyboard").click());
      act(() => button("computerKeyboard").click());
      const style = fixture.views["remoteDesktop.keyPageViewport"].style;
      expect(style).toEqual({ flexShrink: 1, maxHeight: landscape ? 156 : 300 });
      act(() => button("functionKeys").click());
      expect(fixture.views["remoteDesktop.keyPageViewport"].style).toEqual(
        style,
      );
      expect(sent()).toContainEqual({
        type: "events",
        events: [{ kind: "release" }],
      });
    },
  );
  it("requests lock once on explicit exit, independent of automatic unlock", async () => {
    fixture.lockOnExit = true;
    await act(async () => root.render(<RemoteDesktopScreen />));
    await connect();
    await act(async () => button("back").click());
    expect(requests().filter((r) => r.op === "stop")).toEqual([
      { op: "stop", lease: "lease", lockScreen: true },
    ]);
    expect(goBackGuarded).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    mounted = false;
    expect(requests().filter((r) => r.lockScreen)).toHaveLength(1);
  });
  it("does not lock for Face ID inactivity or background recovery", async () => {
    fixture.lockOnExit = true;
    await act(async () => root.render(<RemoteDesktopScreen />));
    await connect();
    await act(async () => fixture.appState?.("inactive"));
    expect(requests().some((r) => r.lockScreen)).toBe(false);
    await act(async () => fixture.appState?.("background"));
    expect(requests().some((r) => r.lockScreen)).toBe(false);
  });
  it.each([true, false])(
    "handles route unmount with lock support %s",
    async (supported) => {
      fixture.lockOnExit = true;
      fixture.lockSupported = supported;
      await act(async () => root.render(<RemoteDesktopScreen />));
      await connect();
      act(() => root.unmount());
      mounted = false;
      expect(requests().filter((r) => r.op === "stop")).toEqual([
        {
          op: "stop",
          lease: "lease",
          ...(supported ? { lockScreen: true } : {}),
        },
      ]);
    },
  );
  it("shows a lock failure instead of reporting a successful lock", async () => {
    fixture.lockOnExit = true;
    await act(async () => root.render(<RemoteDesktopScreen />));
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].lockScreen
        ? Promise.reject(new Error("DESKTOP_LOCK_FAILED"))
        : original(...args),
    );
    await act(async () => button("back").click());
    expect(fixture.alert).toHaveBeenCalledWith(
      "remoteDesktop.lockOnExit",
      "remoteDesktop.lockOnExitFailed",
    );
  });
  it("locks once when navigation blurs before unmount", async () => {
    fixture.lockOnExit = true;
    await act(async () => root.render(<RemoteDesktopScreen />));
    await connect();
    fixture.focused = false;
    await act(async () => root.render(<RemoteDesktopScreen />));
    act(() => root.unmount());
    mounted = false;
    expect(requests().filter((r) => r.op === "stop")).toEqual([
      { op: "stop", lease: "lease", lockScreen: true },
    ]);
  });
  it("prepares Linux unlock before capture without waiting for a first frame", async () => {
    fixture.hostPlatform = "linux";
    let finish!: () => void;
    const prompt = vi.fn();
    fixture.maybeUnlock.mockImplementationOnce(async (beforeAuthentication) => {
      await beforeAuthentication!();
      prompt();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await act(async () => {
      fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(requests().some((r) => r.op === "start")).toBe(false);
    await act(async () => {
      finish();
    });
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it.each(["framePresented", "streaming"])(
    "prepares authentication alongside capture and waits for %s before Face ID",
    async (firstFrame) => {
      let finishUnlock!: () => void;
      const prompt = vi.fn();
      fixture.maybeUnlock.mockImplementationOnce(
        async (beforeAuthentication) => {
          await beforeAuthentication!();
          prompt();
          await new Promise<void>((resolve) => {
            finishUnlock = resolve;
          });
        },
      );
      await act(async () => {
        fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
      });
      expect(requests().filter((r) => r.op === "capabilities")).toHaveLength(1);
      expect(requests().some((r) => r.op === "start")).toBe(true);
      expect(sent().some((m) => m.type === "init")).toBe(true);
      expect(fixture.maybeUnlock).toHaveBeenCalledTimes(1);
      expect(prompt).not.toHaveBeenCalled();

      await act(async () => {
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: firstFrame,
              epoch: "lease",
            }),
          },
        });
      });
      expect(fixture.maybeUnlock).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(
        host.querySelector('[data-testid="remoteDesktop.connectingStatus"]'),
      ).toBeNull();
      const stops = requests().filter((r) => r.op === "stop").length;
      await act(async () => {
        AppState.currentState = "inactive";
        fixture.appState!("inactive");
        fixture.message!({
          nativeEvent: { data: '{"type":"streaming","epoch":"lease"}' },
        });
        fixture.message!({
          nativeEvent: { data: '{"type":"framePresented","epoch":"lease"}' },
        });
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(requests().some((r) => r.op === "heartbeat")).toBe(true);
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(stops);
      expect(fixture.maybeUnlock).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishUnlock();
        AppState.currentState = "active";
        fixture.appState!("active");
      });
      expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(stops);
    },
  );
  it("does not unlock for a stale frame or a frame arriving after leaving", async () => {
    const prompt = vi.fn();
    let outcome!: Promise<string>;
    fixture.maybeUnlock.mockImplementationOnce(async (beforeAuthentication) => {
      outcome = beforeAuthentication!().then(
        () => {
          prompt();
          return "shown";
        },
        (error: Error) => error.message,
      );
      await outcome;
    });
    await act(async () => {
      fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } });
      fixture.message!({
        nativeEvent: { data: '{"type":"framePresented","epoch":"old-lease"}' },
      });
    });
    expect(fixture.maybeUnlock).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    fixture.focused = false;
    await act(async () => root.render(<RemoteDesktopScreen />));
    await act(async () => {
      fixture.message!({
        nativeEvent: { data: '{"type":"framePresented","epoch":"lease"}' },
      });
    });
    expect(await outcome).toBe("CREDENTIAL_CANCELLED");
    expect(prompt).not.toHaveBeenCalled();
  });
  it("places optional unlock under Operation Security without gating the desktop", async () => {
    await connect();
    expect(requests().some((request) => request.op === "start")).toBe(true);
    act(() => button("operations").click());
    const security = host.querySelector(
      '[data-testid="remoteDesktop.security"]',
    ) as HTMLButtonElement;
    const displaySettings = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("remoteDesktop.displaySettings"),
    )!;
    expect(
      displaySettings.compareDocumentPosition(security) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => security.click());
    expect(host.textContent).toContain("remoteDesktop.autoUnlockStorageHint");
    const automatic = host.querySelector(
      '[data-testid="remoteDesktop.autoUnlock"]',
    ) as HTMLButtonElement;
    const biometric = host.querySelector(
      '[data-testid="remoteDesktop.biometricVerification"]',
    ) as HTMLButtonElement;
    expect(automatic.getAttribute("aria-checked")).toBe("false");
    expect(automatic.disabled).toBe(false);
    expect(biometric).toBeNull();
    fixture.securityAutoUnlock = true;
    act(() => root.render(<RemoteDesktopScreen />));
    expect(
      (
        host.querySelector(
          '[data-testid="remoteDesktop.biometricVerification"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await act(async () => button("back").click());
    expect(
      host.querySelector('[data-testid="remoteDesktop.security"]'),
    ).not.toBeNull();
  });
  it("keeps video and control when playback fails without changing the sound preference", async () => {
    fixture.systemAudio = true;
    fixture.playback.mockImplementation(async (enabled) => {
      if (enabled) throw new Error("audio interrupted");
    });
    await connect();
    expect(sent().find((m) => m.type === "init")).toMatchObject({
      audio: false,
    });
    expect(sent().find((m) => m.type === "control")).toMatchObject({
      enabled: true,
    });
    expect(fixture.playback).toHaveBeenLastCalledWith(false);
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "offer",
            epoch: "lease",
            sdp: "sdp",
            attemptId: "attempt",
          }),
        },
      });
    });
    expect(requests().find((r) => r.op === "offer").settings.audio).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    act(() => button("operations").click());
    expect(host.textContent).toContain("remoteDesktop.audioUnavailable");
    expect(button("sound").getAttribute("aria-selected")).toBe("true");
    fixture.playback.mockResolvedValue(undefined);
    await act(async () => button("sound").click());
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "streaming", epoch: "lease" }),
        },
      }),
    );
    await act(async () => button("sound").click());
    expect(
      sent()
        .filter((m) => m.type === "videoSettings")
        .at(-1),
    ).toMatchObject({ audio: true });
    expect(host.textContent).not.toContain("remoteDesktop.audioUnavailable");
  });
  it("moves the centered rail opposite the island in both landscape directions", async () => {
    fixture.size = { width: 874, height: 402 };
    for (const islandRight of [false, true, false]) {
      fixture.safe = { top: 0, bottom: 21, left: 62, right: 62 };
      act(() => root.render(<RemoteDesktopScreen />));
      act(() =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "orientation",
              angle: islandRight ? -90 : 90,
            }),
          },
        }),
      );
      const rail = fixture.views["remoteDesktop.toolbarPosition"];
      const style = Object.assign(
        {},
        ...rail.style.flat(Infinity).filter(Boolean),
      );
      expect(style).toMatchObject({
        top: 0,
        bottom: 21,
        justifyContent: "center",
        paddingBottom: 0,
      });
      expect(style.left).toBe(islandRight ? 0 : undefined);
      expect(style.right).toBe(islandRight ? undefined : 0);
      expect(style.paddingLeft).toBe(islandRight ? 16 : 0);
      expect(style.paddingRight).toBe(islandRight ? 0 : 16);
      act(() =>
        rail.onLayout({ nativeEvent: { layout: { width: 68, height: 381 } } }),
      );
      expect(
        sent()
          .filter((m) => m.type === "mouseButtons")
          .at(-1),
      ).toMatchObject({
        leftInset: 0,
        rightInset: 0,
      });
    }
  });
  it("keeps the landscape back button in the corner when only the long edge is inset", async () => {
    fixture.size = { width: 874, height: 402 };
    fixture.safe = { top: 0, bottom: 21, left: 62, right: 62 };
    for (const islandRight of [false, true]) {
      act(() => root.render(<RemoteDesktopScreen />));
      act(() =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "orientation",
              angle: islandRight ? -90 : 90,
            }),
          },
        }),
      );
      const style = Object.assign(
        {},
        ...fixture.views["remoteDesktop.backPosition"].style
          .flat(Infinity)
          .filter(Boolean),
      );
      expect(style.left).toBe(20);
    }
  });
  it("shifts the landscape back button when a cutout occupies the top-left corner", async () => {
    fixture.size = { width: 874, height: 402 };
    fixture.safe = { top: 24, bottom: 21, left: 48, right: 0 };
    act(() => root.render(<RemoteDesktopScreen />));
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "orientation", angle: 90 }),
        },
      }),
    );
    const style = Object.assign(
      {},
      ...fixture.views["remoteDesktop.backPosition"].style
        .flat(Infinity)
        .filter(Boolean),
    );
    expect(style.left).toBe(68);
  });
  it("honors Android landscape left insets even when the top edge is clear", async () => {
    fixture.platform = "android";
    fixture.size = { width: 874, height: 402 };
    fixture.safe = { top: 0, bottom: 21, left: 62, right: 62 };
    act(() => root.render(<RemoteDesktopScreen />));
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "orientation", angle: 90 }),
        },
      }),
    );
    const style = Object.assign(
      {},
      ...fixture.views["remoteDesktop.backPosition"].style
        .flat(Infinity)
        .filter(Boolean),
    );
    expect(style.left).toBe(78);
  });
  it("does not treat Android status-bar plus mid-edge inset as an iOS island", async () => {
    fixture.platform = "android";
    fixture.size = { width: 874, height: 402 };
    fixture.safe = { top: 24, bottom: 21, left: 62, right: 62 };
    act(() => root.render(<RemoteDesktopScreen />));
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "orientation", angle: 90 }),
        },
      }),
    );
    const style = Object.assign(
      {},
      ...fixture.views["remoteDesktop.backPosition"].style
        .flat(Infinity)
        .filter(Boolean),
    );
    expect(style.left).toBe(78);
  });
  it("restores a centered bottom toolbar after a full rotation without remounting the viewer", async () => {
    await connect();
    const viewer = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    const firstToolbar = host.querySelector(
      '[data-testid="remoteDesktop.toolbarPosition"]',
    );
    for (const angle of [90, 180, 270, 0]) {
      const landscape = angle === 90 || angle === 270;
      fixture.size = landscape
        ? { width: 874, height: 402 }
        : { width: 402, height: 874 };
      fixture.safe = landscape
        ? { top: 0, bottom: 21, left: 62, right: 62 }
        : { top: 59, bottom: 34, left: 0, right: 0 };
      act(() => {
        root.render(<RemoteDesktopScreen />);
        fixture.message!({
          nativeEvent: { data: JSON.stringify({ type: "orientation", angle }) },
        });
      });
      expect(
        sent()
          .filter((message) => message.type === "mouseButtons")
          .at(-1),
      ).toMatchObject({ topInset: fixture.safe.top });
      if (!landscape) {
        const style = Object.assign(
          {},
          ...fixture.views["remoteDesktop.toolbarPosition"].style
            .flat(Infinity)
            .filter(Boolean),
        );
        expect(style).toMatchObject({
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: "center",
          paddingLeft: 0,
          paddingRight: 0,
        });
        expect(style.top).toBeUndefined();
      }
      expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(
        viewer,
      );
    }
    expect(
      host.querySelector('[data-testid="remoteDesktop.toolbarPosition"]'),
    ).not.toBe(firstToolbar);
  });
  it("keeps Android portrait fit when the IME shrinks the window, but follows real rotation", async () => {
    fixture.platform = "android";
    fixture.displaySize = { width: 390, height: 640 };
    fixture.size = { width: 390, height: 616 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    expect(sent().find(message => message.type === "init")).toMatchObject({ fillHeight: false });
    const viewer = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    for (const height of [300, 616, 280]) {
      fixture.size = { width: 390, height };
      act(() => root.render(<RemoteDesktopScreen />));
      expect(sent().filter(message => message.type === "viewport").at(-1)).toMatchObject({ fillHeight: false });
      expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(viewer);
    }
    fixture.displaySize = { width: 640, height: 390 };
    fixture.size = { width: 640, height: 200 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(sent().filter(message => message.type === "viewport").at(-1)).toMatchObject({ fillHeight: true });
  });
  it("restores the portrait top inset while the native safe area still reports landscape", async () => {
    await connect();
    const topInset = () =>
      sent()
        .filter((message) => message.type === "mouseButtons")
        .at(-1)?.topInset;
    expect(topInset()).toBe(59);

    fixture.size = { width: 874, height: 402 };
    fixture.safe = { top: 0, bottom: 21, left: 62, right: 62 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(topInset()).toBe(0);

    fixture.size = { width: 402, height: 874 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(topInset()).toBe(59);
  });
  it('preserves a valid side safe area on a modern tall window', async () => {
    fixture.iosVersion = 27;
    fixture.size = { width: 600, height: 900 };
    fixture.safe = { top: 0, bottom: 20, left: 60, right: 0 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    expect(sent().filter(message => message.type === 'mouseButtons').at(-1)?.topInset).toBe(0);
  });
  it("overlays landscape keyboards and includes their measured occlusion", async () => {
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    act(() => button("keyboard").click());
    expect(fixture.views["remoteDesktop.layout"].enabled).toBe(false);
    const panel = () => fixture.views["remoteDesktop.keyboardPanel"];
    expect(panel().style.flat(Infinity)).toContainEqual(
      expect.objectContaining({ position: "absolute" }),
    );
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 60 } } }));
    act(() =>
      fixture.keyboardListeners.keyboardWillChangeFrame({
        endCoordinates: { screenY: 180 },
      }),
    );
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 210 });
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({
      bottomInset: 270,
      keyboardOpen: true,
    });
    const computer = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "remoteDesktop.computerKeyboard",
    )!;
    act(() => computer.click());
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 280 } } }));
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 0 });
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({
      bottomInset: 280,
      keyboardOpen: true,
    });
    act(() => button("close").click());
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({
      bottomInset: 0,
      keyboardOpen: false,
    });
  });

  it("keeps Android native keyboard avoidance without adding its height twice", async () => {
    fixture.platform = "android";
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    act(() => button("keyboard").click());
    const panel = () => fixture.views["remoteDesktop.keyboardPanel"];
    act(() =>
      fixture.keyboardListeners.keyboardDidShow({
        endCoordinates: { screenY: 180 },
      }),
    );
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 60 } } }));
    expect(panel().style.flat(Infinity)).not.toContainEqual(
      expect.objectContaining({ position: "absolute" }),
    );
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({ bottomInset: 0, keyboardOpen: false });
    const computer = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "remoteDesktop.computerKeyboard",
    )!;
    act(() => computer.click());
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 280 } } }));
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 0 });
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({ bottomInset: 280, keyboardOpen: true });
  });

  it("keeps a video answer arriving after control initialization and ignores it after exit", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    let control!: (value: object) => void;
    let answer!: (value: object) => void;
    fixture.invoke.mockImplementation((...args) => {
      if (args[2][0].op === "control")
        return new Promise((resolve) => {
          control = resolve;
        });
      if (args[2][0].op === "offer")
        return new Promise((resolve) => {
          answer = resolve;
        });
      return original(...args);
    });
    await connect();
    expect(
      host.querySelector('[data-testid="remoteDesktop.connectingStatus"]'),
    ).not.toBeNull();
    expect(host.textContent).not.toContain("remoteDesktop.viewOnly");
    const offer = () =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "offer",
            epoch: "lease",
            attemptId: "1",
            sdp: "offer",
          }),
        },
      });
    act(offer);
    await act(async () => control({ controlling: true }));
    expect(
      host.querySelector('[data-testid="remoteDesktop.connectingStatus"]'),
    ).toBeNull();
    await act(async () => answer({ sdp: "valid-answer" }));
    expect(sent()).toContainEqual({
      type: "answer",
      epoch: "lease",
      attemptId: "1",
      sdp: "valid-answer",
    });
    act(offer);
    act(() => root.unmount());
    mounted = false;
    await act(async () => answer({ sdp: "late-answer" }));
    expect(
      sent().some((m) => m.type === "answer" && m.sdp === "late-answer"),
    ).toBe(false);
  });
  it("fences late signaling within one lease and preserves the legacy desktop path", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    const answers: ((value: object) => void)[] = [];
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "offer"
        ? new Promise((resolve) => answers.push(resolve))
        : original(...args),
    );
    const offer = (attemptId: string) =>
      act(() =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "offer",
              epoch: "lease",
              attemptId,
              sdp: "offer",
            }),
          },
        }),
      );
    offer("old");
    offer("new");
    expect(
      requests()
        .filter((m) => m.op === "offer")
        .every((m) => m.attemptId === undefined),
    ).toBe(true);
    const oldSend = fixture.invoke.mock.calls.find(
      (call) => call[2][0].op === "offer",
    )![3].preSend;
    expect(oldSend).toThrow("DESKTOP_VIDEO_STOPPED");
    await act(async () => answers[0]({ sdp: "old" }));
    expect(sent().some((m) => m.type === "answer" && m.sdp === "old")).toBe(
      false,
    );
    await act(async () => answers[1]({ sdp: "new" }));
    expect(sent()).toContainEqual({
      type: "answer",
      epoch: "lease",
      attemptId: "new",
      sdp: "new",
    });
    expect(requests().filter((m) => m.op === "start")).toHaveLength(1);
  });
  it("forwards bounded ICE batches only when both endpoints support incremental signaling", async () => {
    fixture.trickleIce = true;
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) => {
      const r = args[2][0];
      return r.op === "ice"
        ? Promise.resolve({
            attemptId: r.attemptId,
            next: r.after,
            candidates: [],
            complete: true,
          })
        : original(...args);
    });
    const message = (data: object) =>
      act(async () =>
        fixture.message!({
          nativeEvent: { data: JSON.stringify({ epoch: "lease", ...data }) },
        }),
      );
    await message({ type: "offer", attemptId: "a", sdp: "offer" });
    await message({
      type: "ice",
      attemptId: "a",
      after: 0,
      candidates: [],
      exchangeId: 1,
    });
    expect(sent()).toContainEqual({
      type: "ice",
      epoch: "lease",
      attemptId: "a",
      next: 0,
      candidates: [],
      complete: true,
      exchangeId: 1,
    });
    await message({
      type: "ice",
      attemptId: "stale",
      after: 0,
      candidates: [],
      exchangeId: 2,
    });
    await message({
      type: "ice",
      attemptId: "a",
      after: -1,
      candidates: [],
      exchangeId: 3,
    });
    expect(requests().filter((m) => m.op === "ice")).toHaveLength(1);
  });
  it.each([false, true])(
    "shows media recovery without replacing the lease (landscape=%s)",
    async (landscape) => {
      if (landscape) {
        fixture.size = { width: 844, height: 390 };
        act(() => root.render(<RemoteDesktopScreen />));
      }
      await connect();
      const message = (type: string) =>
        act(async () => {
          fixture.message!({
            nativeEvent: {
              data: JSON.stringify({
                type,
                epoch: "lease",
                attemptId: "1",
                sdp: "offer",
              }),
            },
          });
        });
      await message("offer");
      await message("streaming");
      const ownership = () =>
        requests().filter((r) => ["start", "control", "stop"].includes(r.op));
      const previousOwnership = [...ownership()];
      await message("reconnecting");
      const badge = () =>
        host.querySelector('[data-testid="remoteDesktop.connectingStatus"]');
      expect(badge()?.textContent).toBe("remoteDesktop.reconnecting");
      expect(host.textContent).not.toContain("remoteDesktop.viewOnly");
      expect(
        host.querySelector('[data-testid="remoteDesktop.viewer"]'),
      ).not.toBeNull();
      expect(button("keyboard").disabled).toBe(false);
      expect(ownership()).toEqual(previousOwnership);
      await message("streaming");
      expect(badge()).toBeNull();
      expect(ownership()).toEqual(previousOwnership);
    },
  );
  it("shows live receive rate, rejects old lease samples, and expires stale metrics", async () => {
    await connect();
    const message = (data: object) =>
      act(() =>
        fixture.message!({ nativeEvent: { data: JSON.stringify(data) } }),
      );
    message({ type: "streaming", epoch: "lease" });
    message({
      type: "network",
      epoch: "lease",
      transport: "direct",
      bytesPerSecond: 125000,
      latencyMs: 42,
    });
    const badge = () =>
      sent()
        .filter((m) => m.type === "networkStatus")
        .at(-1)?.text;
    expect(badge()).toContain("remoteDesktop.directConnection");
    expect(badge()).toContain("125 KB/s");
    expect(badge()).toContain("42 ms");
    expect(badge()).not.toContain("↓");
    message({
      type: "network",
      epoch: "old-lease",
      transport: "relay",
      bytesPerSecond: 999000,
    });
    expect(badge()).toContain("remoteDesktop.directConnection");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(badge()).toContain("— KB/s");
    expect(badge()).not.toContain("roundTrip");
    message({ type: "fallback", epoch: "lease" });
    message({
      type: "network",
      epoch: "lease",
      transport: "direct",
      bytesPerSecond: 999000,
    });
    expect(badge()).toContain("remoteDesktop.connecting");
    expect(badge()).not.toContain("999 KB/s");
  });
  it("keeps waiting for a temporarily absent capture source without restarting the lease", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "frame"
        ? Promise.resolve({ jpeg: null })
        : original(...args),
    );
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(requests().some((r) => r.op === "stop")).toBe(false);
    expect(
      sent()
        .filter((m) => m.type === "networkStatus")
        .at(-1)?.text,
    ).toContain("remoteDesktop.connecting");
    expect(
      sent()
        .filter((m) => m.type === "networkStatus")
        .at(-1)?.text,
    ).not.toContain("remoteDesktop.screenshotRelay");
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "frame"
        ? Promise.resolve({ jpeg: "a".repeat(4000) })
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      sent()
        .filter((m) => m.type === "networkStatus")
        .at(-1)?.text,
    ).toContain("remoteDesktop.screenshotRelay");
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it.each([false, true])(
    "bounds relay frames regardless of cursor overlay=%s",
    async (overlay) => {
      const original = fixture.invoke.getMockImplementation()!;
      let jpeg = "a".repeat(240_004);
      fixture.invoke.mockImplementation(async (...args) => {
        const op = args[2][0].op;
        if (op === "frame") return { jpeg, cursor: null };
        const result = await original(...args);
        return op === "capabilities"
          ? { ...result, cursorOverlay: overlay }
          : result;
      });
      await connect();
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(sent().filter((message) => message.type === "frame")).toHaveLength(
        0,
      );
      jpeg = "a".repeat(240_000);
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(sent().filter((message) => message.type === "frame")).toEqual([
        { type: "frame", jpeg, cursor: null },
      ]);
      expect(
        requests().filter((request) => request.op === "start"),
      ).toHaveLength(1);
    },
  );
  it("measures screenshot payloads separately and clears frame time when frames stop", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "frame"
        ? new Promise((resolve) =>
            setTimeout(() => resolve({ jpeg: "a".repeat(4000) }), 100),
          )
        : original(...args),
    );
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const badge = () =>
      sent()
        .filter((m) => m.type === "networkStatus")
        .at(-1)?.text;
    expect(badge()).toContain("remoteDesktop.screenshotRelay");
    expect(badge()).toContain("6 KB/s");
    expect(badge()).toMatch(/ · \d+ ms/);
    expect(badge()).not.toContain("roundTrip");
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "frame"
        ? Promise.resolve({ jpeg: null })
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(badge()).toContain("0 KB/s");
    expect(badge()).not.toContain("remoteDesktop.frameTime");
  });
  it("shows upgrade for a structured unsupported-channel error without retrying", async () => {
    fixture.invoke.mockRejectedValue(
      Object.assign(
        new Error(
          "channel 'device-link:remote-desktop:v1' not allowed remotely",
        ),
        { code: "CHANNEL_NOT_ALLOWED" },
      ),
    );
    await connect();
    expect(host.textContent).toContain("remoteDesktop.upgrade");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(requests().some((r) => r.op === "start")).toBe(false);
  });
  it("replaces the foreground lease after even a brief relay interruption", async () => {
    await connect();
    act(() =>
      fixture.message!({
        nativeEvent: { data: '{"type":"streaming","epoch":"lease"}' },
      }),
    );
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    fixture.status = "online";
    await act(async () => root.render(<RemoteDesktopScreen />));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
  });
  it("immediately releases foreground video when signaling goes offline", async () => {
    await connect();
    act(() =>
      fixture.message!({
        nativeEvent: { data: '{"type":"streaming","epoch":"lease"}' },
      }),
    );
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
  });
  it.each(["DEVICE_OFFLINE", "ACCESS_REVOKED"])(
    "discards the foreground lease on a definitive heartbeat error: %s",
    async (code) => {
      await connect();
      act(() =>
        fixture.message!({
          nativeEvent: { data: '{"type":"streaming","epoch":"lease"}' },
        }),
      );
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation((...args) =>
        args[2][0].op === "heartbeat"
          ? Promise.reject(Object.assign(new Error(code), { code }))
          : original(...args),
      );
      await act(async () => vi.advanceTimersByTimeAsync(3100));
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    },
  );
  it("renews again after a lost heartbeat reply without replacing the live lease", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "heartbeat"
        ? new Promise((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  Object.assign(new Error("INVOKE_TIMEOUT"), {
                    code: "INVOKE_TIMEOUT",
                  }),
                ),
              5000,
            ),
          )
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(21_000));
    expect(requests().filter((r) => r.op === "heartbeat")).toHaveLength(4);
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
  });
  it.each([
    ["ACCESS_REVOKED", "accessRevoked"],
    ["REMOTE_DISABLED", "remoteDisabled"],
  ])(
    "stops automatic recovery for %s while retaining manual retry",
    async (code, hint) => {
      const original = fixture.invoke.getMockImplementation()!;
      for (const structured of [false, true]) {
        for (const stage of ["openLink", "invoke"] as const) {
          const failure = structured
            ? Object.assign(new Error("Rejected by host"), { code })
            : new Error(`Remote invoke failed: ${code}`);
          fixture.openLink.mockResolvedValue({});
          fixture.invoke.mockImplementation(original);
          if (stage === "openLink") fixture.openLink.mockRejectedValue(failure);
          else fixture.invoke.mockRejectedValue(failure);
          await connect();
          act(() => button("connect").click());
          await act(async () => {});
          expect(host.textContent).toContain(`deviceLink.remoteError.${hint}`);
          const calls = fixture.openLink.mock.calls.length;
          await act(async () => vi.advanceTimersByTimeAsync(30_000));
          expect(fixture.openLink).toHaveBeenCalledTimes(calls);
          fixture.openLink.mockResolvedValue({});
          fixture.invoke.mockImplementation(original);
          act(() => button("connect").click());
          await act(async () => {});
          expect(fixture.openLink.mock.calls.length).toBeGreaterThan(calls);
          expect(host.textContent).not.toContain(
            `deviceLink.remoteError.${hint}`,
          );
        }
      }
    },
  );
  it("marks retries as recovery even when the first start reply was lost", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "start"
        ? Promise.reject(
            new Error(
              args[2][0].resume ? "DESKTOP_STOPPED" : "REQUEST_TIMEOUT",
            ),
          )
        : original(...args),
    );
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toEqual([
      { op: "start", displayId: "display" },
      { op: "start", displayId: "display", resume: true },
    ]);
    expect(button("connect")).not.toBeNull();
  });
  it.each([false, true])(
    "keeps explicit display switching available on older hosts (native menu: %s)",
    async (native) => {
      fixture.nativeMenus = native;
      const original = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (...args) => {
        const result = await original(...args);
        return args[2][0].op === "capabilities"
          ? {
              ...result,
              automaticReconnect: undefined,
              displays: [display, { ...display, id: "second" }],
            }
          : result;
      });
      await connect();
      act(() => button("operations").click());
      act(() =>
        [...host.querySelectorAll("button")]
          .find((item) =>
            item.textContent?.includes("remoteDesktop.displaySettings"),
          )!
          .click(),
      );
      await act(async () => button("display").click());
      expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            native
              ? '[data-testid="native-menu.second"]'
              : '[data-testid="remoteDesktop.display.second"]',
          )!
          .click(),
      );
      expect(
        requests()
          .filter((r) => r.op === "start")
          .at(-1),
      ).toEqual({ op: "start", displayId: "second" });
      expect(host.textContent).not.toContain("remoteDesktop.upgrade");
      if (native)
        expect(
          host.querySelector('[data-testid="remoteDesktop.display.second"]'),
        ).toBeNull();
      fixture.nativeMenus = false;
    },
  );
  it("does not automatically resume through an older host that cannot preserve local stops", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[2][0].op === "capabilities"
        ? { ...result, automaticReconnect: undefined }
        : result;
    });
    await connect();
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    fixture.status = "online";
    await act(async () => root.render(<RemoteDesktopScreen />));
    expect(host.textContent).toContain("remoteDesktop.upgrade");
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it("releases a late lease after Back without initializing the viewer", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    let finish!: (result: unknown) => void;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "start"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args),
    );
    await connect();
    act(() => button("back").click());
    await act(async () =>
      finish({ lease: "late", display, controlling: false }),
    );
    expect(requests()).toContainEqual({ op: "stop", lease: "late" });
    expect(sent().some((m) => m.type === "init")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it("preserves host stop while offline and lets only explicit reconnect start over", async () => {
    await connect();
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "start" && args[2][0].resume
        ? Promise.reject(new Error("DESKTOP_STOPPED"))
        : original(...args),
    );
    fixture.status = "online";
    await act(async () => root.render(<RemoteDesktopScreen />));
    expect(requests()).toContainEqual({
      op: "start",
      displayId: "display",
      resume: true,
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    expect(fixture.resetUnlockAttempt).not.toHaveBeenCalled();
    await act(async () => button("connect").click());
    expect(fixture.resetUnlockAttempt).toHaveBeenCalledTimes(1);
    expect(
      requests()
        .filter((r) => r.op === "start")
        .at(-1),
    ).toEqual({ op: "start", displayId: "display" });
  });
  it("reloads a viewer that died while permissions were blocked", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "control"
        ? Promise.reject(new Error("DESKTOP_ACCESSIBILITY_PERMISSION"))
        : original(...args),
    );
    await connect();
    act(() => fixture.crashed!());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fixture.reload).not.toHaveBeenCalled();
    act(() => fixture.retryPermissions!());
    expect(fixture.reload).toHaveBeenCalledTimes(1);
  });
  it("restores the chosen input mode after view-only control", async () => {
    await connect();
    act(() => button("operations").click());
    act(() => button("pointer").click());
    expect(sent().at(-1)).toEqual({ type: "mode", mode: "pointer" });
    expect(visibleInputHint()).toBe("remoteDesktop.pointerHint");
    await act(async () => button("viewOnly").click());
    expect(
      sent()
        .filter((m) => m.type === "mode")
        .at(-1),
    ).toEqual({ type: "mode", mode: "pan" });
    expect(visibleInputHint()).toBe("remoteDesktop.viewOnlyHint");
    await act(async () => button("viewOnly").click());
    expect(
      sent()
        .filter((m) => m.type === "mode")
        .at(-1),
    ).toEqual({ type: "mode", mode: "pointer" });
    act(() => button("touch").click());
    expect(button("pan")).toBeNull();
    expect(sent().at(-1)).toEqual({ type: "mode", mode: "touch" });
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it("keeps the session and the picture when the host refuses an input batch", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "input"
        ? Promise.reject(new Error("DESKTOP_VIEW_ONLY"))
        : original(...args),
    );
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "input",
            epoch: "lease",
            sequence: 1,
            events: [{ kind: "button", button: 0, down: true, x: 0.5, y: 0.5 }],
          }),
        },
      });
    });
    // The host retracted control: view only, no session rebuild.
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
    expect(sent()).toContainEqual({ type: "control", enabled: false });
    act(() => button("operations").click());
    expect(visibleInputHint()).toBe("remoteDesktop.controlUnavailableHint");
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
  });
  it("keeps control and the session when an input reply is lost", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "input"
        ? Promise.reject(
            Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" }),
          )
        : original(...args),
    );
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "input",
            epoch: "lease",
            sequence: 1,
            events: [{ kind: "key", code: "KeyA", down: true }],
          }),
        },
      });
    });
    // The batch may have been injected: releasing here would drop its key-up.
    expect(sent()).not.toContainEqual({ type: "control", enabled: false });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("stops input without changing the user's view-only choice when host control is revoked", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "heartbeat"
        ? Promise.resolve({ controlling: false })
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(sent()).toContainEqual({ type: "control", enabled: false });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
    act(() => button("operations").click());
    expect(visibleInputHint()).toBe("remoteDesktop.controlUnavailableHint");
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("false");
  });
  it("releases a stalled input batch instead of rebuilding the session", async () => {
    await connect();
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "inputOverflow", epoch: "lease" }),
        },
      });
    });
    expect(sent()).toContainEqual({ type: "control", enabled: false });
    // The WebView overflow replaces pending with a release, then this handler
    // posts control:false which clears that release without flushing it. The
    // host must still drop control so a held key/button cannot stay down.
    expect(requests()).toContainEqual({
      op: "control",
      lease: "lease",
      enabled: false,
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("retries a timed-out overflow release when the host still reports control", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) => {
      const req = args[2][0];
      if (req.op === "control" && req.enabled === false)
        return Promise.reject(
          Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" }),
        );
      if (req.op === "heartbeat") return Promise.resolve({ controlling: true });
      return original(...args);
    });
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "inputOverflow", epoch: "lease" }),
        },
      });
    });
    const released = requests().filter(
      (r) => r.op === "control" && r.enabled === false,
    );
    expect(released).toHaveLength(1);
    expect(sent()).toContainEqual({ type: "control", enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    // Local view-only is not proof the host dropped control; retry the release
    // so a held key cannot stay down behind a view-only phone.
    expect(
      requests().filter((r) => r.op === "control" && r.enabled === false),
    ).toHaveLength(2);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("finishes a timed-out overflow release before taking control again", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    let falseAttempts = 0;
    fixture.invoke.mockImplementation((...args) => {
      const req = args[2][0];
      if (req.op === "control" && req.enabled === false) {
        falseAttempts += 1;
        if (falseAttempts === 1)
          return Promise.reject(
            Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" }),
          );
        return Promise.resolve({ controlling: false });
      }
      if (req.op === "heartbeat") return Promise.resolve({ controlling: true });
      return original(...args);
    });
    await act(async () => {
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({ type: "inputOverflow", epoch: "lease" }),
        },
      });
    });
    expect(
      requests().filter((r) => r.op === "control" && r.enabled === false),
    ).toHaveLength(1);
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    const controlOps = requests()
      .filter((r) => r.op === "control")
      .map((r) => r.enabled);
    // Overflow timed out with pending release. Take control must finish that
    // release (host stopInput) before asking to enable, so the helper restarts.
    expect(controlOps).toEqual([true, false, false]);
    expect(button("viewOnly").getAttribute("aria-selected")).toBe("true");
    await act(async () => button("viewOnly").click());
    expect(
      requests()
        .filter((r) => r.op === "control")
        .map((r) => r.enabled),
    ).toEqual([true, false, false, true]);
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toEqual({
      type: "control",
      enabled: true,
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("restores control when a take-control reply is lost but the host still holds it", async () => {
    await connect();
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) => {
      const req = args[2][0];
      if (req.op === "control" && req.enabled === true)
        return Promise.reject(
          Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" }),
        );
      if (req.op === "heartbeat") return Promise.resolve({ controlling: true });
      return original(...args);
    });
    await act(async () => button("viewOnly").click());
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toEqual({
      type: "control",
      enabled: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toEqual({
      type: "control",
      enabled: true,
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("keeps a take-control intent when a settling heartbeat still reports view-only", async () => {
    await connect();
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    const original = fixture.invoke.getMockImplementation()!;
    let rejectTakeControl: ((cause: unknown) => void) | undefined;
    let heartbeats = 0;
    fixture.invoke.mockImplementation((...args) => {
      const req = args[2][0];
      if (req.op === "control" && req.enabled === true) {
        return new Promise((_, reject) => {
          rejectTakeControl = reject;
        });
      }
      if (req.op === "heartbeat") {
        heartbeats += 1;
        // startInput is still settling on the first beat; the host only
        // reports control after the lost take-control reply.
        return Promise.resolve({ controlling: heartbeats > 1 });
      }
      return original(...args);
    });
    act(() => button("viewOnly").click());
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await act(async () => {
      rejectTakeControl!(
        Object.assign(new Error("timeout"), { code: "INVOKE_TIMEOUT" }),
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    // A heartbeat issued while startInput was settling must not consume the
    // pending take-control; after the reply is lost, host-true still restores.
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toEqual({
      type: "control",
      enabled: true,
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
  });
  it("shows virtual mouse buttons outside the panel and hides them while viewing only", async () => {
    await connect();
    act(() => button("operations").click());
    expect(button("rightClick")).toBeNull();
    expect(button("showMouseButtons").getAttribute("aria-checked")).toBe(
      "false",
    );
    await act(async () => button("showMouseButtons").click());
    expect(button("showMouseButtons").getAttribute("aria-checked")).toBe(
      "true",
    );
    act(() => button("close").click());
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({ enabled: true });
    expect(
      host.querySelector('[data-testid="remoteDesktop.operationsPanel"]'),
    ).toBeNull();
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    expect(
      sent()
        .filter((m) => m.type === "mouseButtons")
        .at(-1),
    ).toMatchObject({ enabled: false });
    expect(visibleInputHint()).toBe("remoteDesktop.viewOnlyHint");
    expect(button("fit")).toBeNull();
    act(() => button("close").click());
    expect(
      host.querySelector('[data-testid="remoteDesktop.operationsPanel"]'),
    ).toBeNull();
  });
  it("requests control on entry and keeps only four persistent tools", async () => {
    await connect();
    expect(requests()).toContainEqual({
      op: "control",
      lease: "lease",
      enabled: true,
    });
    expect(sent()).toContainEqual({ type: "control", enabled: true });
    expect(sent()).toContainEqual({ type: "mode", mode: "touch" });
    expect(
      host
        .querySelector('[data-testid="remoteDesktop.toolbar"]')!
        .querySelectorAll("button"),
    ).toHaveLength(4);
    expect(host.textContent).not.toContain("My Mac");
    const viewer = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    act(() => button("operations").click());
    expect(host.textContent).toContain("My Mac");
    expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(
      viewer,
    );
    await act(async () => button("viewOnly").click());
    expect(requests()).toContainEqual({
      op: "control",
      lease: "lease",
      enabled: false,
    });
    expect(button("keyboard").disabled).toBe(true);
    await connect();
    expect(
      requests().filter((r) => r.op === "control" && r.enabled),
    ).toHaveLength(1);
    expect(button("keyboard").disabled).toBe(true);
    await act(async () => button("viewOnly").click());
    expect(button("keyboard").disabled).toBe(false);
  });
  it("asks before taking over an existing remote desktop viewer", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    let firstStart = true;
    fixture.invoke.mockImplementation((...args) => {
      const request = args[2][0];
      if (request.op === "start" && firstStart) {
        firstStart = false;
        return Promise.reject(new Error("DESKTOP_BUSY"));
      }
      return original(...args);
    });

    await connect();

    expect(fixture.alert).toHaveBeenCalledWith(
      "remoteDesktop.connectionBusy",
      "remoteDesktop.connectionBusyTakeover",
      expect.any(Array),
    );
    const buttons = fixture.alert.mock.calls.at(-1)![2] as Array<{
      onPress?: () => void;
    }>;
    await act(async () => {
      buttons[1].onPress?.();
    });
    expect(requests()).toContainEqual({
      op: "start",
      displayId: "display",
      takeover: true,
    });
  });
  it('resends the upper-pane bounds whenever a folded viewer becomes ready', async () => {
    fixture.size = { width: 900, height: 1400 };
    const geometry: WindowGeometry = {
      ...fixture.size, insets: { top: 80, left: 0, right: 0, bottom: 20 },
      regularWidth: true, regularHeight: true, barEdge: 'none', reservedRegionsSupported: true,
      regions: [{ kind: 'division', x: 0, y: 680, width: 900, height: 30 }],
    };
    act(() => root.render(<GeometryContext.Provider value={geometry}><RemoteDesktopScreen /></GeometryContext.Provider>));
    await connect();
    fixture.post.mockClear();
    // On reload the WebView loses all JS state even though React geometry and
    // the active lease have not changed. Do not rely on a lease update to resend.
    await act(async () => fixture.message!({ nativeEvent: { data: '{"type":"ready"}' } }));
    expect(sent()).toContainEqual(expect.objectContaining({
      type: 'mouseButtons', fitToInsets: true, topInset: 80, bottomInset: 720,
    }));
  });
  it('folding and unfolding preserve the viewer and control lease', async () => {
    const geometry: WindowGeometry = {
      width: 900, height: 700, insets: { top: 0, left: 0, right: 60, bottom: 20 },
      regularWidth: true, regularHeight: true, barEdge: 'right', regions: [], reservedRegionsSupported: true,
    };
    fixture.size = { width: 900, height: 700 };
    const renderGeometry = (g: WindowGeometry) => act(() => root.render(
      <GeometryContext.Provider value={g}><RemoteDesktopScreen /></GeometryContext.Provider>,
    ));
    renderGeometry(geometry);
    await connect();
    const rail = Object.assign({}, ...fixture.views['remoteDesktop.toolbarPosition'].style.flat(Infinity).filter(Boolean));
    expect(rail).toMatchObject({ right: 0, left: undefined, width: 72, paddingRight: 0, alignItems: 'center' });
    const backStyle = Object.assign({}, ...fixture.views['remoteDesktop.backPosition'].style.flat(Infinity).filter(Boolean));
    expect(backStyle).toMatchObject({ top: 120, left: 842, width: 44 });
    act(() => fixture.views['remoteDesktop.toolbarPosition'].onLayout({
      nativeEvent: { layout: { width: 72, height: 300 } },
    }));
    expect(sent().filter(m => m.type === 'mouseButtons').at(-1)).toMatchObject({ rightInset: 0 });
    // Rotating to the opposite landscape must not send custom chrome to the left.
    renderGeometry({ ...geometry, barEdge: 'left', insets: { ...geometry.insets, left: 60, right: 0 } });
    const rotatedRail = Object.assign({}, ...fixture.views['remoteDesktop.toolbarPosition'].style.flat(Infinity).filter(Boolean));
    const rotatedBack = Object.assign({}, ...fixture.views['remoteDesktop.backPosition'].style.flat(Infinity).filter(Boolean));
    expect(rotatedRail).toMatchObject({ right: 0, left: undefined, width: 60, alignItems: 'center' });
    expect(rotatedBack).toMatchObject({ left: 848, width: 44 });
    expect(sent().filter(m => m.type === 'mouseButtons').at(-1)).toMatchObject({ rightInset: 0 });
    renderGeometry({ ...geometry, barEdge: 'none' });
    const noPreferredEdge = Object.assign({}, ...fixture.views['remoteDesktop.backPosition'].style.flat(Infinity).filter(Boolean));
    expect(noPreferredEdge).toMatchObject({ left: 842, width: 44 });
    const viewerNode = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    const starts = requests().filter(r => r.op === 'start').length;
    const stops = requests().filter(r => r.op === 'stop').length;
    renderGeometry({ ...geometry, regions: [{ kind: 'division', x: 0, y: 300, width: 900, height: 30 }] });
    expect(sent().filter(m => m.type === 'mouseButtons').at(-1)).toMatchObject({
      fitToInsets: true, topInset: 0, bottomInset: 400,
    });
    expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(viewerNode);
    renderGeometry(geometry);
    expect(sent().filter(m => m.type === 'mouseButtons').at(-1)).toMatchObject({ fitToInsets: false });
    expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(viewerNode);
    expect(requests().filter(r => r.op === 'start')).toHaveLength(starts);
    expect(requests().filter(r => r.op === 'stop')).toHaveLength(stops);
  });
  it("rotation preserves the viewer and control lease", async () => {
    await connect();
    expect(button("back")).not.toBeNull();
    const viewer = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(button("back")).not.toBeNull();
    for (const angle of [90, -90]) {
      act(() =>
        fixture.message!({
          nativeEvent: { data: JSON.stringify({ type: "orientation", angle }) },
        }),
      );
      expect(button("back").disabled).toBe(false);
    }
    fixture.size = { width: 390, height: 844 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(button("back")).not.toBeNull();
    expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).toBe(
      viewer,
    );
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
  });
  it("does not request unsupported input and preserves permission failures", async () => {
    fixture.canControl = false;
    await connect();
    expect(requests().some((r) => r.op === "control")).toBe(false);
    expect(button("keyboard").disabled).toBe(true);
  });
  it("ends the lease and displays the permission guide when control is denied", async () => {
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "control"
        ? Promise.reject(new Error("DESKTOP_ACCESSIBILITY_PERMISSION"))
        : original(...args),
    );
    await connect();
    expect(requests()).toContainEqual({ op: "stop", lease: "lease" });
    expect(host.textContent).toContain("permission guide");
    expect(host.textContent).not.toContain("remoteDesktop.permissionHint");
    expect(sent()).not.toContainEqual({ type: "control", enabled: true });
  });
  it("does not restore control when its grant arrives after leaving", async () => {
    let resolve!: (value: unknown) => void;
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "control"
        ? new Promise((r) => {
            resolve = r;
          })
        : original(...args),
    );
    await connect();
    act(() => root.unmount());
    mounted = false;
    await act(async () => resolve({ controlling: true }));
    expect(requests()).toContainEqual({ op: "stop", lease: "lease" });
    expect(sent()).not.toContainEqual({ type: "control", enabled: true });
  });
  it("keeps portrait Back available before connection, while controlling and during recovery", async () => {
    expect(button("back").disabled).toBe(false);
    expect(button("connect")).toBeNull();
    await connect();
    expect(button("back").disabled).toBe(false);
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    expect(host.textContent).toContain("remoteDesktop.reconnecting");
    expect(host.textContent).toContain("My Mac");
    act(() => button("back").click());
    expect(goBackGuarded).toHaveBeenCalledTimes(1);
    fixture.status = "online";
    await act(async () => root.render(<RemoteDesktopScreen />));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await connect(); // Even a late WebView ready event cannot re-enter.
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it("automatically resumes after network loss and keeps view-only preference", async () => {
    await connect();
    act(() => button("operations").click());
    await act(async () => button("viewOnly").click());
    fixture.status = "offline";
    act(() => root.render(<RemoteDesktopScreen />));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    fixture.status = "online";
    await act(async () => root.render(<RemoteDesktopScreen />));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    expect(
      requests().filter((r) => r.op === "control" && r.enabled),
    ).toHaveLength(1);
    expect(fixture.openLink.mock.calls.every(([id]) => id === "computer")).toBe(
      true,
    );
  });
  it("keeps the lease during an interrupted iOS Home gesture", async () => {
    await connect();
    const starts = requests().filter((r) => r.op === "start").length;
    const stops = requests().filter((r) => r.op === "stop").length;
    act(() => {
      AppState.currentState = "inactive";
      fixture.appState!("inactive");
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(stops);
    expect(host.textContent).not.toContain("remoteDesktop.reconnecting");
    await act(async () => {
      AppState.currentState = "active";
      fixture.appState!("active");
    });
    expect(requests().filter((r) => r.op === "start")).toHaveLength(starts);
    expect(fixture.resetUnlockAttempt).not.toHaveBeenCalled();
  });
  it("retires an uncertain PiP transition instead of leaving a controlling UI with disabled input", async () => {
    await connect();
    act(() =>
      fixture.message!({
        nativeEvent: {
          data: JSON.stringify({
            type: "pipCapability",
            epoch: "lease",
            supported: true,
          }),
        },
      }),
    );
    let reject!: (cause: unknown) => void;
    const invoke = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((device, channel, args) =>
      args[0].op === "presentation"
        ? new Promise((_resolve, fail) => {
            reject = fail;
          })
        : invoke(device, channel, args),
    );
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toMatchObject({ enabled: true });
    await act(async () => reject({ code: "INVOKE_TIMEOUT" }));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    expect(fixture.playback).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    expect(
      sent()
        .filter((m) => m.type === "control")
        .at(-1),
    ).toMatchObject({ enabled: true });
  });
  it.each(["active", "background"])(
    "handles failed PiP in %s without keeping a hidden stream alive",
    async (state) => {
      fixture.systemAudio = true;
      await connect();
      expect(sent().find((m) => m.type === "init")).toMatchObject({
        audio: true,
      });
      act(() =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "presentation",
              epoch: "lease",
              active: true,
            }),
          },
        }),
      );
      act(() => {
        AppState.currentState = state as typeof AppState.currentState;
        fixture.appState!(state);
      });
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
      await act(async () =>
        fixture.message!({
          nativeEvent: {
            data: JSON.stringify({
              type: "presentationFailed",
              epoch: "lease",
            }),
          },
        }),
      );
      expect(requests().filter((r) => r.op === "stop")).toHaveLength(
        state === "background" ? 1 : 0,
      );
      if (state === "background") {
        expect(fixture.playback).toHaveBeenLastCalledWith(false);
        const count = requests().length;
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(requests()).toHaveLength(count);
        await act(async () => {
          AppState.currentState = "active";
          fixture.appState!("active");
        });
        expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
      }
    },
  );
  it("releases in background and reconnects only after foreground and focus return", async () => {
    await connect();
    expect(fixture.resetUnlockAttempt).not.toHaveBeenCalled();
    act(() => {
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(fixture.resetUnlockAttempt).toHaveBeenCalledTimes(1);
    fixture.focused = false;
    act(() => root.render(<RemoteDesktopScreen />));
    await act(async () => {
      AppState.currentState = "active";
      fixture.appState!("active");
    });
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    fixture.focused = true;
    await act(async () => root.render(<RemoteDesktopScreen />));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
  });
  it("backs off transient failures and cancels pending recovery when leaving", async () => {
    fixture.openLink.mockRejectedValue(new Error("DEVICE_OFFLINE"));
    await connect();
    expect(host.textContent).toContain("remoteDesktop.reconnecting");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fixture.openLink.mock.calls.length).toBeGreaterThan(1);
    expect(fixture.openLink.mock.calls.length).toBeLessThanOrEqual(6);
    const attempts = fixture.openLink.mock.calls.length;
    act(() => button("back").click());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.openLink).toHaveBeenCalledTimes(attempts);
  });
  it("restarts a crashed viewer automatically without restoring it after exit", async () => {
    await connect();
    act(() => fixture.crashed!());
    expect(host.textContent).toContain("remoteDesktop.reconnecting");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(fixture.reload).toHaveBeenCalledTimes(1);
    await connect();
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    act(() => button("back").click());
    act(() => fixture.crashed!());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fixture.reload).toHaveBeenCalledTimes(1);
  });
  it.each([
    "DESKTOP_STOPPED",
    "DESKTOP_DISABLED",
    "DESKTOP_ACCESSIBILITY_PERMISSION",
  ])("does not retry a terminal host decision: %s", async (error) => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "heartbeat"
        ? Promise.reject(new Error(error))
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    expect(button("back").disabled).toBe(false);
    if (error === "DESKTOP_STOPPED") {
      expect(fixture.alert).toHaveBeenCalledWith(
        "remoteDesktop.disconnected",
        "remoteDesktop.hostDisconnected",
      );
    }
  });
});
