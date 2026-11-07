// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  KeyboardEvent,
  KeyboardEventName,
  KeyboardMetrics,
} from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposerDockKeyboardHeight } from "@/session/useComposerDockKeyboardHeight";
import { __resetDockedKeyboardHeightsForTest } from "@/session/keyboardOverlap";

const native = vi.hoisted(() => ({
  keyboard: { height: { value: 0 }, state: { value: 0 } },
  viewport: { width: 390, height: 844 },
  platform: { OS: "ios", isPad: false },
  shown: false,
  metrics: undefined as KeyboardMetrics | undefined,
  listeners: new Map<KeyboardEventName, Set<(event: KeyboardEvent) => void>>(),
}));
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  },
}));
vi.mock("react-native", () => ({
  Platform: native.platform,
  useWindowDimensions: () => native.viewport,
  Keyboard: {
    metrics: () => native.metrics,
    isVisible: () => native.shown,
    addListener: (
      name: KeyboardEventName,
      listener: (event: KeyboardEvent) => void,
    ) => {
      const listeners = native.listeners.get(name) ?? new Set();
      native.listeners.set(name, listeners);
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    KeyboardState: { UNKNOWN: 0, OPENING: 1, OPEN: 2, CLOSING: 3, CLOSED: 4 },
    useAnimatedKeyboard: () => native.keyboard,
    useSharedValue: (value: number) => useRef({ value }).current,
    useDerivedValue: (read: () => number) => ({
      get value() {
        return read();
      },
    }),
  };
});

let result: { readonly value: number };
let root: Root;
let container: HTMLDivElement;
function Harness() {
  result = useComposerDockKeyboardHeight();
  return null;
}
function frame(
  height = 350,
  screenY = 844 - height,
  width = 390,
): KeyboardMetrics {
  return { height, screenY, width, screenX: 0 };
}
function emit(name: KeyboardEventName, endCoordinates = frame()) {
  act(() => {
    for (const listener of native.listeners.get(name) ?? []) {
      listener({ endCoordinates, duration: 0, easing: "keyboard" });
    }
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.keyboard.height.value = 0;
  native.keyboard.state.value = 0;
  native.shown = false;
  native.metrics = undefined;
  native.viewport = { width: 390, height: 844 };
  native.platform.isPad = false;
  storage.clear();
  __resetDockedKeyboardHeightsForTest();
  native.listeners.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function mount() {
  act(() => root.render(<Harness />));
}

it("corrects a third-party keyboard height after show, then follows frame-only growth and shrinkage", () => {
  mount();
  native.keyboard.state.value = 1;
  native.keyboard.height.value = 180;
  emit("keyboardWillShow");
  expect(result.value).toBe(180);
  native.keyboard.state.value = 2;
  native.keyboard.height.value = 300;
  emit("keyboardDidShow", frame(350));
  expect(result.value).toBe(350);
  emit("keyboardDidChangeFrame", frame(430));
  expect(result.value).toBe(430);
  emit("keyboardDidChangeFrame", frame(320));
  expect(result.value).toBe(320);
});

it("does not pin interactive dismissal or cancellation to the last settled height", () => {
  mount();
  native.keyboard.state.value = 2;
  emit("keyboardDidShow");
  native.keyboard.state.value = 3;
  native.keyboard.height.value = 120;
  expect(result.value).toBe(120);
  native.keyboard.state.value = 1;
  native.keyboard.height.value = 220;
  expect(result.value).toBe(220);
  native.keyboard.state.value = 2;
  emit("keyboardDidShow");
  expect(result.value).toBe(350);
  emit("keyboardWillHide");
  native.keyboard.state.value = 3;
  native.keyboard.height.value = 40;
  expect(result.value).toBe(40);
  native.keyboard.state.value = 4;
  emit("keyboardDidHide");
  expect(result.value).toBe(0);
  native.keyboard.state.value = 1;
  native.keyboard.height.value = 60;
  emit("keyboardWillShow");
  expect(result.value).toBe(60);
});

it("reconciles a keyboard already open when navigating and recomputes after rotation", () => {
  native.shown = true;
  native.metrics = frame();
  mount();
  expect(result.value).toBe(350);
  native.viewport = { width: 844, height: 390 };
  native.metrics = frame(200, 190, 844);
  act(() => root.render(<Harness />));
  expect(result.value).toBe(200);
});

it("does not lift the page for floating, hidden, or cross-fade frames", () => {
  native.platform.isPad = true;
  mount();
  native.keyboard.state.value = 2;
  native.keyboard.height.value = 300;
  for (const metrics of [
    frame(300, 544, 250),
    frame(300, 300),
    frame(300, 844),
    frame(844, 0),
  ]) {
    emit("keyboardDidChangeFrame", metrics);
    expect(result.value).toBe(0);
  }
});

// 2026-11-03 iPhone Duo：远程桌面返回进入画中画后，新建任务页的浮动输入框仍被键盘盖住。
// 输入卡片已改用共用判据，这里的 settled 高度却仍把 274×178 这种不可能的坐标算成 0；
// 两条路径必须对同一坐标给出同一遮挡高度（估算值见 keyboardOverlap.ts）。
it("lifts the dock for an impossible iPhone keyboard frame instead of settling at zero", () => {
  native.viewport = { width: 380, height: 900 };
  mount();
  native.keyboard.state.value = 2;
  native.keyboard.height.value = 0;
  emit("keyboardDidShow", { screenX: 192, screenY: 500, width: 274, height: 178 });
  expect(result.value).toBe(342);
});

// PR #8665 review：浮动输入框的 settled 高度也要在本机记录读完后重算。
it("recomputes a settled impossible frame once the saved height finishes loading", async () => {
  native.viewport = { width: 380, height: 900 };
  storage.set("cindy.mobile.keyboard-docked-height.v2", JSON.stringify({ 380: 400 }));
  mount();
  native.keyboard.state.value = 2;
  emit("keyboardDidShow", { screenX: 192, screenY: 500, width: 274, height: 178 });
  expect(result.value).toBe(342);
  await act(async () => {});
  expect(result.value).toBe(400);
});

it("removes all subscriptions on unmount", () => {
  mount();
  act(() => root.render(null));
  expect(
    [...native.listeners.values()].every((listeners) => listeners.size === 0),
  ).toBe(true);
});
