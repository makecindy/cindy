import { describe, expect, it } from "vitest";
import type { PreviewTabSummary } from "@cindy/device-link";
import { parsePreviewTarget, pickPreviewTab } from "../previewTarget";

const tab = (
  over: Partial<PreviewTabSummary> & { grant?: string } = {},
): PreviewTabSummary => ({
  grant: "g".repeat(43),
  sessionId: "s1",
  pluginName: "Baguette",
  title: "Sim",
  ...over,
});

describe("preview target route params", () => {
  it("needs a task and ignores anything that is not a bounded string", () => {
    expect(parsePreviewTarget({})).toBeUndefined();
    expect(parsePreviewTarget({ previewSession: "" })).toBeUndefined();
    expect(parsePreviewTarget({ previewSession: ["a"] })).toBeUndefined();
    expect(parsePreviewTarget({ previewSession: "x".repeat(129) })).toBeUndefined();
    expect(
      parsePreviewTarget({
        previewSession: "s1",
        previewPlugin: 7,
        previewTitle: "x".repeat(201),
      }),
    ).toEqual({ sessionId: "s1" });
    expect(
      parsePreviewTarget({
        previewSession: "s1",
        previewPlugin: "Baguette",
        previewTitle: "Sim",
      }),
    ).toEqual({ sessionId: "s1", pluginName: "Baguette", title: "Sim" });
  });
});

describe("picking the listed preview tab", () => {
  const target = { sessionId: "s1", pluginName: "Baguette", title: "Sim" };
  it("prefers the exact tab, then the only tab of the task", () => {
    const exact = tab({ grant: "e".repeat(43) });
    expect(
      pickPreviewTab([tab({ title: "Other", grant: "o".repeat(43) }), exact], target),
    ).toBe(exact);
    const only = tab({ title: "Loaded title" });
    expect(pickPreviewTab([only, tab({ sessionId: "s2" })], target)).toBe(only);
  });
  it("tells several tabs apart by plugin and never borrows another task's", () => {
    const mine = tab({ title: "New", grant: "m".repeat(43) });
    expect(
      pickPreviewTab(
        [tab({ pluginName: "Maker", title: "Game" }), mine, tab({ title: "More" })],
        target,
      ),
    ).toBe(mine);
    expect(
      pickPreviewTab(
        [tab({ pluginName: "Maker" }), tab({ pluginName: "Other" })],
        target,
      ),
    ).toBeUndefined();
    expect(pickPreviewTab([tab({ sessionId: "s2" })], target)).toBeUndefined();
    expect(pickPreviewTab([], target)).toBeUndefined();
  });
});
