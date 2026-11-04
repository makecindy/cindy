// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const link = vi.hoisted(() => ({
  status: "online",
  invoke: vi.fn(),
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => link,
}));

import { useTaskLiveScreens } from "../useTaskLiveScreens";

const screen = {
  plugin: "_ns__acme__sim",
  pluginName: "Simulator",
  id: "UDID-1",
  name: "iPhone 17",
  platform: "ios",
  state: "running",
  taskIds: ["task-1"],
};

describe("useTaskLiveScreens", () => {
  afterEach(() => {
    link.status = "online";
    link.invoke.mockReset();
  });

  it("stops offering simulators once the computer goes offline", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    link.invoke.mockImplementation(async (_device, _channel, [request]) =>
      request.op === "capabilities"
        ? { version: 1, enabled: true, liveScreens: true }
        : { screens: [screen] },
    );
    let shown: unknown[] = [];
    const Probe = () => {
      shown = useTaskLiveScreens("computer", "task-1", true);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {});
    expect(shown).toHaveLength(1);
    // Offline: the cached entries must not stay on the task page.
    link.status = "offline";
    await act(async () => root.render(createElement(Probe)));
    expect(shown).toEqual([]);
    act(() => root.unmount());
  });
});
