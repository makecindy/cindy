// @vitest-environment jsdom
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AnyProps = Record<string, any>;
const styleOf = (style: unknown, state = { pressed: false }): AnyProps => {
  const value = typeof style === "function" ? style(state) : style;
  if (Array.isArray(value))
    return Object.assign({}, ...value.map((item) => styleOf(item)));
  return value && typeof value === "object" ? (value as AnyProps) : {};
};

vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const Pressable = forwardRef<any, AnyProps>(
    (
      {
        children,
        onPress,
        onLongPress,
        testID,
        accessibilityHint,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        disabled,
        style,
      },
      ref,
    ) => {
      if (ref && typeof ref === "object") {
        (ref as { current: unknown }).current = {
          measureInWindow: (
            cb: (x: number, y: number, w: number, h: number) => void,
          ) => cb(300, 80, 40, 40),
        };
      }
      return el(
        "button",
        {
          "data-testid": testID,
          "aria-label": accessibilityLabel,
          "data-role": accessibilityRole,
          "data-checked":
            accessibilityState?.checked === undefined
              ? undefined
              : String(accessibilityState.checked),
          "data-expanded":
            accessibilityState?.expanded === undefined
              ? undefined
              : String(accessibilityState.expanded),
          "data-selected":
            accessibilityState?.selected === undefined
              ? undefined
              : String(accessibilityState.selected),
          "data-hint": accessibilityHint,
          disabled,
          "data-opacity": styleOf(style).opacity,
          onClick: onPress ?? onLongPress,
        },
        typeof children === "function"
          ? children({ pressed: false })
          : children,
      );
    },
  );
  const View = ({
    children,
    pointerEvents,
    importantForAccessibility,
    testID,
  }: AnyProps) =>
    el(
      "div",
      {
        "data-testid": testID,
        "data-pointer-events": pointerEvents,
        "data-a11y": importantForAccessibility,
      },
      children,
    );
  const Modal = ({ children, visible }: AnyProps) =>
    visible ? el("section", { "data-modal": "true" }, children) : null;
  class AnimatedValue {
    constructor(public v: number) {}
    setValue(v: number) {
      this.v = v;
    }
    interpolate() {
      return 1;
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View,
      timing: () => ({ start: () => undefined }),
    },
    Easing: { bezier: () => () => 0 },
    Modal,
    Pressable,
    ScrollView: ({ children }: AnyProps) => el("div", null, children),
    StyleSheet: { create: <T,>(s: T) => s, absoluteFill: {}, hairlineWidth: 1 },
    View,
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
}));
vi.mock("lucide-react-native", async () => {
  const { createElement: el } = await import("react");
  const icon = (name: string) => () => el("i", { "data-icon": name });
  return {
    Check: icon("Check"),
    ChevronLeft: icon("ChevronLeft"),
    ChevronRight: icon("ChevronRight"),
    Minus: icon("Minus"),
  };
});
vi.mock("@/components/AppText", async () => {
  const { createElement: el } = await import("react");
  return {
    Text: ({ children, accessibilityRole }: AnyProps) =>
      el("span", { "data-role": accessibilityRole }, children),
  };
});
vi.mock("@/hooks/useReduceMotion", () => ({
  useReduceMotionEnabled: () => true,
}));
vi.mock("@/theme", () => ({
  fontWeight: {},
  iconSize: {},
  iconStroke: {},
  lineHeight: {},
  radius: {},
  spacing: { sm: 8, md: 12, xs: 4 },
  typeScale: {},
  motionDuration: { fast: 150 },
  motionEasing: { out: [0, 0, 1, 1] },
  useTheme: () => ({ colors: { destructive: "red", textPrimary: "black" } }),
  useThemedStyles: () =>
    new Proxy(
      {},
      { get: (_t, key) => (key === "triggerPressed" ? { opacity: 0.72 } : {}) },
    ),
}));

import { AnchoredPullDownMenu } from "@/platform/chrome/AnchoredPullDownMenu";
import type { NativePullDownAction } from "@/platform/chrome/NativePullDownMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const q = (selector: string) =>
  container.querySelector(selector) as HTMLElement | null;
const click = (selector: string) =>
  act(() => (q(selector) as HTMLElement).click());

const actions: NativePullDownAction[] = [
  {
    id: "group.sort",
    title: "Sort",
    displayInline: true,
    subactions: [
      { id: "sort.time", title: "By time", state: "on" },
      { id: "sort.priority", title: "Priority", state: "off" },
    ],
  },
  {
    id: "group.projects",
    title: "Projects",
    displayInline: true,
    subactions: [
      {
        id: "project.a",
        title: "Alpha",
        state: "off",
        keepPresented: true,
        subtitle: "3 tasks",
      },
    ],
  },
  {
    id: "more",
    title: "More",
    subactions: [{ id: "more.rename", title: "Rename" }],
  },
  { id: "delete", title: "Delete", destructive: true },
  { id: "locked", title: "Locked", disabled: true },
];

