// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RemoteDesktopScreen from "../RemoteDesktopScreen";
import { AppState } from "react-native";
import { goBackGuarded } from "@/utils/backGuard";

const fixture = vi.hoisted(() => ({
  platform: "ios",
  keyboardListeners: {} as Record<string, (event: unknown) => void>,
  views: {} as Record<string, any>,
  invoke: vi.fn(),
  apiFetch: vi.fn(),
  openLink: vi.fn(),
  post: vi.fn(),
  reload: vi.fn(),
  message: null as null | ((e: unknown) => void),
  size: { width: 390, height: 844 },
  canControl: true,
  systemAudio: false,
  playback: vi.fn(async (_enabled: boolean) => {}),
  trickleIce: false,
  focused: true,
  status: "online",
  appState: null as null | ((state: string) => void),
  crashed: null as null | (() => void),
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
    View: view("div"),
    Modal: (p: any) => p.visible ? createElement("div", {}, p.children) : null,
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
    Dimensions: { get: () => fixture.size },
    useWindowDimensions: () => fixture.size,
    Platform: { get OS() { return fixture.platform; } },
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
  useLocalSearchParams: () => ({ deviceId: "computer", deviceName: "My Mac" }),
}));
vi.mock("@/utils/backGuard", () => ({ goBackGuarded: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("../../../modules/cindy-remote-presentation/src", () => ({
  remotePresentation: { playback: fixture.playback, rotate: vi.fn(async () => {}) },
}));
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn(), setStringAsync: vi.fn() }));
vi.mock("@expo/ui/community/segmented-control", () => ({ default: () => null }));
vi.mock("@/platform/chrome/NativePullDownMenu", () => ({
  usesNativePullDownMenu: () => false, NativePullDownMenu: (p: any) => p.children,
}));
vi.mock("lucide-react-native", () => ({
  createLucideIcon: () => () => null,
  Clipboard: () => null,
  ArrowLeft: () => null,
  RotateCw: () => null,
  Volume2: () => null,
  VolumeX: () => null,
  PictureInPicture2: () => null,
  Check: () => null,
  ClipboardList: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  Eye: () => null,
  LogOut: () => null,
  Maximize: () => null,
  MousePointer2: () => null,
  Move: () => null,
  ChevronLeft: () => null,
  PanelsTopLeft: () => null,
  Monitor: () => null,
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
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: any) => make(tokens.lightColors),
  };
});
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({
    status: fixture.status,
    invoke: fixture.invoke,
    openLink: fixture.openLink,
  }),
}));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ apiFetch: fixture.apiFetch }) }));
vi.mock("@/config/env", () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test' }));
vi.mock("../PermissionGuide", () => ({
  PermissionGuide: (p: any) => {
    fixture.retryPermissions = p.reconnect;
    return createElement("span", {}, "permission guide");
  },
}));
vi.mock("react-native-webview", () => ({
  WebView: forwardRef((p: any, ref) => {
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

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
const display = { id: "display", width: 1920, height: 1080 };
const requests = () => fixture.invoke.mock.calls.map((call) => call[2][0]);
const sent = () => fixture.post.mock.calls.map(([data]) => JSON.parse(data));
const button = (key: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="remoteDesktop.${key}"]`)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  fixture.platform = "ios";
  fixture.views = {};
  fixture.keyboardListeners = {};
  vi.useFakeTimers();
  fixture.focused = true;
  fixture.status = "online";
  AppState.currentState = "active";
  fixture.canControl = true;
  fixture.trickleIce = false;
  fixture.size = { width: 390, height: 844 };
  fixture.openLink.mockResolvedValue({});
  fixture.apiFetch.mockReset().mockResolvedValue({ iceServers: [], expiresAt: null });
  fixture.systemAudio = false;
  fixture.playback.mockReset().mockResolvedValue(undefined);
  fixture.invoke.mockImplementation(async (_device, _channel, [request]) => {
    switch (request.op) {
      case "capabilities":
        return {
          version: 1,
          trickleIce: fixture.trickleIce,
          automaticReconnect: true,
          backgroundViewing: true,
          enabled: true,
          canControl: fixture.canControl,
          systemAudio: fixture.systemAudio,
          videoSettings: fixture.systemAudio,
          platform: "darwin",
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
    fixture.message!({ nativeEvent: { data: '{"type":"framePresented","epoch":"lease"}' } });
  });
};

describe("remote desktop controls", () => {
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
      { baseUrl: "https://relay.example.test", timeoutMs: 3000 },
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
  it("keeps video and control when playback fails without changing the sound preference", async () => {
    fixture.systemAudio = true;
    fixture.playback.mockImplementation(async (enabled) => { if (enabled) throw new Error("audio interrupted"); });
    await connect();
    expect(sent().find((m) => m.type === "init")).toMatchObject({ audio: false });
    expect(sent().find((m) => m.type === "control")).toMatchObject({ enabled: true });
    expect(fixture.playback).toHaveBeenLastCalledWith(false);
    await act(async () => {
      fixture.message!({ nativeEvent: { data: JSON.stringify({ type: "offer", epoch: "lease", sdp: "sdp", attemptId: "attempt" }) } });
    });
    expect(requests().find((r) => r.op === "offer").settings.audio).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    act(() => button("operations").click());
    expect(host.textContent).toContain("remoteDesktop.audioUnavailable");
    expect(button("sound").getAttribute("aria-selected")).toBe("true");
    fixture.playback.mockResolvedValue(undefined);
    await act(async () => button("sound").click());
    act(() => fixture.message!({ nativeEvent: { data: JSON.stringify({ type: "streaming", epoch: "lease" }) } }));
    await act(async () => button("sound").click());
    expect(sent().filter((m) => m.type === "videoSettings").at(-1)).toMatchObject({ audio: true });
    expect(host.textContent).not.toContain("remoteDesktop.audioUnavailable");
  });
  it("overlays landscape keyboards and includes their measured occlusion", async () => {
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    act(() => button("keyboard").click());
    expect(fixture.views["remoteDesktop.layout"].enabled).toBe(false);
    const panel = () => fixture.views["remoteDesktop.keyboardPanel"];
    expect(panel().style.flat(Infinity)).toContainEqual(expect.objectContaining({ position: "absolute" }));
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 60 } } }));
    act(() => fixture.keyboardListeners.keyboardWillChangeFrame({ endCoordinates: { screenY: 180 } }));
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 210 });
    expect(sent().filter((m) => m.type === "mouseButtons").at(-1)).toMatchObject({
      bottomInset: 270, keyboardOpen: true,
    });
    const computer = [...host.querySelectorAll("button")].find((element) => element.textContent === "remoteDesktop.computerKeyboard")!;
    act(() => computer.click());
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 280 } } }));
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 0 });
    expect(sent().filter((m) => m.type === "mouseButtons").at(-1)).toMatchObject({
      bottomInset: 280, keyboardOpen: true,
    });
    act(() => button("close").click());
    expect(sent().filter((m) => m.type === "mouseButtons").at(-1)).toMatchObject({
      bottomInset: 0, keyboardOpen: false,
    });
  });

  it("keeps Android native keyboard avoidance without adding its height twice", async () => {
    fixture.platform = "android";
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    await connect();
    act(() => button("keyboard").click());
    const panel = () => fixture.views["remoteDesktop.keyboardPanel"];
    act(() => fixture.keyboardListeners.keyboardDidShow({ endCoordinates: { screenY: 180 } }));
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 60 } } }));
    expect(panel().style.flat(Infinity)).not.toContainEqual(expect.objectContaining({ position: "absolute" }));
    expect(sent().filter((m) => m.type === "mouseButtons").at(-1)).toMatchObject({ bottomInset: 0, keyboardOpen: false });
    const computer = [...host.querySelectorAll("button")].find((element) => element.textContent === "remoteDesktop.computerKeyboard")!;
    act(() => computer.click());
    act(() => panel().onLayout({ nativeEvent: { layout: { height: 280 } } }));
    expect(panel().style.flat(Infinity)).toContainEqual({ bottom: 0 });
    expect(sent().filter((m) => m.type === "mouseButtons").at(-1)).toMatchObject({ bottomInset: 280, keyboardOpen: true });
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
    expect(host.querySelector('[data-testid="remoteDesktop.connectingStatus"]')).not.toBeNull();
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
    expect(host.querySelector('[data-testid="remoteDesktop.connectingStatus"]')).toBeNull();
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
  it.each([false, true])("shows media recovery without replacing the lease (landscape=%s)", async (landscape) => {
    if (landscape) {
      fixture.size = { width: 844, height: 390 };
      act(() => root.render(<RemoteDesktopScreen />));
    }
    await connect();
    const message = (type: string) => act(async () => {
      fixture.message!({ nativeEvent: { data: JSON.stringify({
        type, epoch: "lease", attemptId: "1", sdp: "offer",
      }) } });
    });
    await message("offer");
    await message("streaming");
    const ownership = () => requests().filter((r) => ["start", "control", "stop"].includes(r.op));
    const previousOwnership = [...ownership()];
    await message("reconnecting");
    const badge = () => host.querySelector('[data-testid="remoteDesktop.connectingStatus"]');
    expect(badge()?.textContent).toBe("remoteDesktop.reconnecting");
    expect(host.textContent).not.toContain("remoteDesktop.viewOnly");
    expect(host.querySelector('[data-testid="remoteDesktop.viewer"]')).not.toBeNull();
    expect(button("keyboard").disabled).toBe(false);
    expect(ownership()).toEqual(previousOwnership);
    await message("streaming");
    expect(badge()).toBeNull();
    expect(ownership()).toEqual(previousOwnership);
  });
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
      host.querySelector('[data-testid="remoteDesktop.network"]')!.textContent;
    expect(badge()).toContain("remoteDesktop.directConnection");
    expect(badge()).toContain("125 KB/s");
    expect(badge()).toContain("remoteDesktop.roundTrip");
    message({
      type: "network",
      epoch: "old-lease",
      transport: "relay",
      bytesPerSecond: 999000,
    });
    expect(badge()).toContain("remoteDesktop.directConnection");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(badge()).toContain("— KB/s");
    expect(badge()).not.toContain("remoteDesktop.roundTrip");
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
    expect(host.textContent).toContain("remoteDesktop.connecting");
    expect(host.textContent).not.toContain("remoteDesktop.screenshotRelay");
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "frame"
        ? Promise.resolve({ jpeg: "a".repeat(4000) })
        : original(...args),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain("remoteDesktop.screenshotRelay");
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
  });
  it.each([false, true])("bounds relay frames regardless of cursor overlay=%s", async (overlay) => {
    const original = fixture.invoke.getMockImplementation()!;
    let jpeg = "a".repeat(240_004);
    fixture.invoke.mockImplementation(async (...args) => {
      const op = args[2][0].op;
      if (op === "frame") return { jpeg, cursor: null };
      const result = await original(...args);
      return op === "capabilities" ? { ...result, cursorOverlay: overlay } : result;
    });
    await connect();
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(sent().filter((message) => message.type === "frame")).toHaveLength(0);
    jpeg = "a".repeat(240_000);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(sent().filter((message) => message.type === "frame")).toEqual([{ type: "frame", jpeg, cursor: null }]);
    expect(requests().filter((request) => request.op === "start")).toHaveLength(1);
  });
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
      host.querySelector('[data-testid="remoteDesktop.network"]')!.textContent;
    expect(badge()).toContain("remoteDesktop.screenshotRelay");
    expect(badge()).toContain("6 KB/s");
    expect(badge()).toContain("remoteDesktop.frameTime");
    expect(badge()).not.toContain("remoteDesktop.roundTrip");
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
  it("renews again after a lost heartbeat reply without replacing the live lease", async () => {
    await connect();
    const original = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((...args) =>
      args[2][0].op === "heartbeat"
        ? new Promise((_resolve, reject) => setTimeout(() => reject(
            Object.assign(new Error("INVOKE_TIMEOUT"), { code: "INVOKE_TIMEOUT" }),
          ), 5000))
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
  ])("stops automatic recovery for %s while retaining manual retry", async (code, hint) => {
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
        expect(host.textContent).not.toContain(`deviceLink.remoteError.${hint}`);
      }
    }
  });
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
  it("keeps explicit display switching available on older hosts", async () => {
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
    act(() => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("remoteDesktop.displaySettings"))!.click());
    await act(async () => button("display").click());
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="remoteDesktop.display.second"]',
        )!
        .click(),
    );
    expect(
      requests()
        .filter((r) => r.op === "start")
        .at(-1),
    ).toEqual({ op: "start", displayId: "second" });
    expect(host.textContent).not.toContain("remoteDesktop.upgrade");
  });
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
    await act(async () => button("connect").click());
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
    await act(async () => button("viewOnly").click());
    expect(
      sent()
        .filter((m) => m.type === "mode")
        .at(-1),
    ).toEqual({ type: "mode", mode: "pan" });
    expect(host.textContent).toContain("remoteDesktop.viewOnlyHint");
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
  it("shows virtual mouse buttons outside the panel and hides them while viewing only", async () => {
    await connect();
    act(() => button("operations").click());
    expect(button("rightClick")).toBeNull();
    act(() => button("showMouseButtons").click());
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
    expect(host.textContent).toContain("remoteDesktop.viewOnlyHint");
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
  it("rotation preserves the viewer and control lease", async () => {
    await connect();
    expect(button("back")).not.toBeNull();
    const viewer = host.querySelector('[data-testid="remoteDesktop.viewer"]');
    fixture.size = { width: 844, height: 390 };
    act(() => root.render(<RemoteDesktopScreen />));
    expect(button("back")).toBeNull();
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
    expect(host.textContent).not.toContain("My Mac");
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
  });
  it("retires an uncertain PiP transition instead of leaving a controlling UI with disabled input", async () => {
    await connect();
    act(() => fixture.message!({ nativeEvent: { data: JSON.stringify({ type: "pipCapability", epoch: "lease", supported: true }) } }));
    let reject!: (cause: unknown) => void;
    const invoke = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation((device, channel, args) => args[0].op === "presentation"
      ? new Promise((_resolve, fail) => { reject = fail; })
      : invoke(device, channel, args));
    act(() => button("operations").click());
    await act(async () => button("smallWindow").click());
    expect(sent().filter((m) => m.type === "control").at(-1)).toMatchObject({ enabled: true });
    await act(async () => reject({ code: "INVOKE_TIMEOUT" }));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(1);
    expect(fixture.playback).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(2);
    expect(sent().filter((m) => m.type === "control").at(-1)).toMatchObject({ enabled: true });
  });
  it.each(["active", "background"])("handles failed PiP in %s without keeping a hidden stream alive", async (state) => {
    fixture.systemAudio = true;
    await connect();
    expect(sent().find((m) => m.type === "init")).toMatchObject({ audio: true });
    act(() => fixture.message!({ nativeEvent: { data: JSON.stringify({ type: "presentation", epoch: "lease", active: true }) } }));
    act(() => {
      AppState.currentState = state as typeof AppState.currentState;
      fixture.appState!(state);
    });
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(0);
    await act(async () => fixture.message!({ nativeEvent: { data: JSON.stringify({ type: "presentationFailed", epoch: "lease" }) } }));
    expect(requests().filter((r) => r.op === "stop")).toHaveLength(state === "background" ? 1 : 0);
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
  });
  it("releases in background and reconnects only after foreground and focus return", async () => {
    await connect();
    act(() => {
      AppState.currentState = "background";
      fixture.appState!("background");
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests().filter((r) => r.op === "start")).toHaveLength(1);
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
  });
});
