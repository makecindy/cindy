// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewTabs } from "../usePreviewTabs";

const fixture = vi.hoisted(() => ({
  status: "online",
  invoke: vi.fn(),
  appState: "active",
  listener: null as null | ((state: string) => void),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fixture.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      fixture.listener = listener;
      return { remove: () => (fixture.listener = null) };
    },
  },
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ status: fixture.status, invoke: fixture.invoke }),
}));

const grant = "g".repeat(43);
let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof usePreviewTabs> = [];
let tabsReply: unknown[];
let failTabs = false;
const Probe = ({ active = true }: { active?: boolean }) => {
  latest = usePreviewTabs({ deviceId: "pc", sessionId: "s1", active });
  return null;
};
const ops = () => fixture.invoke.mock.calls.map((call) => call[2][0].op);
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fixture.status = "online";
  fixture.appState = "active";
  fixture.listener = null;
  failTabs = false;
  tabsReply = [{ grant, sessionId: "s1", pluginName: "Baguette", title: "Sim" }];
  fixture.invoke.mockReset().mockImplementation(async (_d, _c, [message]) => {
    if (message.op === "capabilities")
      return {
        version: 1,
        enabled: true,
        previewTab: { version: 1, maxTouchPoints: 2 },
      };
    if (failTabs) throw new Error("INVOKE_TIMEOUT");
    return { tabs: tabsReply };
  });
  latest = [];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
const mount = async (active = true) =>
  act(async () => root.render(createElement(Probe, { active })));
const tick = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe("watching a task's preview tabs", () => {
  it("lists at once, asks for capabilities only on the first run and polls every 4 s", async () => {
    await mount();
    expect(latest).toEqual([
      { sessionId: "s1", pluginName: "Baguette", title: "Sim" },
    ]);
    expect(ops()).toEqual(["capabilities", "previewTabs"]);
    await tick(4000);
    await tick(4000);
    expect(ops()).toEqual([
      "capabilities",
      "previewTabs",
      "previewTabs",
      "previewTabs",
    ]);
    expect(fixture.invoke.mock.calls[0][3]).toEqual({ background: true });
  });

  it("notices a preview that appears or closes", async () => {
    tabsReply = [];
    await mount();
    expect(latest).toEqual([]);
    tabsReply = [{ grant, sessionId: "s1", pluginName: "Baguette", title: "Sim" }];
    await tick(4000);
    expect(latest).toHaveLength(1);
    tabsReply = [];
    await tick(4000);
    expect(latest).toEqual([]);
  });

  it("stops while the page is not shown, offline or in the background, and asks afresh on return", async () => {
    await mount();
    await mount(false);
    expect(latest).toEqual([]);
    const calls = fixture.invoke.mock.calls.length;
    await tick(20_000);
    expect(fixture.invoke).toHaveBeenCalledTimes(calls);
    await mount(true);
    expect(ops().slice(calls)).toEqual(["capabilities", "previewTabs"]);
    // Leaving the foreground cancels the pending poll.
    const afterShow = fixture.invoke.mock.calls.length;
    fixture.appState = "background";
    act(() => fixture.listener!("background"));
    await tick(20_000);
    expect(fixture.invoke).toHaveBeenCalledTimes(afterShow);
    // Coming back asks capabilities again, then polls.
    fixture.appState = "active";
    await act(async () => fixture.listener!("active"));
    expect(ops().slice(afterShow)).toEqual(["capabilities", "previewTabs"]);
    fixture.status = "offline";
    await mount(true);
    expect(latest).toEqual([]);
    const offline = fixture.invoke.mock.calls.length;
    await tick(20_000);
    expect(fixture.invoke).toHaveBeenCalledTimes(offline);
  });

  it("hides a stale entry on failure and backs off instead of retrying quickly", async () => {
    await mount();
    expect(latest).toHaveLength(1);
    failTabs = true;
    await tick(4000);
    expect(latest).toEqual([]);
    const failed = ops().filter((op) => op === "previewTabs").length;
    // 4 s -> 8 s -> 16 s: no retry in the next 7 s, one after 8 s.
    await tick(7000);
    expect(ops().filter((op) => op === "previewTabs")).toHaveLength(failed);
    await tick(1000);
    expect(ops().filter((op) => op === "previewTabs")).toHaveLength(failed + 1);
    await tick(15_000);
    expect(ops().filter((op) => op === "previewTabs")).toHaveLength(failed + 1);
    failTabs = false;
    await tick(1000);
    await tick(16_000);
    expect(latest).toHaveLength(1);
  });

  it("shows nothing and never lists when remote desktop is off", async () => {
    fixture.invoke.mockImplementation(async (_d, _c, [message]) =>
      message.op === "capabilities"
        ? { version: 1, enabled: false, previewTab: { version: 1, maxTouchPoints: 2 } }
        : { tabs: tabsReply },
    );
    await mount();
    await tick(8000);
    expect(latest).toEqual([]);
    expect(ops()).not.toContain("previewTabs");
  });
});
