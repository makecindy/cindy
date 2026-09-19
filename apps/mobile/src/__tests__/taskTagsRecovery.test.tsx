// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  compact: null as any,
  input: null as any,
  onCatalog: null as any,
  context: {
    status: "online",
    connectionEpoch: 1,
    recoveringDeviceIds: new Set<string>(),
    getPresenceAvailability: () => true,
  },
}));
vi.mock("react-native", () => ({
  View: ({ children }: any) => <div>{children}</div>,
  ScrollView: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => (
    <button
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => <span>{children}</span>,
  TextInput: (props: any) => {
    h.input = props;
    return <input readOnly value={props.value} />;
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: any) => <div>{children}</div> },
  useSharedValue: (value: any) => ({ value }),
  useAnimatedStyle: () => ({}),
  runOnJS: (fn: any) => fn,
  withTiming: (v: any) => v,
  cancelAnimation: vi.fn(),
  ReduceMotion: { System: "system" },
}));
vi.mock("@/platform/gestureHandler", () => {
  const builder: any = new Proxy({}, { get: () => () => builder });
  return {
    Gesture: { Pan: () => builder },
    GestureDetector: ({ children }: any) => children,
  };
});
vi.mock("lucide-react-native", () => ({
  GripVertical: () => null,
  Pencil: () => null,
  MoreHorizontal: () => null,
  ArrowLeft: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "owner" } }),
}));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), iconSize: {} }));
vi.mock("@expo/ui/swift-ui", () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return {
    Group: Container,
    HStack: Container,
    ZStack: Container,
    RNHostView: Container,
    Text: Container,
    Image: () => null,
    Button: ({ children, onPress, modifiers }: any) => (
      <button
        aria-label={
          modifiers.find((m: any) => m.accessibilityLabel)?.accessibilityLabel
        }
        disabled={modifiers.some((m: any) => m.disabled)}
        onClick={onPress}
      >
        {children}
      </button>
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  ...Object.fromEntries(
    [
      "accessibilityAddTraits",
      "accessibilityLabel",
      "buttonStyle",
      "contentShape",
      "disabled",
      "foregroundStyle",
      "onGeometryChange",
      "frame",
      "listRowInsets",
    ].map((k) => [k, (v: any) => ({ [k]: v })]),
  ),
  shapes: { rectangle: () => ({}) },
}));
vi.mock("@/session/SessionDetailsNative", () => ({
  SessionDetailsNativeHeading: () => null,
}));
vi.mock("@/session/ComposerSheet", () => ({ ComposerSheet: () => null }));
vi.mock("@/session/ComposerNativeSection", () => ({
  ComposerNativeSection: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/session/ComposerNativeRow", () => ({
  ComposerNativeRow: () => null,
}));
vi.mock("@/session/SessionActionSheet", () => ({
  SessionActionSheet: () => null,
}));
vi.mock("@/session/swipeRowRegistry", () => ({
  buildSessionActionMenu: () => [],
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ ...h.context, invoke: h.invoke }),
  subscribeRemoteTaskTagsChanged: (callback: any) => {
    h.onCatalog = callback;
    return () => {
      h.onCatalog = null;
    };
  },
}));
vi.mock("@/session/remoteSessionStore", () => ({
  remoteSessionStore: {
    getSessions: () => [],
    getSessionDeviceId: () => "host",
    subscribe: () => () => {},
  },
  useRemoteSessions: () => [],
}));
import { TaskTagsPanel, TaskTagDots } from "@/session/TaskTags";
import { NativeTagShortcuts } from "@/session/SessionOptionsExpoSheet";
import {
  evictTaskTagCatalog,
  readTaskTagCatalog,
  resetTaskTagCatalogCache,
} from "@/session/taskTagCatalogCache";
const tag = {
  id: "tag",
  name: "Work",
  color: "red" as const,
  revision: 1,
  favoriteOrder: null,
};
let root: ReturnType<typeof createRoot>;
let node: HTMLDivElement;
const session = { id: "task", tags: [], canonicalDeviceId: "host" } as any;
const onExpandedChange = vi.fn();
const render = async () =>
  act(async () =>
    root.render(
      <TaskTagsPanel
        session={session}
        expanded={false}
        onExpandedChange={onExpandedChange}
        renderCompact={(state) => {
          h.compact = state;
          return <NativeTagShortcuts state={state} />;
        }}
      />,
    ),
  );
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetTaskTagCatalogCache();
  onExpandedChange.mockClear();
  h.context.status = "online";
  h.context.connectionEpoch = 1;
  h.context.recoveringDeviceIds.clear();
  h.invoke.mockReset().mockResolvedValue({ tags: [tag], sessions: [] });
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(() => act(() => root.unmount()));
it.each(["other", "host", "account"])(
  "scopes in-flight catalog invalidation to %s",
  async (scope) => {
    let finish!: (value: any) => void;
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    if (scope === "account") resetTaskTagCatalogCache();
    else evictTaskTagCatalog(scope);
    await act(async () => finish({ tags: [tag], sessions: [] }));
    expect(h.compact.tags.map((item: any) => item.id)).toEqual(
      scope === "other" ? [tag.id] : [],
    );
    expect(readTaskTagCatalog("owner", "host")?.tags).toEqual(
      scope === "other" ? [tag] : undefined,
    );
    h.context.connectionEpoch++;
    await render();
    expect(h.compact.tags.map((item: any) => item.id)).toEqual([tag.id]);
  },
);
it.each(["other", "host", "account"])(
  "scopes late catalog errors to %s",
  async (scope) => {
    let fail!: (error: Error) => void;
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    await render();
    if (scope === "account") resetTaskTagCatalogCache();
    else evictTaskTagCatalog(scope);
    await act(async () => fail(new Error("OFFLINE")));
    expect(h.compact.message).toBe(
      scope === "other" ? "taskTags.offline" : undefined,
    );
  },
);
it.each([false, true])(
  "preserves drafts across catalog pushes (external recolor: %s)",
  async (recolored) => {
    await act(async () =>
      root.render(
        <TaskTagsPanel
          session={session}
          expanded
          onExpandedChange={() => {}}
        />,
      ),
    );
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>(
          'button[aria-label="taskTags.editLabel"]',
        )!
        .click(),
    );
    await act(async () => h.input.onChangeText("My draft"));
    await act(async () =>
      h.onCatalog("host", [
        { ...tag, revision: 2, color: recolored ? "blue" : "red" },
      ]),
    );
    expect(h.input.value).toBe("My draft");
    const save = Array.from(node.querySelectorAll("button")).find(
      (b) => b.textContent === "taskTags.save",
    )!;
    await act(async () => save.click());
    expect(h.invoke.mock.calls.at(-1)![2][0]).toEqual({
      action: "update",
      tagId: tag.id,
      revision: recolored ? 1 : 2,
      name: "My draft",
      color: "red",
    });
  },
);
it("refreshes only after the target peer recovers and retains cached offline navigation", async () => {
  await render();
  h.context.recoveringDeviceIds.add("other");
  await render();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  h.context.recoveringDeviceIds.add("host");
  await render();
  expect(h.compact.disabled).toBe(true);
  expect(h.compact.canManage).toBe(true);
  expect(h.compact.tags).toHaveLength(1);
  const manage = () =>
    node.querySelector<HTMLButtonElement>(
      'button[aria-label="taskTags.title"]',
    )!;
  expect(manage().disabled).toBe(false);
  expect(
    node.querySelector<HTMLButtonElement>('button[aria-label="Work"]')!
      .disabled,
  ).toBe(true);
  await act(async () => manage().click());
  expect(onExpandedChange).toHaveBeenCalledWith(true);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  h.context.recoveringDeviceIds.delete("host");
  await render();
  expect(h.invoke).toHaveBeenCalledTimes(2);
  h.context.connectionEpoch++;
  await render();
  expect(h.invoke).toHaveBeenCalledTimes(3);
  h.context.status = "offline";
  await render();
  expect(h.compact.canManage).toBe(true);
  expect(manage().disabled).toBe(false);
});
it("does not expose native management when offline without a catalog", async () => {
  h.context.status = "offline";
  await render();
  expect(node.querySelector('button[aria-label="taskTags.title"]')).toBeNull();
});
it("discards the request from before peer recovery", async () => {
  let finish!: (value: any) => void;
  h.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  h.context.recoveringDeviceIds.add("host");
  await render();
  h.context.recoveringDeviceIds.delete("host");
  await render();
  await act(async () =>
    finish({ tags: [{ ...tag, name: "Stale" }], sessions: [] }),
  );
  expect(h.compact.tags[0].name).toBe("Work");
});
it("renders every dot when the optional visible limit is omitted", async () => {
  await act(async () =>
    root.render(
      <TaskTagDots tags={[tag, { ...tag, id: "two", name: "Life" }]} />,
    ),
  );
  expect(node.querySelectorAll("div")).toHaveLength(4);
});

it("retries a committed attachment whose response was lost without updating a stale revision", async () => {
  let fail = true;
  h.invoke.mockImplementation(async (_device, _channel, [request]) => {
    if (request.action === "update") throw new Error("CONFLICT");
    if (request.action === "attach" && fail) {
      fail = false;
      throw new Error("timeout");
    }
    return { tags: request.action === "get" ? [] : [tag], sessions: [] };
  });
  await act(async () =>
    root.render(
      <TaskTagsPanel session={session} expanded onExpandedChange={() => {}} />,
    ),
  );
  const click = async (label: string) => {
    const button = Array.from(node.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    )!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
  };
  await click("taskTags.add");
  await act(async () => h.input.onChangeText("Work"));
  await click("taskTags.create");
  expect(h.input.editable).toBe(false);
  await click("taskTags.save");
  const actions = h.invoke.mock.calls.map((call) => call[2][0].action);
  expect(actions).toEqual(["get", "create", "attach", "attach"]);
  expect(node.querySelector("input")).toBeNull();
});
