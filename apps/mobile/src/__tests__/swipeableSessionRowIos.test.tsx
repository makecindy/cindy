// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwipeableProps } from "@/platform/gestureHandler";
import type { RemoteSession } from "@/session/types";
import { SwipeableSessionRow } from "@/session/SwipeableSessionRow.ios";

const runtime = vi.hoisted(() => ({
  rowWidth: 400,
  translation: { value: 0 },
  props: null as SwipeableProps | null,
  reset: vi.fn(),
  close: vi.fn(),
  timing: vi.fn((value: number) => value),
  reactions: new Set<() => void>(),
  styles: [] as Array<() => Record<string, unknown>>,
}));
vi.mock("react-native", () => ({
  View: ({ children, onLayout }: { children?: React.ReactNode; onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void }) => {
    const width = runtime.rowWidth;
    React.useLayoutEffect(() => onLayout?.({ nativeEvent: { layout: { width } } }), [onLayout, width]);
    return <div>{children}</div>;
  },
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button onClick={onPress} data-testid={testID}>
      {children}
    </button>
  ),
  StyleSheet: { create: (value: unknown) => value },
  Dimensions: { get: () => ({ width: 900 }), addEventListener: () => ({ remove() {} }) },
}));
vi.mock("@/platform/gestureHandler", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    SwipeDirection: { LEFT: "left", RIGHT: "right" },
    ReanimatedSwipeable: forwardRef((props: SwipeableProps, ref) => {
      runtime.props = props;
      useImperativeHandle(ref, () => ({
        reset: () => {
          runtime.reset();
          runtime.translation.value = 0;
        },
        close: runtime.close,
      }));
      // RNGH renders actions before the parent's passive recycling effect.
      return (
        <>
          {props.renderLeftActions?.(
            { value: 0 } as never,
            runtime.translation as never,
            {} as never,
          )}
          {props.renderRightActions?.(
            { value: 0 } as never,
            runtime.translation as never,
            {} as never,
          )}
          {props.children}
        </>
      );
    }),
  };
});
vi.mock("react-native-reanimated", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    default: {
      View: ({ children }: { children?: React.ReactNode }) => (
        <div>{children}</div>
      ),
    },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (fn: () => Record<string, unknown>) => {
      useEffect(() => {
        runtime.styles.push(fn);
        return () => { runtime.styles = runtime.styles.filter((style) => style !== fn); };
      }, [fn]);
      return {};
    },
    useAnimatedReaction: (
      prepare: () => boolean,
      react: (next: boolean, prev: boolean | null) => void,
    ) => {
      const callback = useRef({ prepare, react });
      callback.current = { prepare, react };
      useEffect(() => {
        let previous: boolean | null = null;
        const step = () => {
          const next = callback.current.prepare();
          if (next !== previous) callback.current.react(next, previous);
          previous = next;
        };
        runtime.reactions.add(step);
        step();
        return () => {
          runtime.reactions.delete(step);
        };
      }, []);
    },
    withTiming: runtime.timing,
    interpolate: (x: number, [a, b]: number[], [c, d]: number[]) =>
      c + (d - c) * Math.max(0, Math.min(1, (x - a) / (b - a))),
  };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "Check",
      "CircleDashed",
      "Archive",
      "ArchiveRestore",
      "Ellipsis",
      "Clock",
      "Pin",
      "PinOff",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/session/listDisclosureTransition", () => ({
  useDisclosurePrepare: () => () => {},
}));
vi.mock("@/session/swipeRowRegistry", () => ({
  pinToggleAction: () => ({ label: "pin" }),
  statusToggleAction: () => ({ label: "archive", action: "archive" }),
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/theme", () => ({
  fontWeight: { medium: "500" },
  iconSize: { swipeAction: 24 },
  iconStroke: { regular: 2 },
  textStyles: { body: { fontSize: 16, lineHeight: 22 } },
  useTheme: () => ({ colors: {} }),
  useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));
vi.mock("@/theme/tokens", () => ({
  radius: { pill: 9999 },
  spacing: { sm: 8, md: 12, lg: 16 },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const controls = {
  onMarkRead: vi.fn(),
  onArchive: vi.fn(),
  onTogglePin: vi.fn(),
  onShowOptions: vi.fn(),
  registry: { onRowOpen: vi.fn(), onRowClose: vi.fn(), closeOpenRow: vi.fn() },
};
function render(id: string) {
  act(() =>
    root.render(
      <SwipeableSessionRow
        {...controls}
        testID="swipe"
        session={{ id, status: "active" } as RemoteSession}
      >
        row
      </SwipeableSessionRow>,
    ),
  );
}
function drag(value: number) {
  runtime.translation.value = value;
  runtime.reactions.forEach((step) => step());
}
function release(direction: "left" | "right") {
  act(() => runtime.props?.onSwipeableWillOpen?.(direction as never));
}
beforeEach(() => {
  vi.clearAllMocks();
  runtime.rowWidth = 400;
  runtime.translation.value = 0;
  runtime.styles = [];
  runtime.reactions.clear();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

describe("iOS swipe runtime contracts (mocked native boundary)", () => {
  // #7083: refreshed row objects and rotation must not rebuild RNGH's worklet
  // graph. Existing release tests do not compare the native callback boundary.
  it("keeps gesture callbacks stable while using the current width and recycled task", () => {
    render("a");
    const initial = runtime.props!;
    render("a");
    expect(runtime.props!.onSwipeableWillOpen).toBe(initial.onSwipeableWillOpen);
    runtime.rowWidth = 800;
    render("b");
    expect(runtime.props!.onSwipeableWillOpen).toBe(initial.onSwipeableWillOpen);
    expect(runtime.props!.onSwipeableOpenStartDrag).toBe(initial.onSwipeableOpenStartDrag);
    expect(runtime.props!.onSwipeableClose).toBe(initial.onSwipeableClose);
    drag(-260);
    release("left");
    expect(controls.onArchive).not.toHaveBeenCalled();
    drag(-500);
    release("left");
    expect(controls.onArchive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "b" }));
  });
  // Unit regression: a 320-point floating row inside a 900-point window.
  it("arms and archives at 55% of the floating row", () => {
    runtime.rowWidth = 320;
    render("a");
    drag(-175);
    release("left");
    expect(runtime.timing).not.toHaveBeenCalled();
    expect(controls.onArchive).not.toHaveBeenCalled();
    drag(-176);
    expect(runtime.timing).toHaveBeenCalledWith(1, expect.anything());
    release("left");
    expect(controls.onArchive).toHaveBeenCalledOnce();
  });
  // Unit regression: a narrow row settles beyond 55% when its action panel opens.
  it.each([
    ["left", -1, "onArchive"],
    ["right", 1, "onMarkRead"],
  ] as const)("keeps the %s panel unarmed when it settles on a 240-point row", (direction, sign, action) => {
    runtime.rowWidth = 240;
    render("a");
    drag(sign * 100);
    release(direction);
    drag(sign * 148); // The native panel settles after release.
    drag(sign * 159);
    release(direction);
    expect(runtime.timing).not.toHaveBeenCalledWith(1, expect.anything());
    expect(controls[action]).not.toHaveBeenCalled();
    drag(sign * 160);
    expect(runtime.timing).toHaveBeenCalledWith(1, expect.anything());
    release(direction);
    expect(controls[action]).toHaveBeenCalledOnce();
  });
  it.each([
    ["left", -260, "onArchive"],
    ["right", 260, "onMarkRead"],
  ] as const)(
    "full swipe still works after slot recycling: %s",
    (direction, value, action) => {
      render("a");
      drag(value);
      render("b");
      expect(runtime.reset).toHaveBeenCalledOnce();
      expect(runtime.translation.value).toBe(0);
      expect(controls.registry.onRowClose).toHaveBeenCalledWith(expect.stringMatching(/:a$/));
      drag(value);
      release(direction);
      expect(controls[action]).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "b" }),
      );
    },
  );
  it.each([
    ["left", -260, -100],
    ["right", 260, 100],
  ] as const)(
    "uses release position after dragging back: %s",
    (direction, peak, end) => {
      render("a");
      drag(peak);
      drag(end);
      release(direction);
      expect(controls.onArchive).not.toHaveBeenCalled();
      expect(controls.onTogglePin).not.toHaveBeenCalled();
      expect(controls.onMarkRead).not.toHaveBeenCalled();
    },
  );
  // User-requested contract: full swipe reads; pin remains a separate tap. Unit at native boundary.
  it.each([
    ["pinAction", "onTogglePin"],
    ["readAction", "onMarkRead"],
  ] as const)("tapping %s only executes its own action", (button, action) => {
    render("a");
    act(() =>
      (
        host.querySelector(
          `[data-testid="swipe.${button}"]`,
        ) as HTMLButtonElement
      ).click(),
    );
    expect(controls[action]).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "a" }),
    );
    expect(
      controls[action === "onMarkRead" ? "onTogglePin" : "onMarkRead"],
    ).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  // 2026-11-20 用户要求:两个方向拉长后的胶囊都要有文字,文案即该动作的名称。
  it("labels both stretched capsules with their action names", () => {
    render("a");
    const label = (button: string) =>
      host.querySelector(`[data-testid="swipe.${button}"] span`)?.textContent;
    expect(label("readAction")).toBe("session.row.markRead");
    expect(label("archiveAction")).toBe("archive");
    expect(host.querySelector('[data-testid="swipe.pinAction"] span')).toBeNull();
    expect(host.querySelector('[data-testid="swipe.optionsAction"] span')).toBeNull();
  });
  // 2026-11-20 用户要求:中间态不留空——拉过面板宽度、未到全滑阈值(400 宽屏为 220)时,
  // 主按钮跟着拉长到次按钮旁边:200 - 3 个间距(36) - 次按钮(56) = 108。
  it.each([200, -200])("stretches the primary action beside the secondary one before arming: %s", (value) => {
    render("a");
    drag(value);
    const widths = runtime.styles.map((fn) => fn().width);
    expect(widths).toContain(108);
    expect(widths).not.toContain(176);
    expect(runtime.timing).not.toHaveBeenCalled();
  });
  it("keeps layout width responsive in both directions and resets the armed state", () => {
    render("a");
    expect(runtime.timing).not.toHaveBeenCalled();
    drag(260);
    expect(
      runtime.styles.map((fn) => fn()).find((s) => s.width === 236),
    ).toBeDefined();
    drag(-260);
    expect(
      runtime.styles.map((fn) => fn()).find((s) => s.width === 236),
    ).toBeDefined();
    drag(-100);
    expect(
      runtime.styles.map((fn) => fn()).filter((s) => s.width === 56),
    ).toHaveLength(2);
    expect(runtime.timing.mock.calls.map((call) => call[0])).toEqual([
      1, 0, 1, 0,
    ]);
  });
});

// Integration: only inbox rows replace More; full-swipe archive remains unchanged.
it('uses snooze in the inbox secondary slot, while ordinary rows retain More', () => {
  const onSnooze = vi.fn();
  const session = { id: 'follow', status: 'active' } as RemoteSession;
  const draw = (inboxMode: boolean) => act(() => root.render(
    <SwipeableSessionRow {...controls} onSnooze={onSnooze} inboxMode={inboxMode} session={session} testID="swipe">row</SwipeableSessionRow>,
  ));
  draw(true);
  act(() => (host.querySelector('[data-testid="swipe.optionsAction"]') as HTMLButtonElement).click());
  expect(onSnooze).toHaveBeenCalledWith(session);
  expect(controls.onShowOptions).not.toHaveBeenCalled();
  drag(-260);
  release('left');
  expect(controls.onArchive).toHaveBeenCalledWith(session);
  draw(false);
  act(() => (host.querySelector('[data-testid="swipe.optionsAction"]') as HTMLButtonElement).click());
  expect(controls.onShowOptions).toHaveBeenCalledWith(session);
});
