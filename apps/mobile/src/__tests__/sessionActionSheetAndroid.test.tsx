// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  props: null as any,
  hide: vi.fn<() => Promise<void>>(),
  expand: vi.fn<() => Promise<void>>(),
  mode: "light",
}));
vi.mock("@expo/ui/jetpack-compose", () => ({
  Host: ({ children, colorScheme }: any) => (
    <div data-scheme={colorScheme}>{children}</div>
  ),
  RNHostView: ({ children }: any) => children,
  ModalBottomSheet: ({ ref, ...props }: any) => {
    native.props = props;
    React.useImperativeHandle(
      ref,
      () => ({ hide: native.hide, expand: native.expand }),
      [],
    );
    return <div data-testid="native-sheet">{props.children}</div>;
  },
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children, nestedScrollEnabled }: any) => (
    <div data-nested-scroll={nestedScrollEnabled ? "true" : "false"}>{children}</div>
  ),
  StyleSheet: { create: (s: any) => s },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("@/platform/gestureHandler", () => ({
  GestureHandlerRootView: ({ children }: any) => children,
}));
vi.mock("@/platform/AdaptiveWindowContext", () => ({
  PaneViewportProvider: ({ children }: any) => children,
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({
    mode: native.mode,
    colors: {
      surfaceElevated: "surface",
      textPrimary: "text",
      overlay: "scrim",
    },
  }),
}));

import { SessionActionSheetFrame } from "@/session/SessionActionSheetFrame.android";
import { NativeBottomSheet } from "@/session/NativeBottomSheet.android";

let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
beforeEach(() => {
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  native.hide.mockReset().mockResolvedValue();
  native.expand.mockReset().mockResolvedValue();
  native.mode = "light";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each([SessionActionSheetFrame, NativeBottomSheet])(
  "Android native sheet lifecycle (%s)",
  (Frame) => {
    it("waits for native hide and unmount before opening the next dialog, exactly once", async () => {
      let finish!: () => void;
      native.hide.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const closed = vi.fn(() =>
        expect(
          container.querySelector('[data-testid="native-sheet"]'),
        ).toBeNull(),
      );
      const render = (visible: boolean) =>
        act(() =>
          root.render(
            <Frame visible={visible} onClose={vi.fn()} onClosed={closed}>
              actions
            </Frame>,
          ),
        );
      render(false);
      expect(closed).not.toHaveBeenCalled();
      render(true);
      render(false);
      expect(native.hide).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("actions");
      expect(closed).not.toHaveBeenCalled();
      await act(async () => {
        finish();
      });
      expect(closed).not.toHaveBeenCalled();
      flushFrames();
      expect(closed).toHaveBeenCalledOnce();
      render(false);
      expect(closed).toHaveBeenCalledOnce();
    });

    it("waits for the native swipe, scrim or Back dismissal animation", async () => {
      let finish!: () => void;
      native.hide.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const closed = vi.fn();
      function Presenter() {
        const [visible, setVisible] = useState(true);
        return (
          <Frame
            visible={visible}
            onClose={() => setVisible(false)}
            onClosed={closed}
          >
            actions
          </Frame>
        );
      }
      act(() => root.render(<Presenter />));
      act(() => native.props.onDismissRequest());
      expect(container.textContent).toContain("actions");
      expect(native.hide).toHaveBeenCalledOnce();
      expect(closed).not.toHaveBeenCalled();
      await act(async () => {
        finish();
      });

      flushFrames();
      expect(closed).toHaveBeenCalledOnce();
      expect(container.textContent).toBe("");
    });

    it("does not let an old hide completion dismiss a newly reopened sheet", async () => {
      let finish!: () => void;
      native.hide.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const closed = vi.fn();
      const render = (visible: boolean) =>
        act(() =>
          root.render(
            <Frame visible={visible} onClose={vi.fn()} onClosed={closed}>
              actions
            </Frame>,
          ),
        );
      render(true);
      render(false);
      render(true);
      await act(async () => {
        finish();
      });
      expect(container.textContent).toContain("actions");
      expect(native.expand).toHaveBeenCalledOnce();
      expect(closed).not.toHaveBeenCalled();
    });

    it.each(["light", "dark"])(
      "passes the %s theme and semantic surface/scrim to Compose",
      (mode) => {
        native.mode = mode;
        act(() =>
          root.render(
            <Frame visible onClose={vi.fn()}>
              actions
            </Frame>,
          ),
        );
        expect(
          container.querySelector("[data-scheme]")?.getAttribute("data-scheme"),
        ).toBe(mode);
        expect(native.props).toMatchObject({
          containerColor: "surface",
          contentColor: "text",
          scrimColor: "scrim",
          skipPartiallyExpanded: true,
        });
      },
    );
  },
);

it("enables nested scrolling for the native action-sheet content", () => {
  act(() =>
    root.render(
      <SessionActionSheetFrame visible onClose={vi.fn()}>
        actions
      </SessionActionSheetFrame>,
    ),
  );
  expect(container.querySelector('[data-nested-scroll="true"]')).not.toBeNull();
});
