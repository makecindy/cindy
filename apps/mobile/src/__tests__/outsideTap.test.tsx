// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  OutsideTapProvider,
  RootOverlay,
  useOutsideTap,
} from "@/platform/OutsideTap";

const harness = vi.hoisted(() => ({
  root: {} as Record<string, (event: any) => void>,
}));
vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: {} },
  View: (props: any) => {
    if (props.onTouchStart) harness.root = props;
    return createElement(
      "div",
      { "data-layer": props.pointerEvents === "box-none" ? "" : undefined },
      props.children,
    );
  },
}));

let root: Root;
let host: HTMLDivElement;
const onOutsideTap = vi.fn();
function Floating({ active }: { active: boolean }) {
  // The floating card occupies x/y 100..200.
  useOutsideTap(
    active,
    (x, y) => x >= 100 && x <= 200 && y >= 100 && y <= 200,
    onOutsideTap,
  );
  return null;
}
const render = (active = true, overlay?: string) =>
  act(async () =>
    root.render(
      createElement(
        OutsideTapProvider,
        null,
        createElement(Floating, { active }),
        overlay ? createElement(RootOverlay, null, overlay) : null,
      ),
    ),
  );
let now = 0;
const touch = (
  name: "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel",
  pageX = 0,
  pageY = 0,
  fingers = name === "onTouchEnd" || name === "onTouchCancel" ? 0 : 1,
) =>
  harness.root[name]({
    nativeEvent: {
      pageX,
      pageY,
      timestamp: now,
      touches: Array.from({ length: fingers }),
    },
  });
const tap = (x: number, y: number) => {
  touch("onTouchStart", x, y);
  now += 80;
  touch("onTouchEnd", x, y);
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onOutsideTap.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("reports taps outside the floating area and ignores taps inside it", async () => {
  await render();
  tap(150, 150);
  expect(onOutsideTap).not.toHaveBeenCalled();
  tap(20, 400);
  expect(onOutsideTap).toHaveBeenCalledTimes(1);
});

it("lets scrolls, drags, pinches, long presses and cancelled touches pass without closing", async () => {
  await render();
  // Scroll the conversation underneath.
  touch("onTouchStart", 20, 400);
  touch("onTouchMove", 20, 300);
  touch("onTouchEnd", 20, 300);
  // A scroll container that reports only the end point.
  touch("onTouchStart", 20, 400);
  touch("onTouchEnd", 20, 320);
  // A native scroll view taking over the gesture.
  touch("onTouchStart", 20, 400);
  touch("onTouchCancel");
  touch("onTouchEnd", 20, 400);
  // Two-finger gesture.
  touch("onTouchStart", 20, 400);
  touch("onTouchStart", 60, 400, 2);
  touch("onTouchEnd", 60, 400, 1);
  touch("onTouchEnd", 20, 400);
  // Long press on a message.
  touch("onTouchStart", 20, 400);
  now += 600;
  touch("onTouchEnd", 20, 400);
  expect(onOutsideTap).not.toHaveBeenCalled();
  // Small jitter still counts as a tap.
  touch("onTouchStart", 20, 400);
  touch("onTouchMove", 24, 403);
  touch("onTouchEnd", 24, 403);
  expect(onOutsideTap).toHaveBeenCalledTimes(1);
});

it("stops listening once the floating area closes", async () => {
  await render(false);
  tap(20, 400);
  await render(true);
  await render(false);
  tap(20, 400);
  expect(onOutsideTap).not.toHaveBeenCalled();
});

it("renders overlays in the window-sized layer and removes them on unmount", async () => {
  const layer = () => host.querySelector("[data-layer]")!.textContent;
  await render(false, "card");
  expect(layer()).toBe("card");
  await render(false, "updated card");
  expect(layer()).toBe("updated card");
  await render(false);
  expect(layer()).toBe("");
});
