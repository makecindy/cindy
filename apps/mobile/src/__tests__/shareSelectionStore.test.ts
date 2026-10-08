import { describe, expect, it } from "vitest";

import { isShareableMessage } from "@/session/shareSelectionStore";

describe("mobile share selection eligibility", () => {
  it("excludes legacy hook-source messages from share selection and export", () => {
    expect(isShareableMessage({ kind: "user" })).toBe(true);
    expect(
      isShareableMessage({ kind: "user", hookSource: { userTextContent: false } }),
    ).toBe(false);
    expect(
      isShareableMessage({ kind: "assistant", hookSource: { userTextContent: false } }),
    ).toBe(false);
  });

  it("keeps local IM rows (stored as clean user text) shareable like ordinary user messages", () => {
    expect(
      isShareableMessage({ kind: "user", hookSource: { userTextContent: true } }),
    ).toBe(true);
  });
});
