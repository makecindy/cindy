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
  it("keeps a well-formed tab ref and drops one that is not", () => {
    expect(
      parsePreviewTarget({ previewSession: "s1", previewRef: "tab_1-B" }),
    ).toEqual({ sessionId: "s1", ref: "tab_1-B" });
    for (const previewRef of ["", "a b", "x".repeat(65), 5, ["a"]])
      expect(
        parsePreviewTarget({ previewSession: "s1", previewRef }),
      ).toEqual({ sessionId: "s1" });
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
  describe("with the host's stable ref", () => {
    const withRef = { ...target, ref: "ref-a" };
    it("starts only the tab with that ref, whatever its title or position", () => {
      const mine = tab({ ref: "ref-a", title: "Renamed", grant: "m".repeat(43) });
      expect(
        pickPreviewTab(
          [tab({ ref: "ref-b" }), tab({ title: "No ref" }), mine],
          withRef,
        ),
      ).toBe(mine);
    });
    it("ends instead of taking another tab of the plugin once the ref is gone", () => {
      // The same plugin and title, but a rebuilt binding has a new ref.
      expect(pickPreviewTab([tab({ ref: "ref-b" })], withRef)).toBeUndefined();
      // Neither the only tab of the task nor one without a ref stands in.
      expect(pickPreviewTab([tab()], withRef)).toBeUndefined();
      expect(pickPreviewTab([], withRef)).toBeUndefined();
    });
    it("never borrows another task's tab, even with the same ref", () => {
      expect(
        pickPreviewTab([tab({ sessionId: "s2", ref: "ref-a" })], withRef),
      ).toBeUndefined();
    });
    it("ignores a tab whose ref is malformed", () => {
      expect(
        pickPreviewTab([tab({ ref: "bad ref!" })], { ...target, ref: "bad ref!" }),
      ).toBeUndefined();
      // Without a target ref, a malformed one is not an older host: it is skipped.
      expect(pickPreviewTab([tab({ ref: "bad ref!" })], target)).toBeUndefined();
    });
  });
  it("keeps the name-based match when the target has no ref (older computer)", () => {
    const old = tab({ title: "Loaded title" });
    expect(pickPreviewTab([old], target)).toBe(old);
    // A listing that has refs still matches by name for a target without one.
    const listed = tab({ ref: "ref-a" });
    expect(pickPreviewTab([listed], target)).toBe(listed);
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
