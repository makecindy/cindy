import { expect, it, vi } from "vitest";
import {
  desktopNavigationSummary,
  logDesktopNavigation,
} from "../remoteDesktopNavigationDebug";
const fixture = vi.hoisted(() => ({ enabled: true, log: vi.fn() }));
vi.mock("@/debug/mobileDebugLog", () => ({
  mobileDebugEnabled: () => fixture.enabled,
  mobileDebugLog: fixture.log,
}));
it("records nested stack positions without paths, keys, parameters or unknown names", () => {
  const state = {
    index: 0,
    routes: [
      {
        name: "__root",
        key: "private-key",
        state: {
          index: 1,
          routes: [
            {
              name: "devices/index",
              params: { deviceName: "private-computer" },
            },
            {
              name: "devices/desktop/[deviceId]",
              path: "private-path",
              params: { deviceId: "private-device" },
            },
            { name: "private-route", params: { sessionId: "private-task" } },
          ],
        },
      },
    ],
  };
  expect(desktopNavigationSummary(state)).toBe(
    "0:[root(1:[devices,desktop,other])]",
  );
  logDesktopNavigation("test", state);
  expect(JSON.stringify(fixture.log.mock.calls)).not.toContain("private");
});
it("does not inspect navigation state or log when recording is disabled", () => {
  fixture.enabled = false;
  fixture.log.mockClear();
  const state = {
    get routes(): never {
      throw new Error("must not inspect");
    },
  };
  logDesktopNavigation("test", state);
  expect(fixture.log).not.toHaveBeenCalled();
  fixture.enabled = true;
});
