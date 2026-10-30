// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwipeableProps } from "@/platform/gestureHandler";
import type { RemoteSession } from "@/session/types";
import { SwipeableSessionRow } from "@/session/SwipeableSessionRow.ios";

const runtime = vi.hoisted(() => ({
  width: 400,
  translation: { value: 0 },
  props: null as SwipeableProps | null,
  reset: vi.fn(),
  close: vi.fn(),
  timing: vi.fn((value: number) => value),
  reactions: new Set<() => void>(),
  styles: [] as Array<() => Record<string, unknown>>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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
  useWindowDimensions: () => ({ width: runtime.width }),
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
      runtime.styles.push(fn);
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
      "Archive",
      "ArchiveRestore",
      "Ellipsis",
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
vi.mock("@/theme", () => ({
  iconSize: { swipeAction: 24 },
  iconStroke: { regular: 2 },
  useTheme: () => ({ colors: {} }),
  useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));
vi.mock("@/theme/tokens", () => ({
  radius: { pill: 9999 },
  spacing: { md: 12 },
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
  runtime.width = 400;
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
    runtime.width = 800;
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
      expect(controls.registry.onRowClose).toHaveBeenCalledWith("a");
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
