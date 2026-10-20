import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_POLL_MAX_MS,
  PREVIEW_POLL_MS,
  previewPollDelay,
  readPreviewTabs,
  samePreviewListing,
  type PreviewCapsMemo,
} from "../previewTabsQuery";

const grant = "g".repeat(43);
const caps = (over: object = {}) => ({
  version: 1,
  enabled: true,
  previewTab: { version: 1, maxTouchPoints: 2 },
  ...over,
});
const host = (capabilities: unknown, tabs: unknown[] = []) =>
  vi.fn(async (message: { op: string }) =>
    message.op === "capabilities" ? capabilities : { tabs },
  );
const listed = { grant, sessionId: "s1", pluginName: "Baguette", title: "Sim" };
const fresh = (): PreviewCapsMemo => ({ checked: false, supported: false });

describe("reading a task's preview tabs", () => {
  it("asks for capabilities once and then only lists tabs", async () => {
    const invoke = host(caps(), [listed]);
    const memo = fresh();
    await readPreviewTabs(invoke, "s1", memo);
    await readPreviewTabs(invoke, "s1", memo);
    expect(invoke.mock.calls.map(([message]) => message.op)).toEqual([
      "capabilities",
      "previewTabs",
      "previewTabs",
    ]);
    expect(invoke).toHaveBeenLastCalledWith({ op: "previewTabs", sessionId: "s1" });
  });
  it("passes the stable ref on and skips a tab whose ref is malformed", async () => {
    const invoke = host(caps(), [
      { ...listed, ref: "tab_1-B" },
      { ...listed, title: "Bad", ref: "bad ref!" },
      { ...listed, title: "Long", ref: "x".repeat(65) },
      { ...listed, title: "Number", ref: 5 },
    ]);
    expect(await readPreviewTabs(invoke, "s1", fresh())).toEqual([
      { sessionId: "s1", pluginName: "Baguette", title: "Sim", ref: "tab_1-B" },
    ]);
  });
  it("drops the grant and anything that is not this task's well-formed tab", async () => {
    const invoke = host(caps(), [
      listed,
      { ...listed, grant: "short" },
      { ...listed, sessionId: "s2" },
      { ...listed, title: 7 },
      null,
    ]);
    const tabs = await readPreviewTabs(invoke, "s1", fresh());
    expect(tabs).toEqual([
      { sessionId: "s1", pluginName: "Baguette", title: "Sim" },
    ]);
    expect(JSON.stringify(tabs)).not.toContain(grant);
  });
  it.each([
    ["an old computer", { version: 1, enabled: true }],
    ["remote desktop off", caps({ enabled: false })],
    ["a malformed capability", caps({ previewTab: { version: 2, maxTouchPoints: 2 } })],
  ])("lists nothing on %s and never asks for tabs", async (_name, capabilities) => {
    const invoke = host(capabilities, [listed]);
    expect(await readPreviewTabs(invoke, "s1", fresh())).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("lets a failed capabilities read be asked again", async () => {
    const memo = fresh();
    const failing = vi.fn(async () => {
      throw new Error("INVOKE_TIMEOUT");
    });
    await expect(readPreviewTabs(failing, "s1", memo)).rejects.toThrow();
    expect(memo.checked).toBe(false);
  });
  it("treats a reply without tabs as none", async () => {
    const invoke = vi.fn(async (message: { op: string }) =>
      message.op === "capabilities" ? caps() : {},
    );
    expect(await readPreviewTabs(invoke, "s1", fresh())).toEqual([]);
  });
});

describe("polling cadence and listing identity", () => {
  it("polls steadily and backs off exponentially up to a cap", () => {
    expect(previewPollDelay(0)).toBe(PREVIEW_POLL_MS);
    expect(previewPollDelay(1)).toBe(PREVIEW_POLL_MS * 2);
    expect(previewPollDelay(2)).toBe(PREVIEW_POLL_MS * 4);
    expect(previewPollDelay(20)).toBe(PREVIEW_POLL_MAX_MS);
    expect(PREVIEW_POLL_MS).toBeLessThanOrEqual(5000);
  });
  it("compares listings by what the user sees, not by fresh grants", () => {
    const a = [{ sessionId: "s1", pluginName: "P", title: "T" }];
    expect(samePreviewListing(a, [{ ...a[0] }])).toBe(true);
    expect(samePreviewListing(a, [{ ...a[0], title: "U" }])).toBe(false);
    expect(samePreviewListing(a, [])).toBe(false);
    // A rebuilt tab keeps its words but not its ref: that is a different entry.
    expect(samePreviewListing([{ ...a[0], ref: "r1" }], [{ ...a[0], ref: "r2" }])).toBe(false);
    expect(samePreviewListing([{ ...a[0], ref: "r1" }], [{ ...a[0], ref: "r1" }])).toBe(true);
  });
});
