// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopHost } from "../RemoteDesktopHost";
import { REMOTE_DESKTOP_ROUTE } from "../remoteDesktopNavigation";
const fixture = vi.hoisted(() => ({
  account: "owner-a",
  generation: 1,
  authenticated: true,
  state: {} as any,
  navigationState: () => ({}) as any,
  mounted: vi.fn(),
  stopped: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  resetRoot: vi.fn(),
  props: {} as Record<string, any>,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
  View: ({ children, pointerEvents }: any) =>
    createElement("div", { "data-pointer-events": pointerEvents }, children),
}));
vi.mock("expo-router", () => ({
  useNavigationContainerRef: () => ({
    getRootState: () => fixture.navigationState(),
    resetRoot: fixture.resetRoot,
    addListener: () => () => {},
  }),
  useRouter: () => ({ push: fixture.push, replace: fixture.replace }),
}));
vi.mock("expo-router/react-navigation", () => ({
  useNavigationState: (select: (state: any) => unknown) =>
    select(fixture.navigationState()),
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: fixture.account },
    accountGeneration: fixture.generation,
    isAuthenticated: fixture.authenticated,
  }),
}));
vi.mock("../NativeRemoteDesktopView", () => ({
  NativeRemoteDesktopView: true,
}));
vi.mock("../RemoteDesktopScreen", () => ({
  RemoteDesktopSession: (props: any) => {
    fixture.props = props;
    useEffect(() => {
      fixture.mounted();
      return () => {
        fixture.stopped();
      };
    }, []);
    return createElement("span", {}, props.deviceId);
  },
}));
let root: Root;
let host: HTMLDivElement;
const home = {
  key: "home",
  name: "devices/index",
  params: { deviceId: "computer-b", filter: "active" },
};
const task = {
  key: "task-b",
  name: "sessions/[sessionId]",
  params: { sessionId: "task-b", deviceId: "computer-b" },
};
const desktop = (key = "desktop-a") => ({
  key,
  name: REMOTE_DESKTOP_ROUTE,
  params: { deviceId: "computer", deviceName: "Computer" },
});
const stack = (...routes: any[]) => ({
  key: "root",
  type: "stack",
  stale: false,
  routeNames: ["devices/index", "sessions/[sessionId]", REMOTE_DESKTOP_ROUTE],
  routes,
  index: routes.length - 1,
});
const render = () =>
  act(() =>
    root.render(
      <RemoteDesktopHost>
        <span>navigation</span>
      </RemoteDesktopHost>,
    ),
  );
