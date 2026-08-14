import { describe, expect, it } from "vitest";

import { isShareableMessage } from "@/session/shareSelectionStore";

describe("mobile share selection eligibility", () => {
  it("excludes hook-source messages from share selection and export", () => {
    expect(isShareableMessage({ kind: "user" })).toBe(true);
    expect(isShareableMessage({ kind: "user", hookSource: { im: "x" } })).toBe(
      false,
    );
    expect(
      isShareableMessage({ kind: "assistant", hookSource: { im: "slack" } }),
    ).toBe(false);
  });
});
