// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ dismiss: () => {}, mode: "light" }));
vi.mock("react-native", () => ({
  View: ({ children, pointerEvents }: any) => (
    <div data-pointer-events={pointerEvents}>{children}</div>
  ),
  Pressable: ({
    children,
    onPress,
    onLongPress,
    accessibilityState,
    accessibilityLabel,
    accessibilityRole,
    disabled,
    testID,
  }: any) => (
    <button
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState?.expanded}
      aria-checked={accessibilityState?.checked}
      aria-disabled={accessibilityState?.disabled}
      role={accessibilityRole}
      disabled={disabled}
      data-testid={testID}
      onClick={onPress ?? onLongPress}
    >
      {children}
    </button>
  ),
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("@expo/ui/jetpack-compose", () => {
  const Slot = ({ children }: any) => <>{children}</>;
  const DropdownMenu = Object.assign(
    ({ children, onDismissRequest, expanded }: any) => {
      native.dismiss = onDismissRequest;
      return expanded ? <section>{children}</section> : null;
    },
    { Trigger: Slot, Items: Slot },
  );
  const DropdownMenuItem = Object.assign(
    ({ children, enabled, onClick, elementColors }: any) => (
      <button
        disabled={enabled === false}
        onClick={onClick}
        data-color={elementColors?.textColor}
      >
        {children}
      </button>
    ),
    { Text: Slot, TrailingIcon: Slot },
  );
  return {
    Box: () => null,
    Column: Slot,
    DropdownMenu,
    DropdownMenuItem,
    HorizontalDivider: () => <hr />,
    Host: ({ children, colorScheme }: any) => (
      <div data-theme={colorScheme}>{children}</div>
    ),
    RNHostView: Slot,
    Text: Slot,
  };
});
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  fillMaxSize: () => ({}),
  padding: () => ({}),
  width: () => ({}),
  testID: () => ({}),
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/theme", () => ({
  fontWeight: {},
  lineHeight: {},
  spacing: {},
  typeScale: {},
  useTheme: () => ({
    mode: native.mode,
    colors: {
      textPrimary: "ink",
      textSecondary: "muted",
      destructive: "danger",
    },
  }),
}));
import { AnchoredPullDownMenu } from "@/platform/chrome/AnchoredPullDownMenu.android";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
});
const click = (label: string) =>
  act(() => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    );
    expect(button).toBeDefined();
    button!.click();
  });
it("keeps groups, check states, disabled choices and repeated selections in the native popup", () => {
  const choose = vi.fn();
  act(() =>
    root.render(
      <AnchoredPullDownMenu
        onAction={choose}
        actions={[
          {
            id: "group",
            title: "Order",
            displayInline: true,
            subactions: [
              { id: "time", title: "Time", state: "on", keepPresented: true },
            ],
          },
          { id: "locked", title: "Locked", disabled: true },
          { id: "delete", title: "Delete", destructive: true },
        ]}
      >
        <span>Open</span>
      </AnchoredPullDownMenu>,
    ),
  );
  click("Open");
  expect(container.textContent).toContain("Order");
  click("Time✓");
  click("Time✓");
  click("Locked");
  expect(choose.mock.calls).toEqual([["time"], ["time"]]);
  expect(container.querySelector('[data-color="danger"]')?.textContent).toBe(
    "Delete",
  );
  click("Delete");
  expect(container.querySelector("section")).toBeNull();
  expect(
    container
      .querySelector("[data-theme]")
      ?.parentElement?.getAttribute("data-pointer-events"),
  ).toBe("none");
  expect(choose).toHaveBeenLastCalledWith("delete");
});
it("exposes on/off/mixed on one named action and updates state without losing disabled or keepPresented", () => {
  const choose = vi.fn();
  const render = (state: "on" | "off" | "mixed", disabled = false) =>
    act(() =>
      root.render(
        <AnchoredPullDownMenu
          onAction={choose}
          actions={[
            {
              id: "choice",
              title: "Choice",
              subtitle: "Details",
              state,
              disabled,
              keepPresented: true,
            },
            { id: "close", title: "Close" },
          ]}
        >
          <span>Open</span>
        </AnchoredPullDownMenu>,
      ),
    );
  render("on");
  click("Open");
  const row = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="pullDownMenu.item.choice"]',
    )!;
  for (const [state, expected] of [
    ["on", "true"],
    ["off", "false"],
    ["mixed", "mixed"],
  ] as const) {
    render(state);
    expect(row().getAttribute("aria-checked")).toBe(expected);
    expect(row().getAttribute("aria-label")).toBe("Choice, Details");
    expect(row().getAttribute("role")).toBe("menuitem");
    expect(row().querySelector("button")).toBeNull();
    act(() => row().click());
    expect(container.querySelector("section")).not.toBeNull();
  }
  expect(choose.mock.calls).toEqual([["choice"], ["choice"], ["choice"]]);
  render("mixed", true);
  expect(row().disabled).toBe(true);
  expect(row().getAttribute("aria-disabled")).toBe("true");
  act(() => row().click());
  expect(choose).toHaveBeenCalledTimes(3);
  click("Close");
  expect(container.querySelector("section")).toBeNull();
});

it("creates the host on demand and reuses it across dismiss/reopen without blocking the trigger", () => {
  act(() =>
    root.render(
      <AnchoredPullDownMenu
        actions={[{ id: "one", title: "One" }]}
        onAction={vi.fn()}
      >
        <span>Open</span>
      </AnchoredPullDownMenu>,
    ),
  );
  expect(container.querySelector("[data-theme]")).toBeNull();
  click("Open");
  const host = container.querySelector("[data-theme]");
  act(() => native.dismiss());
  expect(container.querySelector("section")).toBeNull();
  expect(container.querySelector("[data-theme]")).toBe(host);
  expect(host?.parentElement?.getAttribute("data-pointer-events")).toBe("none");
  click("Open");
  expect(container.querySelector("[data-theme]")).toBe(host);
  expect(host?.parentElement?.getAttribute("data-pointer-events")).toBe("none");
  expect(container.textContent).toContain("One");
});
it("navigates a submenu, returns through its back row, dismisses and resets the path on reopen", () => {
  act(() =>
    root.render(
      <AnchoredPullDownMenu
        onAction={vi.fn()}
        actions={[
          {
            id: "more",
            title: "More",
            subactions: [{ id: "nested", title: "Nested" }],
          },
        ]}
      >
        <span>Open</span>
      </AnchoredPullDownMenu>,
    ),
  );
  click("Open");
  click("More›");
  expect(container.textContent).toContain("Nested");
  click("‹ More");
  expect(container.textContent).not.toContain("Nested");
  click("More›");
  act(() => native.dismiss());
  click("Open");
  expect(container.textContent).not.toContain("Nested");
});
it.each(["light", "dark"])(
  "uses the %s app appearance for the popup",
  (mode) => {
    native.mode = mode;
    act(() =>
      root.render(
        <AnchoredPullDownMenu actions={[]} onAction={vi.fn()}>
          <span>Open</span>
        </AnchoredPullDownMenu>,
      ),
    );
    click("Open");
    expect(
      container.querySelector("[data-theme]")?.getAttribute("data-theme"),
    ).toBe(mode);
  },
);