function render(
  onAction = vi.fn(),
  children: ReactNode = createElement(
    "span",
    { accessibilityLabel: "Display options" },
    "…",
  ),
) {
  act(() =>
    root.render(
      createElement(AnchoredPullDownMenu, {
        actions,
        onAction,
        testID: "trigger",
        children,
      }),
    ),
  );
  return onAction;
}

describe("Android anchored pull-down menu", () => {
  it("makes the trigger one accessible button and opens the menu from it", () => {
    render();
    const trigger = q('[data-testid="trigger"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Display options");
    expect(trigger.getAttribute("data-expanded")).toBe("false");
    expect(
      q('[data-a11y="no-hide-descendants"]')?.getAttribute(
        "data-pointer-events",
      ),
    ).toBe("none");
    expect(q("[data-modal]")).toBeNull();
    click('[data-testid="trigger"]');
    expect(q("[data-modal]")).not.toBeNull();
    expect(q('[data-testid="trigger"]')!.getAttribute("data-expanded")).toBe(
      "true",
    );
  });

  it("keeps the trigger's own accessibility state and hint while adding expanded", () => {
    render(
      vi.fn(),
      createElement(
        "span",
        {
          accessibilityHint: "Filters are applied",
          accessibilityLabel: "Filter",
          accessibilityState: { selected: true },
        },
        "filter",
      ),
    );
    const trigger = q('[data-testid="trigger"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Filter");
    expect(trigger.getAttribute("data-selected")).toBe("true");
    expect(trigger.getAttribute("data-hint")).toBe("Filters are applied");
    expect(trigger.getAttribute("data-expanded")).toBe("false");
    click('[data-testid="trigger"]');
    expect(q('[data-testid="trigger"]')!.getAttribute("data-selected")).toBe(
      "true",
    );
    expect(q('[data-testid="trigger"]')!.getAttribute("data-expanded")).toBe(
      "true",
    );
  });

  it("shows real section titles, a leading check only on selected rows, and subtitles", () => {
    render();
    click('[data-testid="trigger"]');
    const headers = [...container.querySelectorAll('[data-role="header"]')].map(
      (node) => node.textContent,
    );
    expect(headers).toEqual(["Sort", "Projects"]);
    expect(
      q('[data-testid="pullDownMenu.item.sort.time"] [data-icon="Check"]'),
    ).not.toBeNull();
    expect(
      q('[data-testid="pullDownMenu.item.sort.priority"] [data-icon="Check"]'),
    ).toBeNull();
    expect(
      q('[data-testid="pullDownMenu.item.sort.time"]')!.getAttribute(
        "data-checked",
      ),
    ).toBe("true");
    expect(
      q('[data-testid="pullDownMenu.item.project.a"]')!.textContent,
    ).toContain("3 tasks");
    expect(
      (q('[data-testid="pullDownMenu.item.locked"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("closes after a normal choice but stays open for keepPresented multi-select", () => {
    const onAction = render();
    click('[data-testid="trigger"]');
    click('[data-testid="pullDownMenu.item.project.a"]');
    expect(onAction).toHaveBeenLastCalledWith("project.a");
    expect(q("[data-modal]")).not.toBeNull();
    click('[data-testid="pullDownMenu.item.sort.priority"]');
    expect(onAction).toHaveBeenLastCalledWith("sort.priority");
    expect(q("[data-modal]")).toBeNull();
  });

  it("enters a submenu like UIMenu and comes back", () => {
    const onAction = render();
    click('[data-testid="trigger"]');
    click('[data-testid="pullDownMenu.item.more"]');
    expect(onAction).not.toHaveBeenCalled();
    expect(q('[data-testid="pullDownMenu.item.more.rename"]')).not.toBeNull();
    expect(q('[data-testid="pullDownMenu.item.sort.time"]')).toBeNull();
    click('[aria-label="More"]');
    expect(q('[data-testid="pullDownMenu.item.sort.time"]')).not.toBeNull();
    click('[data-testid="pullDownMenu.item.more"]');
    click('[data-testid="pullDownMenu.item.more.rename"]');
    expect(onAction).toHaveBeenLastCalledWith("more.rename");
    expect(q("[data-modal]")).toBeNull();
  });

  it("closes from the backdrop without choosing anything", () => {
    const onAction = render();
    click('[data-testid="trigger"]');
    click('[data-testid="trigger.menu.backdrop"]');
    expect(q("[data-modal]")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
});
