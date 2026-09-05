// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_ACTIVITY_CHANNEL } from "@cindy/device-link";
import { SessionListDrawer } from "@/session/SessionListDrawer";
import { remoteSessionStore } from "@/session/remoteSessionStore";
import { buildMobileHomePresentation } from "@/session/mobileHome";
import { buildRemoteSessionCardPreview } from "@/session/sessionList";
import { i18n } from "@/i18n";
import type { HomeRow, HomeSection } from "@/session/homeSections";
import type { RemoteMessage, RemoteSession } from "@/session/types";

// Keep React, the store, search hook and presentation real. Only native views/gestures are
// replaced: assertions observe committed rows and count actual presentation executions.
const native = vi.hoisted(() => ({
  sections: [] as HomeSection[],
  search: { query: "", onChangeQuery: (_value: string) => {} },
  invoke: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
    accessibilityState?: { selected?: boolean };
    ref?: import("react").Ref<HTMLDivElement>;
  };
  const View = ({
    children,
    testID,
    onPress,
    accessibilityState,
    ref,
  }: Props) =>
    createElement(
      "div",
      {
        "data-testid": testID,
        onClick: onPress,
        "aria-selected": accessibilityState?.selected,
        ref,
      },
      children,
    );
  return {
    View,
    Pressable: View,
    SectionList: ({
      sections,
      renderItem,
    }: {
      sections: HomeSection[];
      renderItem: (info: { item: HomeRow }) => ReactNode;
    }) => {
      native.sections = sections;
      return createElement(
        "div",
        {},
        sections.flatMap((section) =>
          section.data.map((item) =>
            createElement("div", { key: item.key }, renderItem({ item })),
          ),
        ),
      );
    },
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    findNodeHandle: () => null,
    StyleSheet: {
      create: (value: unknown) => value,
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (values: Record<string, unknown>) => values.ios ?? values.default,
    },
  };
});
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const { View } = await import("react-native");
  return {
    default: { View },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: () => ({}),
    Easing: { bezier: () => undefined },
    cancelAnimation() {},
    runOnJS: (fn: unknown) => fn,
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value,
  };
});
vi.mock("@/platform/gestureHandler", () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const chain = {
        activeOffsetX: () => chain,
        failOffsetX: () => chain,
        failOffsetY: () => chain,
        onUpdate: () => chain,
        onEnd: () => chain,
      };
      return chain;
    },
  },
}));
vi.mock("lucide-react-native", () => ({
  House: () => null,
  LoaderCircle: () => null,
  SquarePen: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, top: 0, bottom: 0 }),
}));
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).View,
}));
vi.mock("@/theme", () => ({
  useThemedStyles: () => ({}),
  useTheme: () => ({ colors: {} }),
}));
vi.mock("@/hooks/useReduceMotion", () => ({
  useReduceMotionEnabled: () => true,
}));
vi.mock("@/session/HomeSearchBar", () => ({
  HomeSearchBar: (props: typeof native.search) => {
    native.search = props;
    return null;
  },
}));
vi.mock("@/session/ConversationSearchFilterSheet", () => ({
  ConversationSearchFilterSheet: () => null,
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: native.invoke }),
}));
vi.mock("@/session/mobileHome", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/session/mobileHome")>();
  return {
    ...original,
    buildMobileHomePresentation: vi.fn(original.buildMobileHomePresentation),
  };
});
vi.mock("@/session/sessionList", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/session/sessionList")>();
  return {
    ...original,
    buildRemoteSessionCardPreview: vi.fn(
      original.buildRemoteSessionCardPreview,
    ),
  };
});

function session(
  id: string,
  patch: Partial<RemoteSession> = {},
): RemoteSession {
  return {
    id,
    userId: "user",
    title: id,
    workingDir: "/repo",
    workspaceKind: "project",
    model: "claude",
    effort: "medium",
    permissionMode: "default",
    fastMode: false,
    status: "active",
    agentKind: "cc",
    userSendAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  };
}

function message(sessionId: string, content: string): RemoteMessage {
  return {
    id: `m-${sessionId}`,
    clientId: `m-${sessionId}`,
    sessionId,
    role: "assistant",
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: "2026-09-01T00:00:01.000Z",
  };
}

function delta(sessionId: string, text: string) {
  remoteSessionStore.applyRemotePush("dev-1", "maker:event", {
    sessionId,
    persistId: `live-${sessionId}`,
    event: { type: "text", data: { text, isFinal: false } },
  });
}

