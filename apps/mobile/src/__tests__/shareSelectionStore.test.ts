import { describe, expect, it } from "vitest";

import {
  isShareableMessage,
  shareSelectionStore,
} from "@/session/shareSelectionStore";

describe("mobile share selection eligibility", () => {
  it("excludes legacy hook-source messages from share selection and export", () => {
    expect(isShareableMessage({ kind: "user" })).toBe(true);
    expect(
      isShareableMessage({
        kind: "user",
        hookSource: { userTextContent: false },
      }),
    ).toBe(false);
    expect(
      isShareableMessage({
        kind: "assistant",
        hookSource: { userTextContent: false },
      }),
    ).toBe(false);
  });

  it("keeps local IM rows (stored as clean user text) shareable like ordinary user messages", () => {
    expect(
      isShareableMessage({
        kind: "user",
        hookSource: { userTextContent: true },
      }),
    ).toBe(true);
  });
});

// tier: unit. System sharing may stay pending after handoff. Selection must
// disappear immediately; an opening error restores it without reviving an old
// task or overwriting a newer selection. Eligibility tests do not cover this.
it("closes selection at handoff and restores it only before newer user actions", () => {
  try {
    shareSelectionStore.enter("task-a", "first");
    shareSelectionStore.toggle("second");
    const restore = shareSelectionStore.exitForShare();
    expect(shareSelectionStore.isActive("task-a")).toBe(false);
    expect(shareSelectionStore.getSelectedIds()).toEqual([]);
    expect(restore()).toBe(true);
    expect(shareSelectionStore.isActive("task-a")).toBe(true);
    expect(shareSelectionStore.getSelectedIds()).toEqual(["first", "second"]);

    const staleRestore = shareSelectionStore.exitForShare();
    shareSelectionStore.enter("task-b", "new");
    expect(staleRestore()).toBe(false);
    expect(shareSelectionStore.getSelectedIds()).toEqual(["new"]);
    shareSelectionStore.exit();
    expect(staleRestore()).toBe(false);
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
  } finally {
    shareSelectionStore.exit();
  }
});