describe.each([false, true])(
  "desktop navigation with Expo root wrapper=%s",
  (nested) => {
    beforeEach(() => {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      vi.clearAllMocks();
      fixture.account = "owner-a";
      fixture.generation = 1;
      fixture.authenticated = true;
      fixture.state = stack(home, desktop());
      fixture.navigationState = () =>
        nested
          ? {
              ...stack({
                key: "expo-root-route",
                name: "__root",
                state: fixture.state,
              }),
              key: "expo-root-stack",
              routeNames: ["__root"],
            }
          : fixture.state;
      fixture.resetRoot.mockImplementation((state) => {
        if (nested) {
          expect(state.key).toBe("expo-root-stack");
          expect(state.routes[0].name).toBe("__root");
          fixture.state = state.routes[0].state;
        } else fixture.state = state;
      });
      host = document.createElement("div");
      root = createRoot(host);
      render();
    });
    afterEach(() => act(() => root.unmount()));
    it("mounts the native desktop from the active page under the router wrapper", () => {
      expect(fixture.mounted).toHaveBeenCalledOnce();
      expect(fixture.props.deviceId).toBe("computer");
      expect(fixture.props.focused).toBe(true);
      expect(host.querySelector('[data-pointer-events="auto"]')).not.toBeNull();
      expect(fixture.resetRoot).not.toHaveBeenCalled();
    });
    it("retains one mounted viewer across back and fullscreen restoration", () => {
      act(() => fixture.props.onBack());
      render();
      expect(fixture.props.focused).toBe(false);
      act(() => fixture.props.onVisibility(false));
      expect(host.querySelector('[data-pointer-events="none"]')).not.toBeNull();
      fixture.props.onRestore();
      expect(fixture.push).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { deviceId: "computer", deviceName: "Computer" },
        }),
      );
      fixture.state = stack(home, desktop("restored-a"));
      render();
      expect(fixture.props.focused).toBe(true);
      expect(fixture.mounted).toHaveBeenCalledTimes(1);
      expect(fixture.stopped).not.toHaveBeenCalled();
    });
    it("releases the retained viewer when its detached presentation ends", () => {
      fixture.state = stack(home);
      render();
      act(() => fixture.props.onEnded());
      expect(fixture.stopped).toHaveBeenCalledTimes(1);
      expect(host.textContent).toBe("navigation");
    });
    it.each(["account", "generation", "logout"])(
      "never retains a detached stream across %s changes",
      (kind) => {
        fixture.state = stack(home);
        render();
        if (kind === "account") fixture.account = "owner-b";
        if (kind === "generation") fixture.generation++;
        if (kind === "logout") fixture.authenticated = false;
        render();
        expect(fixture.stopped).toHaveBeenCalledTimes(1);
        expect(host.textContent).toBe("navigation");
      },
    );
    it("keeps a minimized desktop out of another computer's task Back history", () => {
      const delayedBack = fixture.props.onBack;
      act(() => fixture.props.onBack());
      render();
      expect(fixture.state.routes).toEqual([home]);
      fixture.state = stack(home, task);
      render();
      expect(fixture.props.focused).toBe(false);
      // A late completion from the old desktop must not pop this task.
      act(() => delayedBack());
      expect(fixture.state.routes).toEqual([home, task]);
      fixture.state = stack(...fixture.state.routes.slice(0, -1));
      render();
      expect(fixture.state.routes).toEqual([home]);
      expect(fixture.props.focused).toBe(false);
      expect(fixture.stopped).not.toHaveBeenCalled();
    });
    it("returns an explicitly reopened desktop to the exact prior task and preserves its params", () => {
      act(() => fixture.props.onBack());
      fixture.state = stack(home, task, desktop("new-desktop"));
      render();
      expect(fixture.props.focused).toBe(true);
      act(() => fixture.props.onBack());
      render();
      expect(fixture.state.routes).toEqual([home, task]);
      expect(fixture.state.routes[1]).toBe(task);
      expect(fixture.state.index).toBe(1);
      expect(fixture.props.focused).toBe(false);
    });
    it("removes stale desktop history underneath a task without moving the task", () => {
      fixture.state = stack(home, desktop(), task);
      render();
      expect(fixture.state.routes).toEqual([home, task]);
      expect(fixture.state.index).toBe(1);
    });
    it("does not remove a new explicit desktop entry when an older Back completes", () => {
      const delayedBack = fixture.props.onBack;
      fixture.state = stack(home, task, desktop("new-desktop"));
      render();
      act(() => delayedBack());
      expect(fixture.state.routes.map((r: any) => r.key)).toEqual([
        "home",
        "task-b",
        "new-desktop",
      ]);
    });
    it("deduplicates native restoration and waits for its route before showing the overlay", () => {
      act(() => fixture.props.onBack());
      fixture.state = stack(home, task);
      render();
      act(() => {
        fixture.props.onVisibility(true);
        fixture.props.onRestore();
        fixture.props.onRestore();
      });
      expect(fixture.push).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-pointer-events="none"]')).not.toBeNull();
      fixture.state = stack(home, task, desktop("restored-a"));
      render();
      expect(host.querySelector('[data-pointer-events="auto"]')).not.toBeNull();
      act(() => fixture.props.onRestore());
      expect(fixture.push).toHaveBeenCalledTimes(1);
      expect(fixture.mounted).toHaveBeenCalledTimes(1);
    });
    it("replaces a desktop-only deep link with home when minimizing", () => {
      fixture.state = stack(desktop());
      render();
      act(() => fixture.props.onBack());
      expect(fixture.replace).toHaveBeenCalledWith("/");
    });
  },
);
