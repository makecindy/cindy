import { describe, expect, it, vi } from "vitest";

vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({}),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "Camera",
      "Copy",
      "House",
      "Lock",
      "Menu",
      "Mic",
      "Play",
      "Power",
      "RotateCcw",
      "RotateCw",
      "Undo2",
      "Vibrate",
      "Volume1",
      "Volume2",
    ].map((name) => [name, name]),
  ),
);

import { liveScreenParam, parseLiveScreenParam } from "../liveScreen";
import { taskLiveScreens } from "../useTaskLiveScreens";

const screen = {
  plugin: "_ns__acme__sim",
  pluginName: "Simulator",
  id: "UDID-1",
  name: "iPhone 17",
  platform: "ios",
  state: "running",
  taskIds: ["task-1"],
};

describe("live screen entries", () => {
  it("round-trips a listed screen through the route and rejects anything else", () => {
    expect(parseLiveScreenParam(liveScreenParam(screen))).toEqual({
      plugin: screen.plugin,
      id: "UDID-1",
    });
    for (const value of [
      undefined,
      "",
      "sim",
      "sim|",
      "|id",
      "a|b|c",
      "a/b|c",
      "sim|a b",
    ])
      expect(parseLiveScreenParam(value)).toBeUndefined();
  });

  it("shows only running screens bound to this task with a trusted shape", () => {
    const result = {
      screens: [
        screen,
        { ...screen, id: "OFF", state: "off" },
        { ...screen, id: "OTHER", taskIds: ["task-2"] },
        { ...screen, id: "WATCH", platform: "watchos" },
        { ...screen, id: "bad id" },
        "nope",
      ],
    };
    expect(taskLiveScreens(result, "task-1")).toEqual([screen]);
    expect(taskLiveScreens(null, "task-1")).toEqual([]);
    expect(taskLiveScreens({ screens: "x" }, "task-1")).toEqual([]);
  });
});
