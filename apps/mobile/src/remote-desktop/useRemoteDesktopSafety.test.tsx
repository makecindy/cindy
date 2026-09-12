// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  update: vi.fn(),
  tick: vi.fn(),
  request: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
}));
vi.mock("./useLockOnExitPreference", () => ({
  useRemoteDesktopPreference: (_device: string, feature: string) => [
    feature === "clipboard-sync",
    h.update,
    true,
  ],
}));
vi.mock("../../modules/cindy-remote-presentation/src", () => ({
  remotePresentation: {
    clipboardVersion() {},
    readClipboard() {},
    syncClipboard() {},
  },
}));
vi.mock("./clipboardSync", () => ({
  ClipboardSync: class {
    tick = h.tick;
  },
}));
import { useRemoteDesktopSafety } from "./useRemoteDesktopSafety";
let root: Root;
let latest: ReturnType<typeof useRemoteDesktopSafety>;
const lease = {
  lease: "lease",
  controlling: true,
  display: { id: "1", name: "Main", width: 100, height: 100 },
};
const caps = {
  version: 1 as const,
  enabled: true,
  canControl: true,
  platform: "darwin",
  displays: [],
  clipboardSync: true,
};
function Probe() {
  latest = useRemoteDesktopSafety(
    "computer",
    lease,
    true,
    true,
    caps,
    h.request,
  );
  return null;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.update.mockReset();
  h.tick.mockReset().mockResolvedValue(undefined);
  h.request.mockReset().mockResolvedValue({ enabled: true });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it.each(["enable", "transfer"])(
  "preserves the enabled preference and recovers from %s failure",
  async (stage) => {
    if (stage === "enable")
      h.request.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
    else h.tick.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
    await act(async () => root.render(createElement(Probe)));
    expect(latest.clipboardSync).toBe(true);
    expect(latest.safetyNotice).toBe("clipboardSyncFailed");
    expect(h.update).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(latest.safetyNotice).toBeNull();
    expect(latest.clipboardSync).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
  },
);
it("does not repeatedly request denied permission and supports retry without toggling off", async () => {
  h.tick.mockRejectedValueOnce(new Error("PASTE_DENIED"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(h.tick).toHaveBeenCalledTimes(1);
  expect(latest.safetyNotice).toBe("clipboardSyncPermission");
  await act(async () => latest.onClipboardSyncRetry());
  expect(h.tick).toHaveBeenCalledTimes(2);
  expect(latest.clipboardSync).toBe(true);
  expect(latest.safetyNotice).toBeNull();
  expect(h.update).not.toHaveBeenCalled();
});