describe("drawer selective updates", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onSelect = vi.fn();
  const onClosed = vi.fn();
  const props = {
    currentSessionId: "s1",
    onClose() {},
    onClosed,
    onGoHome() {},
    onNewSession() {},
    onSelectSession: onSelect,
    open: true,
    width: 360,
  };
  const render = async (open = true) => {
    await act(async () =>
      root.render(<SessionListDrawer {...props} open={open} />),
    );
  };
  const row = (id: string) =>
    container.querySelector(`[data-testid="sessionDrawer.row.${id}"]`);
  const status = (id: string, value: string) =>
    container.querySelector(
      `[data-testid="sessionDrawer.rowStatus.${value}.${id}"]`,
    );
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    remoteSessionStore.clear();
    native.invoke
      .mockReset()
      .mockResolvedValue({
        query: "needle",
        results: [],
        vectorUsed: false,
        vectorSkipReason: null,
        poolCapped: false,
      });
    onSelect.mockClear();
    onClosed.mockClear();
    await i18n.changeLanguage("zh-CN");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    remoteSessionStore.setDeviceIdentity([
      { deviceId: "dev-1", name: "Studio" },
    ]);
    remoteSessionStore.setConversationSearchDeviceModels([
      { deviceId: "dev-1", name: "Studio", canOpen: true, state: "ready" },
    ]);
    remoteSessionStore.setDeviceSessions("dev-1", "Studio", [
      session("s1"),
      session("s2"),
    ]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    remoteSessionStore.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("updates only the changed preview without rebuilding sections, including a parent rerender", async () => {
    remoteSessionStore.setDeviceSessions(
      "dev-1",
      "Studio",
      Array.from({ length: 40 }, (_, i) => session(`s${i + 1}`)),
    );
    remoteSessionStore.setMessages("s2", [message("s2", "unchanged preview")]);
    await render();
    const sections = native.sections;
    vi.mocked(buildMobileHomePresentation).mockClear();
    vi.mocked(buildRemoteSessionCardPreview).mockClear();
    await act(async () => delta("s1", "first"));
    await tick(100);
    await act(async () => delta("s1", " second"));
    await tick(100);
    for (let index = 0; index < 98; index += 1) {
      await act(async () => delta("s1", "."));
      await tick(100);
    }
    expect(row("s1")?.textContent).toContain("first second");
    expect(row("s2")?.textContent).toContain("unchanged preview");
    expect(native.sections).toBe(sections);
    expect(buildMobileHomePresentation).not.toHaveBeenCalled();
    expect(buildRemoteSessionCardPreview).toHaveBeenCalled();
    expect(
      vi
        .mocked(buildRemoteSessionCardPreview)
        .mock.calls.every(([item]) => item.session.id === "s1"),
    ).toBe(true);
    await render(); // The surrounding session screen itself still renders while streaming.
    expect(buildMobileHomePresentation).not.toHaveBeenCalled();
    expect(native.sections).toBe(sections);
  });

  it("falls back to the host preview when loaded messages are cleared", async () => {
    remoteSessionStore.setDeviceSessions("dev-1", "Studio", [
      session("s1", { preview: "host preview" }),
      session("s2"),
    ]);
    await render();
    expect(row("s1")?.textContent).toContain("host preview");
    await act(async () =>
      remoteSessionStore.setMessages("s1", [message("s1", "loaded preview")]),
    );
    expect(row("s1")?.textContent).toContain("loaded preview");
    await act(async () => remoteSessionStore.setMessages("s1", []));
    expect(row("s1")?.textContent).toContain("host preview");
    expect(row("s1")?.textContent).not.toContain("loaded preview");
  });

  it("keeps pending, running, error and completed indicators current", async () => {
    await render();
    await act(async () => remoteSessionStore.setSessionRunning("s1", true));
    expect(status("s1", "running")).not.toBeNull();
    await act(async () =>
      remoteSessionStore.setPendingInteractions("s1", [
        { request: { kind: "permission", requestId: "p1" } },
      ]),
    );
    expect(status("s1", "awaiting")).not.toBeNull();
    await act(async () => remoteSessionStore.setPendingInteractions("s1", []));
    expect(status("s1", "running")).not.toBeNull();
    for (const [phase, rightStatus] of [
      ["error", "error"],
      ["completed", "done"],
    ] as const) {
      await act(async () =>
        remoteSessionStore.applyRemotePush("dev-1", SESSION_ACTIVITY_CHANNEL, {
          sessionId: "s1",
          phase,
          compactDetail: phase,
          attention: true,
        }),
      );
      expect(status("s1", rightStatus)).not.toBeNull();
    }
  });

  it("changes an automation group primary and its click target when an older run needs attention", async () => {
    remoteSessionStore.setDeviceSessions("dev-1", "Studio", [
      session("old", { source: "scheduler", title: "daily" }),
      session("new", {
        source: "scheduler",
        title: "daily",
        updatedAt: "2026-09-02T00:00:00.000Z",
      }),
    ]);
    // Schedule histories are intentionally retained only while their detail is in use.
    remoteSessionStore.enterSessionMessageDetail("old");
    remoteSessionStore.enterSessionMessageDetail("new");
    remoteSessionStore.setMessages("old", [message("old", "older run")]);
    remoteSessionStore.setMessages("new", [message("new", "newer run")]);
    await render();
    expect(row("new")?.textContent).toContain("newer run");
    await act(async () =>
      remoteSessionStore.setPendingInteractions("old", [
        { request: { kind: "ask_user_question", requestId: "question" } },
      ]),
    );
    expect(row("new")).toBeNull();
    expect(status("old", "awaiting")).not.toBeNull();
    await act(async () => (row("old") as HTMLElement).click());
    expect(onSelect.mock.calls.at(-1)?.[0].session.id).toBe("old");
    await act(async () => remoteSessionStore.setPendingInteractions("old", []));
    expect(row("new")?.textContent).toContain("newer run");
  });

  it("refreshes device search reachability without a session-array change", async () => {
    remoteSessionStore.setConversationSearchDeviceModels([
      { deviceId: "dev-1", name: "Studio", canOpen: false, state: "offline" },
    ]);
    await render();
    await act(async () => native.search.onChangeQuery("needle"));
    await tick(300);
    expect(native.invoke).not.toHaveBeenCalled();
    const sessions = remoteSessionStore.getSessions();
    await act(async () =>
      remoteSessionStore.setConversationSearchDeviceModels([
        { deviceId: "dev-1", name: "Studio", canOpen: true, state: "ready" },
      ]),
    );
    expect(remoteSessionStore.getSessions()).toBe(sessions);
    await tick(300);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls[0].slice(0, 2)).toEqual([
      "dev-1",
      "local-db:conversations:search",
    ]);
  });

  it("refreshes device identity even when no session changes, with a stable empty snapshot", async () => {
    remoteSessionStore.clear();
    expect(remoteSessionStore.getDeviceIdentity()).toBe(
      remoteSessionStore.getDeviceIdentity(),
    );
    await render();
    const sessions = remoteSessionStore.getSessions();
    vi.mocked(buildMobileHomePresentation).mockClear();
    await act(async () =>
      remoteSessionStore.setDeviceIdentity([
        { deviceId: "empty-device", name: "Renamed" },
      ]),
    );
    expect(remoteSessionStore.getSessions()).toBe(sessions);
    expect(
      vi.mocked(buildMobileHomePresentation).mock.calls.at(-1)?.[0].devices,
    ).toEqual([{ deviceId: "empty-device", name: "Renamed" }]);
  });

  it("matches loaded text during search debounce without restarting the indexed request on each delta", async () => {
    await render();
    await act(async () => native.search.onChangeQuery("needle"));
    expect(row("s1")).toBeNull();
    await tick(100);
    await act(async () => delta("s1", "needle"));
    await tick(100);
    expect(row("s1")?.textContent).toContain("needle");
    await act(async () => delta("s1", " more"));
    await tick(100);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    await tick(300);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves indexed hit snippets and message focus while newer loaded messages arrive", async () => {
    const contentHit = {
      messageClientId: "hit-message",
      preview: "needle in old message",
      role: "assistant",
      createdAt: "2026-09-01T00:00:01.000Z",
    };
    native.invoke.mockResolvedValue({
      query: "needle",
      results: [
        {
          session: session("s1"),
          matchKind: "content",
          titleMatchIndices: [],
          titleScore: 0,
          contentHit,
          contentHits: [contentHit],
          rankScore: 10,
        },
      ],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });
    remoteSessionStore.setMessages("s1", [
      message("s1", "latest unrelated message"),
    ]);
    await render();
    await act(async () => native.search.onChangeQuery("needle"));
    await tick(300);
    expect(row("s1")?.textContent).toContain("needle in old message");
    await act(async () =>
      remoteSessionStore.setMessages("s1", [
        message("s1", "even newer unrelated message"),
      ]),
    );
    expect(row("s1")?.textContent).toContain("needle in old message");
    await act(async () => (row("s1") as HTMLElement).click());
    expect(onSelect.mock.calls.at(-1)?.[0].searchFocusClientId).toBe(
      "hit-message",
    );
  });

  it("reads current previews when reopened and keeps the active selection and close callback", async () => {
    await render();
    await render(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    vi.mocked(buildMobileHomePresentation).mockClear();
    await act(async () => delta("s1", "received while closed"));
    await tick(100);
    expect(row("s1")).toBeNull();
    expect(buildMobileHomePresentation).not.toHaveBeenCalled();
    await render();
    expect(row("s1")?.textContent).toContain("received while closed");
    expect(row("s1")?.getAttribute("aria-selected")).toBe("true");
  });
});
