// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  update: vi.fn(),
  tick: vi.fn(),
  request: vi.fn(),
  privacy: false,
  hostMute: false,
  trace: (_stage: string) => {},
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove() {} }),
  },
}));
vi.mock("./useLockOnExitPreference", () => ({
  useRemoteDesktopPreference: (_device: string, feature: string) => [
    feature === "clipboard-sync"
      ? true
      : feature === "privacy-screen"
        ? h.privacy
        : h.hostMute,
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
    constructor(options: { trace: (stage: string) => void }) {
      h.trace = options.trace;
    }
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
  privacyScreen: false,
  hostMute: false,
};
function Probe({ focused = true }: { focused?: boolean }) {
  latest = useRemoteDesktopSafety(
    "computer",
    lease,
    true,
    focused,
    caps,
    h.request,
  );
  return null;
}
beforeEach(() => {
  h.privacy = false;
  h.hostMute = false;
  caps.privacyScreen = false;
  caps.hostMute = false;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.update.mockReset();
  h.tick.mockReset().mockResolvedValue(undefined);
  h.request.mockReset().mockResolvedValue({ enabled: true });
  root = createRoot(document.createElement("div"));
});

it("privacy requests cannot clear a mute failure, and mute success clears its own failure", async () => {
  caps.privacyScreen = caps.hostMute = true;
  h.request.mockImplementation(async (message) => {
    if (message.op === "hostMute" && !message.enabled)
      throw new Error("MUTE_FAILED");
    return { enabled: message.enabled };
  });
  await act(async () => root.render(createElement(Probe)));
  expect(latest.safetyNotice).toBe("hostMuteFailed");
  h.privacy = true;
  await act(async () => root.render(createElement(Probe)));
  expect(latest.safetyNotice).toBe("hostMuteFailed");
  h.hostMute = true;
  await act(async () => root.render(createElement(Probe)));
  expect(latest.safetyNotice).toBeNull();
});

it("mute success cannot clear a privacy failure", async () => {
  caps.privacyScreen = caps.hostMute = true;
  h.request.mockImplementation(async (message) => {
    if (message.op === "privacyScreen") throw new Error("PRIVACY_FAILED");
    return { enabled: message.enabled };
  });
  await act(async () => root.render(createElement(Probe)));
  h.hostMute = true;
  await act(async () => root.render(createElement(Probe)));
  expect(latest.safetyNotice).toBe("privacyFailed");
});
it.each([
  "clipboardSyncSkipped",
  "clipboardSyncFailed",
  "clipboardSyncPermission",
])(
  "keeps protection failures visible ahead of %s and preserves the lower-priority notice",
  async (notice) => {
    caps.privacyScreen = caps.hostMute = true;
    h.request.mockImplementation(async (message) => {
      if (message.enabled && ["privacyScreen", "hostMute"].includes(message.op))
        throw new Error("PROTECTION_FAILED");
      return { enabled: message.enabled };
    });
    if (notice === "clipboardSyncSkipped")
      h.tick.mockImplementation(async () => h.trace("content-skipped"));
    else
      h.tick.mockRejectedValue(
        new Error(
          notice === "clipboardSyncPermission"
            ? "PASTE_DENIED"
            : "INVOKE_TIMEOUT",
        ),
      );
    await act(async () => root.render(createElement(Probe)));
    expect(latest.safetyNotice).toBe(notice);
    h.privacy = h.hostMute = true;
    await act(async () => root.render(createElement(Probe)));
    expect(latest.privacyActive).toBe(false);
    expect(latest.safetyNotice).toBe("privacyFailed");
    h.privacy = false;
    await act(async () => root.render(createElement(Probe)));
    expect(latest.safetyNotice).toBe("hostMuteFailed");
    h.hostMute = false;
    await act(async () => root.render(createElement(Probe)));
    expect(latest.safetyNotice).toBe(notice);
  },
);
it("clipboard recovery cannot hide a failed privacy screen", async () => {
  caps.privacyScreen = true;
  h.privacy = true;
  h.request.mockImplementation(async (message) => {
    if (message.op === "privacyScreen") throw new Error("PRIVACY_FAILED");
    return {};
  });
  h.tick.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
  await act(async () => root.render(createElement(Probe)));
  expect(latest.safetyNotice).toBe("privacyFailed");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(h.tick).toHaveBeenCalledTimes(2);
  expect(latest.safetyNotice).toBe("privacyFailed");
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
it.each(["enable", "transfer", "focus"])(
  "preserves the enabled preference and recovers from %s failure",
  async (stage) => {
    if (stage === "enable")
      h.request.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
    else
      h.tick.mockRejectedValueOnce(
        new Error(
          stage === "focus" ? "CLIPBOARD_NOT_ALLOWED" : "INVOKE_TIMEOUT",
        ),
      );
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

it("foreground replacement never sends a stale cleanup disable", async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.render(createElement(Probe, { focused: false })));
  await act(async () => root.render(createElement(Probe)));
  expect(
    h.request.mock.calls.filter(
      ([message]) => message.op === "clipboardSync" && !message.enabled,
    ),
  ).toHaveLength(0);
  expect(h.tick).toHaveBeenCalledTimes(2);
  expect(h.update).not.toHaveBeenCalled();
});
it("renews host opt-in after a delayed disable from an earlier client state", async () => {
  h.tick.mockRejectedValueOnce(new Error("DESKTOP_CLIPBOARD_UNAVAILABLE"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(
    h.request.mock.calls.filter(
      ([message]) => message.op === "clipboardSync" && message.enabled,
    ),
  ).toHaveLength(2);
  expect(latest.safetyNotice).toBeNull();
});
